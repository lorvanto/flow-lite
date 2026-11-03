import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { encrypt, decrypt } from '../lib/crypto.mjs';

export const now = () => new Date().toISOString();
export const terminal = (status) => ['success', 'failed', 'cancelled'].includes(status);

export function createStore(config) {
  const filename = path.join(config.dataDir, 'flow.sqlite');
  const db = new DatabaseSync(filename);
  fs.chmodSync(filename, 0o600);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, name TEXT NOT NULL, secret TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, config TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, current_release_id TEXT);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), number INTEGER NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL, snapshot TEXT NOT NULL,
      rollback_release_id TEXT, commit_sha TEXT, node_version TEXT, package_manager_version TEXT,
      artifact_path TEXT, release_path TEXT, error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      UNIQUE(project_id,number)
    );
    CREATE INDEX IF NOT EXISTS runs_queue ON runs(status,created_at);
    CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id,created_at);
  `);
  const setting = (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  };
  const setSetting = (key, value) =>
    db
      .prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  const decodeProject = (row) =>
    row
      ? {
          ...decrypt(row.config, config.masterKey),
          id: row.id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          currentReleaseId: row.current_release_id,
        }
      : null;
  const decodeRun = (row) =>
    row
      ? {
          id: row.id,
          projectId: row.project_id,
          number: row.number,
          kind: row.kind,
          status: row.status,
          stage: row.stage,
          rollbackReleaseId: row.rollback_release_id,
          commitSha: row.commit_sha,
          nodeVersion: row.node_version,
          packageManagerVersion: row.package_manager_version,
          artifactPath: row.artifact_path,
          releasePath: row.release_path,
          error: row.error,
          cancelRequested: Boolean(row.cancel_requested),
          createdAt: row.created_at,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          projectSnapshot: decrypt(row.snapshot, config.masterKey),
        }
      : null;
  const getProject = (id) => decodeProject(db.prepare('SELECT * FROM projects WHERE id=?').get(id));
  const getRun = (id) => decodeRun(db.prepare('SELECT * FROM runs WHERE id=?').get(id));
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return {
    db,
    setting,
    setSetting,
    transaction,
    getProject,
    getRun,
    close: () => db.close(),
    listProjects: () =>
      db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all().map(decodeProject),
    saveProject(model, id = randomUUID()) {
      const existing = getProject(id);
      const timestamp = now();
      db.prepare(
        'INSERT INTO projects(id,config,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,updated_at=excluded.updated_at',
      ).run(id, encrypt(model, config.masterKey), existing?.createdAt || timestamp, timestamp);
      return getProject(id);
    },
    deleteProject(id) {
      transaction(() => {
        db.prepare('DELETE FROM runs WHERE project_id=?').run(id);
        db.prepare('DELETE FROM projects WHERE id=?').run(id);
      });
    },
    listRuns(projectId, limit = 100) {
      return (
        projectId
          ? db
              .prepare(
                'SELECT * FROM runs WHERE project_id=? ORDER BY created_at DESC,number DESC LIMIT ?',
              )
              .all(projectId, limit)
          : db.prepare('SELECT * FROM runs ORDER BY created_at DESC,number DESC LIMIT ?').all(limit)
      ).map(decodeRun);
    },
    latestRun(projectId) {
      return decodeRun(
        db
          .prepare('SELECT * FROM runs WHERE project_id=? ORDER BY number DESC LIMIT 1')
          .get(projectId),
      );
    },
    hasActiveRuns(projectId) {
      return Boolean(
        db
          .prepare(
            "SELECT 1 FROM runs WHERE project_id=? AND status IN ('queued','running') LIMIT 1",
          )
          .get(projectId),
      );
    },
    enqueue(
      project,
      kind = project.type === 'command' ? 'command' : 'build',
      rollbackReleaseId = null,
    ) {
      return transaction(() => {
        const id = randomUUID();
        const number = db
          .prepare('SELECT COALESCE(MAX(number),0)+1 AS number FROM runs WHERE project_id=?')
          .get(project.id).number;
        db.prepare(
          'INSERT INTO runs(id,project_id,number,kind,status,stage,snapshot,rollback_release_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          project.id,
          number,
          kind,
          'queued',
          'queued',
          encrypt(project, config.masterKey),
          rollbackReleaseId,
          now(),
        );
        return getRun(id);
      });
    },
    updateRun(id, changes) {
      const mapping = {
        status: 'status',
        stage: 'stage',
        commitSha: 'commit_sha',
        nodeVersion: 'node_version',
        packageManagerVersion: 'package_manager_version',
        artifactPath: 'artifact_path',
        releasePath: 'release_path',
        error: 'error',
        cancelRequested: 'cancel_requested',
        startedAt: 'started_at',
        finishedAt: 'finished_at',
      };
      const pairs = Object.entries(changes).filter(([key]) => mapping[key]);
      if (pairs.length)
        db.prepare(
          `UPDATE runs SET ${pairs.map(([key]) => `${mapping[key]}=?`).join(',')} WHERE id=?`,
        ).run(
          ...pairs.map(([, value]) =>
            typeof value === 'boolean' ? Number(value) : (value ?? null),
          ),
          id,
        );
      return getRun(id);
    },
    requestCancelRun(id) {
      return transaction(() => {
        const run = getRun(id);
        if (!run) return null;
        if (terminal(run.status)) return { accepted: false, run };
        if (run.status === 'queued') {
          db.prepare(
            "UPDATE runs SET cancel_requested=1,status='cancelled',finished_at=?,error='已取消排队' WHERE id=?",
          ).run(now(), id);
        } else db.prepare('UPDATE runs SET cancel_requested=1 WHERE id=?').run(id);
        return { accepted: true, run: getRun(id) };
      });
    },
    setCurrentRelease(projectId, releaseId) {
      db.prepare('UPDATE projects SET current_release_id=? WHERE id=?').run(releaseId, projectId);
    },
    acquireWorker(owner) {
      return transaction(() => {
        const previous = setting('worker');
        if (
          previous &&
          Date.now() - Date.parse(previous.lastSeen) < 30000 &&
          previous.owner !== owner
        )
          return false;
        setSetting('worker', { owner, lastSeen: now(), pid: process.pid });
        return true;
      });
    },
    heartbeat(owner) {
      return transaction(() => {
        if (setting('worker')?.owner !== owner) return false;
        setSetting('worker', { owner, lastSeen: now(), pid: process.pid });
        return true;
      });
    },
    releaseWorker(owner) {
      if (setting('worker')?.owner === owner) setSetting('worker', null);
    },
    recoverRuns() {
      const interrupted = db.prepare("SELECT id FROM runs WHERE status='running'").all();
      db.prepare(
        "UPDATE runs SET status='failed',error='执行器重启，任务已中断；请检查发布目录后重试',finished_at=? WHERE status='running'",
      ).run(now());
      return interrupted;
    },
    claimNextRun(owner, { allowBuilds = true } = {}) {
      return transaction(() => {
        if (setting('worker')?.owner !== owner) return null;
        const row = db
          .prepare(
            `SELECT id FROM runs WHERE status='queued' ${allowBuilds ? '' : "AND kind != 'build'"} ORDER BY created_at,rowid LIMIT 1`,
          )
          .get();
        if (!row) return null;
        db.prepare(
          "UPDATE runs SET status='running',started_at=? WHERE id=? AND status='queued'",
        ).run(now(), row.id);
        return getRun(row.id);
      });
    },
    listCredentials() {
      return db
        .prepare('SELECT id,name,created_at FROM credentials ORDER BY created_at DESC')
        .all()
        .map((row) => {
          const secret = decrypt(
            db.prepare('SELECT secret FROM credentials WHERE id=?').get(row.id).secret,
            config.masterKey,
          );
          const type = secret.type || 'ssh';
          return {
            id: row.id,
            name: row.name,
            type,
            authType: secret.authType || (type === 'git-https' ? 'password' : 'key'),
            createdAt: row.created_at,
            hasKnownHosts: type === 'ssh' && Boolean(secret.knownHosts),
          };
        });
    },
    getCredential(id) {
      const row = db.prepare('SELECT * FROM credentials WHERE id=?').get(id);
      if (!row) return null;
      const secret = decrypt(row.secret, config.masterKey);
      return {
        id: row.id,
        name: row.name,
        ...secret,
        type: secret.type || 'ssh',
        authType: secret.authType || (secret.type === 'git-https' ? 'password' : 'key'),
        createdAt: row.created_at,
      };
    },
    saveCredential(model) {
      const id = randomUUID();
      const type = model.type || 'ssh';
      const authType = model.authType || (type === 'git-https' ? 'password' : 'key');
      const secret =
        type === 'git-https'
          ? { type, authType, username: model.username, password: model.password }
          : {
              type,
              authType,
              knownHosts: model.knownHosts || '',
              ...(authType === 'password'
                ? { password: model.password }
                : { privateKey: model.privateKey }),
            };
      db.prepare('INSERT INTO credentials(id,name,secret,created_at) VALUES(?,?,?,?)').run(
        id,
        model.name,
        encrypt(secret, config.masterKey),
        now(),
      );
      return this.listCredentials().find((item) => item.id === id);
    },
    deleteCredential(id) {
      db.prepare('DELETE FROM credentials WHERE id=?').run(id);
    },
  };
}
