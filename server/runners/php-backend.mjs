import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { runProcess, checkAbort } from '../lib/process.mjs';
import { prepareSshAuth } from './ssh-auth.mjs';

const APPLICATIONS = new Set(
  'baking campsite coffee course evse flower manhe milktea studyroom tattoo venue vipcard yanxi yshop yshopbbc'.split(
    ' ',
  ),
);
const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/;
const HASH = /^[a-f\d]{64}$/;
const COMMIT = /^[a-f\d]{40}$/;
const BASE = '/data/httpd/www/demo.yunyingbao.net';
const HELPER = `${BASE}/ops/flow-unified/php-release.py`;
const IMAGE = 'public.ecr.aws/docker/library/php:8.5-cli-bookworm';
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_GIT_BUNDLE = 512 * 1024 * 1024;
const GIT_BUNDLE_REF = 'refs/heads/flow-release';
const MAX_FILE = 32 * 1024 * 1024;
const REQUIRED = ['public/index.php', 'vendor/autoload.php', 'composer.json', 'composer.lock'];
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, rollbackConfirmed) => {
  const error = new Error(`PHP backend: ${code}`);
  error.code = `php_backend_${code}`;
  if (rollbackConfirmed === true) error.rollbackConfirmed = true;
  throw error;
};
const environment = () => ({
  PATH: process.env.PATH || '/usr/bin:/bin',
  HOME: process.env.HOME || '/tmp',
  LANG: 'C.UTF-8',
});
const gitEnvironment = () => ({
  ...environment(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: '',
  GIT_OPTIONAL_LOCKS: '0',
});
const gitArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const sourceSnapshots = new WeakMap();

export function backendEnabled(project) {
  return project?.backend?.enabled === true;
}

function safePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 240 &&
    !/[\x00-\x1f\x7f\\]/.test(value) &&
    !value.startsWith('/') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}

/** Paths are API-relative. Omitted secrets/data are never read from Git blobs. */
export function includePhpSource(value) {
  if (!safePath(value)) return false;
  const parts = value.split('/');
  const lower = parts.map((part) => part.toLowerCase());
  if (parts.some((part) => part.startsWith('.'))) return false;
  if (lower.some((part) => part.endsWith('.env'))) return false;
  if (/\.(?:sql|pem|key|p12|pfx|crt|sqlite3?|db|log)(?:\.|$)/i.test(value)) return false;
  if (
    lower.some((part) => /^(?:db\.env|auth\.json|credentials\.json|id_rsa|id_ed25519)$/.test(part))
  )
    return false;
  if (
    /\.(?:sql(?:\.(?:gz|zip|bz2))?|pem|key|p12|pfx|crt|sqlite3?|db|log|bak|orig|rej|tar|tgz|zip|7z)$/i.test(
      value,
    )
  )
    return false;
  if (
    /^(?:runtime|tmp|session|sessions|uploads|qrcode|tests?|docs?|examples?|samples?|logs?|cache|storage|backups?)(?:\/|$)/i.test(
      value,
    )
  )
    return false;
  if (
    /^public\/(?:uploads|qrcode|h5|admin|pc|shop)(?:\/|$)/i.test(value) ||
    /^public\/static\/(?:admin|install)(?:\/|$)/i.test(value)
  )
    return false;
  if (/^app\/install(?:\/|$)/i.test(value)) return false;
  if (
    lower[0] === 'vendor' &&
    lower.slice(3).some((part) => /^(?:tests?|docs?|examples?|samples?)$/.test(part))
  )
    return false;
  return true;
}

function isOfficialRepository(url, application) {
  return ['http', 'https'].some(
    (protocol) => url === `${protocol}://git.yin-duo.com/mini-program/${application}.git`,
  );
}

function contextModel(context) {
  const { project, run, config } = context;
  if (
    !UUID.test(project?.id || '') ||
    !UUID.test(run?.id || '') ||
    (run.projectId && run.projectId !== project.id) ||
    !path.isAbsolute(config?.dataDir || '')
  )
    fail('invalid_context');
  const b = project.backend;
  if (
    !b ||
    b.enabled !== true ||
    b.type !== 'php' ||
    b.workdir !== 'api' ||
    b.phpVersion !== '8.5' ||
    !APPLICATIONS.has(b.application)
  )
    fail('invalid_backend');
  const source = project.sources?.find((item) => item.id === b.sourceId);
  if (
    !source ||
    !isOfficialRepository(source.repoUrl, b.application) ||
    !project.tasks?.length ||
    project.tasks.some((task) => task.sourceId !== b.sourceId)
  )
    fail('source_scope_mismatch');
  const target = project.deploy;
  if (
    target?.type !== 'ssh' ||
    target.host !== '47.118.69.157' ||
    target.user !== 'root' ||
    Number(target.port || 22) !== 22 ||
    target.root !== `${BASE}/frontend-deploy/${b.application}`
  )
    fail('target_scope_mismatch');
  return { application: b.application, source, target };
}

async function binaryGit(cwd, args, input, limit, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...gitArgs, ...args], {
      cwd,
      env: gitEnvironment(),
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    let bytes = 0;
    let error;
    let timer;
    const kill = () => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const abort = () => {
      error ??= new Error('PHP backend: git_cancelled');
      kill();
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        error ??= new Error('PHP backend: git_output_limit');
        kill();
      } else chunks.push(chunk);
    });
    child.stderr.on('data', () => {});
    child.on('error', () => {
      error ??= new Error('PHP backend: git_failed');
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    timer = setTimeout(() => {
      error ??= new Error('PHP backend: git_timeout');
      kill();
    }, 60000);
    timer.unref();
    if (signal?.aborted) abort();
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error || code !== 0) reject(error || new Error('PHP backend: git_failed'));
      else resolve(Buffer.concat(chunks));
    });
  });
}

function version(text) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) fail('unsupported_php_constraint');
  return [+m[1], +m[2], +(m[3] || 0)];
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
/** Deliberately restricted Composer constraints: unknown syntax fails closed. */
export function phpConstraintAllows(constraint, actual = '8.5.0') {
  if (typeof constraint !== 'string' || constraint.length > 200) return false;
  try {
    const v = actual === null ? null : version(actual);
    if (v && (v[0] !== 8 || v[1] !== 5)) return false;
    let matches = false;
    for (const branch of constraint.split('||')) {
      let low = [0, 0, 0],
        high = null,
        lowOpen = false,
        highOpen = false;
      const setLow = (n, open) => {
        if (compare(n, low) > 0) {
          low = n;
          lowOpen = open;
        } else if (compare(n, low) === 0) lowOpen ||= open;
      };
      const setHigh = (n, open) => {
        if (!high || compare(n, high) < 0) {
          high = n;
          highOpen = open;
        } else if (compare(n, high) === 0) highOpen ||= open;
      };
      const raw = branch.trim();
      const simple = /^([~^]?)(8\.\d+(?:\.\d+)?)(\.\*)?$/.exec(raw);
      if (simple) {
        if (simple[3] && (simple[1] || simple[2].split('.').length !== 2)) return false;
        low = version(simple[2]);
        if (simple[1] === '^') {
          high = [9, 0, 0];
          highOpen = true;
        } else if (simple[1] === '~' || simple[3]) {
          high =
            simple[1] === '~' && simple[2].split('.').length === 2 ? [9, 0, 0] : [8, low[1] + 1, 0];
          highOpen = true;
        } else high = low;
      } else {
        const tokens = raw.split(/\s*,?\s+/).filter(Boolean);
        if (!tokens.length) return false;
        for (const token of tokens) {
          const m = /^(>=|>|<=|<|=)?(\d+(?:\.\d+){0,2})$/.exec(token);
          if (!m) return false;
          const n = version(m[2].includes('.') ? m[2] : `${m[2]}.0`);
          if (m[1] === '>' || m[1] === '>=') setLow(n, m[1] === '>');
          else if (m[1] === '<' || m[1] === '<=') setHigh(n, m[1] === '<');
          else {
            setLow(n, false);
            setHigh(n, false);
          }
        }
      }
      if (low[0] !== 8 || compare(low, [8, 0, 0]) < 0 || (high && compare(high, low) < 0))
        return false;
      // null asks only whether a valid 8.5 patch exists; the container version is
      // checked separately. Do not guess availability using arbitrary patch numbers.
      const candidate = v || (compare(low, [8, 5, 0]) > 0 ? [...low] : [8, 5, 0]);
      if (!v && lowOpen && compare(candidate, low) === 0) candidate[2]++;
      if (
        candidate[0] === 8 &&
        candidate[1] === 5 &&
        compare(candidate, low) >= (lowOpen ? 1 : 0) &&
        (!high || compare(candidate, high) <= (highOpen ? -1 : 0))
      )
        matches = true;
    }
    return matches;
  } catch {
    return false;
  }
}

function composerConstraints(entries) {
  let composer, lock;
  try {
    composer = JSON.parse(
      entries.find((entry) => entry.path === 'composer.json').data.toString('utf8'),
    );
    lock = JSON.parse(
      entries.find((entry) => entry.path === 'composer.lock').data.toString('utf8'),
    );
  } catch {
    fail('composer_metadata_invalid');
  }
  const constraints = [composer?.require?.php];
  if (lock?.platform?.php !== undefined) constraints.push(lock.platform.php);
  if (!constraints.every((value) => phpConstraintAllows(value, null)))
    fail('php_85_constraint_required');
  return constraints;
}

export async function readPhpGitSource(sourceDir, sourceCommit, signal) {
  if (
    !COMMIT.test(sourceCommit || '') ||
    !path.isAbsolute(sourceDir || '') ||
    (await fs.realpath(sourceDir)) !== path.resolve(sourceDir)
  )
    fail('invalid_source');
  const head = (await binaryGit(sourceDir, ['rev-parse', 'HEAD'], null, 128, signal))
    .toString('ascii')
    .trim();
  if (head !== sourceCommit) fail('source_commit_changed');
  const tree = await binaryGit(
    sourceDir,
    ['ls-tree', '-rlz', '--full-tree', sourceCommit, '--', 'api'],
    null,
    8 * 1024 * 1024,
    signal,
  );
  if (!Buffer.from(tree.toString('utf8'), 'utf8').equals(tree)) fail('non_utf8_source_path');
  const selected = [];
  let total = 0;
  for (const raw of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (\w+) ([a-f\d]{40})\s+(-|\d+)\t([\s\S]+)$/.exec(raw);
    if (!match || !match[5].startsWith('api/')) fail('invalid_git_tree');
    const relative = match[5].slice(4);
    if (!includePhpSource(relative)) continue;
    if (!['100644', '100755'].includes(match[1]) || match[2] !== 'blob' || !/^\d+$/.test(match[4]))
      fail('non_regular_php_source');
    const size = Number(match[4]);
    total += size;
    if (size > MAX_FILE || total > MAX_BYTES || selected.length >= 20000) fail('source_size_limit');
    selected.push({ path: relative, oid: match[3], size });
  }
  selected.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (!REQUIRED.every((name) => selected.some((entry) => entry.path === name)))
    fail('required_php_source_missing');
  const raw = await binaryGit(
    sourceDir,
    ['cat-file', '--batch'],
    selected.map((entry) => `${entry.oid}\n`).join(''),
    total + selected.length * 100,
    signal,
  );
  let offset = 0;
  const entries = selected.map((entry) => {
    const end = raw.indexOf(10, offset);
    if (end < 0) fail('git_blob_invalid');
    const header = raw.subarray(offset, end).toString('ascii');
    if (header !== `${entry.oid} blob ${entry.size}`) fail('git_blob_invalid');
    offset = end + 1;
    const data = raw.subarray(offset, offset + entry.size);
    offset += entry.size;
    if (data.length !== entry.size || raw[offset++] !== 10) fail('git_blob_invalid');
    return { path: entry.path, data };
  });
  if (offset !== raw.length) fail('git_blob_trailing_data');
  return { entries, constraints: composerConstraints(entries) };
}

async function createGitBundle(context, sourceDir, sourceCommit, repositoryUrl) {
  const dir = await fs.mkdtemp(path.join(context.tempDir, 'git-release-'));
  const filename = path.join(dir, 'source.bundle');
  const repo = path.join(dir, 'transport.git');
  const env = gitEnvironment();
  const { signal } = context;
  const git = (args, cwd = dir, overrides = {}) =>
    runProcess('git', [...gitArgs, ...args], {
      cwd,
      env: { ...env, ...overrides },
      signal,
      captureLimit: 4096,
    });
  try {
    const shallow = await git(['rev-parse', '--is-shallow-repository'], sourceDir);
    if (shallow.stdout.trim() !== 'false') fail('git_history_incomplete');
    await git(['init', '--bare', '--template=', repo]);
    const objects = { GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(sourceDir, '.git', 'objects') };
    await git(['update-ref', GIT_BUNDLE_REF, sourceCommit], repo, objects);
    await git(['bundle', 'create', '--version=2', filename, GIT_BUNDLE_REF], repo, objects);
    const heads = await git(['bundle', 'list-heads', filename], repo);
    if (heads.stdout.trim() !== `${sourceCommit} ${GIT_BUNDLE_REF}`) fail('git_bundle_ref_invalid');
    await fs.chmod(filename, 0o600);
    const state = await fs.lstat(filename);
    if (!state.isFile() || !state.size || state.size > MAX_GIT_BUNDLE)
      fail('git_bundle_size_limit');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename, { signal })) hash.update(chunk);
    await fs.rm(repo, { recursive: true });
    return {
      filename,
      metadata: { repositoryUrl, gitBundleBytes: state.size, gitBundleSha256: hash.digest('hex') },
    };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    checkAbort(signal);
    throw error;
  }
}

/** Capture outside the writable checkout before any repository/npm script runs. */
export async function capturePhpBackendSource(context, { sourceDir, sourceCommit, gitWorktree }) {
  const { application, source: repository } = contextModel(context);
  const source = await readPhpGitSource(sourceDir, sourceCommit, context.signal);
  const gitBundle = gitWorktree
    ? await createGitBundle(context, sourceDir, sourceCommit, repository.repoUrl)
    : null;
  const token = Object.freeze({ sourceCommit });
  sourceSnapshots.set(token, {
    source,
    gitBundle,
    sourceDir,
    sourceCommit,
    projectId: context.project.id,
    release: context.run.id,
    application,
  });
  return token;
}

export function phpFileManifest(entries) {
  return [...entries]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map((entry) => ({
      path: entry.path,
      sha256: sha(entry.data),
      bytes: entry.data.length,
      mode: 420,
    }));
}

function octal(value, width) {
  const text = value.toString(8);
  if (text.length >= width) fail('tar_number_limit');
  return `${text.padStart(width - 1, '0')}\0`;
}
export function createPhpTar(entries) {
  const chunks = [];
  const seen = new Set();
  for (const entry of [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  )) {
    if (
      !includePhpSource(entry.path) ||
      seen.has(entry.path) ||
      !Buffer.isBuffer(entry.data) ||
      entry.data.length > MAX_FILE
    )
      fail('invalid_archive_entry');
    seen.add(entry.path);
    let name = entry.path,
      prefix = '';
    if (Buffer.byteLength(name) > 100) {
      let split = name.lastIndexOf('/');
      while (
        split >= 0 &&
        (Buffer.byteLength(name.slice(0, split)) > 155 ||
          Buffer.byteLength(name.slice(split + 1)) > 100)
      )
        split = name.lastIndexOf('/', split - 1);
      if (split < 0) fail('tar_path_limit');
      prefix = name.slice(0, split);
      name = name.slice(split + 1);
    }
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write(octal(420, 8), 100, 8, 'ascii');
    header.write(octal(0, 8), 108, 8, 'ascii');
    header.write(octal(0, 8), 116, 8, 'ascii');
    header.write(octal(entry.data.length, 12), 124, 12, 'ascii');
    header.write(octal(0, 12), 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write(prefix, 345, 155, 'utf8');
    header.write(
      `${[...header]
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0')}\0 `,
      148,
      8,
      'ascii',
    );
    chunks.push(header, entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

export function validatePhpTar(archive, files) {
  if (
    !Buffer.isBuffer(archive) ||
    archive.length > MAX_BYTES + 20000 * 1024 ||
    archive.length % 512 ||
    !Array.isArray(files) ||
    files.length > 20000
  )
    fail('invalid_archive');
  let offset = 0,
    index = 0;
  const text = (header, start, length) =>
    header
      .subarray(start, start + length)
      .toString('utf8')
      .split('\0')[0];
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        archive.length - offset < 1024 ||
        !archive.subarray(offset).every((byte) => byte === 0) ||
        index !== files.length
      )
        fail('invalid_tar_end');
      return true;
    }
    const checksum = parseInt(text(header, 148, 8).trim(), 8);
    const copy = Buffer.from(header);
    copy.fill(32, 148, 156);
    if (
      checksum !== [...copy].reduce((sum, byte) => sum + byte, 0) ||
      header[156] !== 48 ||
      text(header, 257, 6) !== 'ustar' ||
      text(header, 157, 100)
    )
      fail('invalid_tar_header');
    const prefix = text(header, 345, 155),
      name = `${prefix ? `${prefix}/` : ''}${text(header, 0, 100)}`;
    const file = files[index++];
    const size = parseInt(text(header, 124, 12), 8);
    if (
      !file ||
      !includePhpSource(name) ||
      file.path !== name ||
      file.mode !== 420 ||
      size !== file.bytes ||
      parseInt(text(header, 100, 8), 8) !== 420 ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_FILE
    )
      fail('archive_manifest_mismatch');
    offset += 512;
    if (
      offset + size > archive.length ||
      sha(archive.subarray(offset, offset + size)) !== file.sha256
    )
      fail('archive_hash_mismatch');
    const padded = Math.ceil(size / 512) * 512;
    if (!archive.subarray(offset + size, offset + padded).every((byte) => byte === 0))
      fail('invalid_tar_padding');
    offset += padded;
  }
  fail('invalid_tar_end');
}

export const PHP_LINT_SCRIPT = String.raw`if (PHP_MAJOR_VERSION!==8 || PHP_MINOR_VERSION!==5) exit(10); $files=explode("\0",file_get_contents('/lint-files')); $count=0; foreach($files as $file) { if($file==='')continue; if(!str_starts_with($file,'/src/')||str_contains($file,"\n"))exit(11); $p=proc_open([PHP_BINARY,'-n','-d','display_errors=stderr','-d','log_errors=0','-d','error_reporting=-1','-l',$file],[0=>['file','/dev/null','r'],1=>['file','/tmp/lint.out','w'],2=>['file','/tmp/lint.err','w']],$pipes); if(!is_resource($p))exit(12); $code=proc_close($p); clearstatcache(); if($code!==0||filesize('/tmp/lint.err')!==0||filesize('/tmp/lint.out')>65536)exit(13); $out=file_get_contents('/tmp/lint.out'); if(trim($out)!=='No syntax errors detected in '.$file)exit(14); $count++; } echo json_encode(['phpVersion'=>PHP_VERSION,'phpFiles'=>$count]);`;

export async function lintPhpSource(context, source, execute = runProcess) {
  if (!path.isAbsolute(context.tempDir || '') || /[,\r\n]/.test(context.tempDir))
    fail('invalid_temp_directory');
  const stage = await fs.mkdtemp(path.join(context.tempDir, 'php-lint-'));
  await fs.chmod(stage, 0o700);
  const sourceRoot = path.join(stage, 'api');
  await fs.mkdir(sourceRoot, { mode: 0o700 });
  const lintFiles = [];
  const name = `flow-php-${randomUUID()}`;
  try {
    for (const entry of source.entries) {
      const dest = path.join(sourceRoot, entry.path);
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fs.writeFile(dest, entry.data, { mode: 0o600, flag: 'wx' });
      // ThinkPHP's make/stubs/*.stub files contain unexpanded generator tokens.
      if (
        !/\.stub$/i.test(entry.path) &&
        !/^vendor\/phpunit\/phpunit\/.*\.tpl$/.test(entry.path) &&
        (/\.(?:php|phtml)$/i.test(entry.path) ||
          /^#![^\n]*php|^\s*<\?php/.test(entry.data.subarray(0, 128).toString('ascii')))
      )
        lintFiles.push(`/src/${entry.path}`);
    }
    const list = path.join(stage, 'files');
    await fs.writeFile(list, `${lintFiles.join('\0')}\0`, { mode: 0o600, flag: 'wx' });
    const uid = process.getuid?.() || 0,
      gid = process.getgid?.() || 0;
    const args = [
      'run',
      '--rm',
      '--name',
      name,
      '--label',
      `com.flow-lite.instance=${sha(path.resolve(context.config.dataDir)).slice(0, 24)}`,
      '--label',
      `com.flow-lite.run=${context.run.id}`,
      '--init',
      '--user',
      `${uid}:${gid}`,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      '128',
      '--memory',
      '1g',
      '--cpus',
      '2',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--mount',
      `type=bind,src=${sourceRoot},dst=/src,readonly`,
      '--mount',
      `type=bind,src=${list},dst=/lint-files,readonly`,
      IMAGE,
      'php',
      '-n',
      '-r',
      PHP_LINT_SCRIPT,
    ];
    let response;
    try {
      response = await execute('docker', args, {
        env: environment(),
        signal: context.signal,
        captureLimit: 65536,
      });
    } catch {
      fail('php85_lint_failed');
    }
    let result;
    try {
      result = JSON.parse(response.stdout);
    } catch {
      fail('php85_lint_invalid_result');
    }
    if (
      response.stderr ||
      !/^8\.5\.\d+$/.test(result.phpVersion || '') ||
      result.phpFiles !== lintFiles.length ||
      !source.constraints.every((constraint) => phpConstraintAllows(constraint, result.phpVersion))
    )
      fail('php85_lint_invalid_result');
    return { phpVersion: result.phpVersion, phpFiles: result.phpFiles };
  } finally {
    try {
      await execute('docker', ['rm', '-f', name], {
        env: environment(),
        signal: AbortSignal.timeout(15000),
        captureLimit: 4096,
      });
    } catch {}
    await fs.rm(stage, { recursive: true, force: true });
  }
}

async function privateDirectory(dirname) {
  const full = path.resolve(dirname);
  let current = path.parse(full).root;
  for (const part of full.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('private_path_not_directory');
  }
  await fs.chmod(full, 0o700);
  return full;
}

function artifactDir(context, release) {
  if (!UUID.test(release || '')) fail('invalid_release');
  return path.join(context.config.dataDir, 'backend-artifacts', context.project.id, release);
}
function handleFor(context, metadata, phpVersion) {
  return {
    schemaVersion: 1,
    kind: 'flow-php-backend-handle',
    projectId: context.project.id,
    application: metadata.application,
    release: metadata.release,
    sourceCommit: metadata.sourceCommit,
    apiTreeSha256: metadata.apiTreeSha256,
    archiveSha256: metadata.archiveSha256,
    archiveBytes: metadata.archiveBytes,
    phpVersion,
  };
}

async function readPrivate(filename, max) {
  const stat = await fs.lstat(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.mode & 0o077 ||
    stat.size > max
  )
    fail('private_artifact_invalid');
  return fs.readFile(filename);
}

export async function loadPhpBackendHandle(context, release) {
  const { application } = contextModel(context);
  const dir = artifactDir(context, release);
  let record, archive;
  try {
    if ((await fs.realpath(dir)) !== path.resolve(dir)) fail('private_artifact_invalid');
    record = JSON.parse(
      (await readPrivate(path.join(dir, 'metadata.json'), 8 * 1024 * 1024)).toString('utf8'),
    );
    archive = await readPrivate(path.join(dir, 'source.tar'), MAX_ARCHIVE);
  } catch {
    fail('backend_release_metadata_missing_or_invalid');
  }
  const m = record.metadata;
  if (
    record.schemaVersion !== 1 ||
    record.projectId !== context.project.id ||
    !/^8\.5\.\d+$/.test(record.phpVersion || '') ||
    ![1, 2].includes(m?.schemaVersion) ||
    (m.schemaVersion === 2 &&
      (!isOfficialRepository(m.repositoryUrl, application) ||
        !HASH.test(m.gitBundleSha256 || '') ||
        !Number.isSafeInteger(m.gitBundleBytes) ||
        m.gitBundleBytes < 1 ||
        m.gitBundleBytes > MAX_GIT_BUNDLE)) ||
    m.kind !== 'flow-php-backend-release' ||
    m.application !== application ||
    m.release !== release ||
    !COMMIT.test(m.sourceCommit || '') ||
    !HASH.test(m.apiTreeSha256 || '') ||
    m.apiTreeSha256 !== sha(JSON.stringify(m.files)) ||
    m.archiveBytes !== archive.length ||
    m.archiveSha256 !== sha(archive)
  )
    fail('backend_release_metadata_invalid');
  validatePhpTar(archive, m.files);
  return handleFor(context, m, record.phpVersion);
}

async function checkedHandle(context, handle) {
  const loaded = await loadPhpBackendHandle(context, handle?.release);
  if (JSON.stringify(loaded) !== JSON.stringify(handle)) fail('backend_handle_changed');
  return loaded;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
async function remote(context, handle, action, input, execute = runProcess) {
  const { target } = contextModel(context);
  if (!['prepare', 'activate', 'rollback', 'status'].includes(action))
    fail('invalid_remote_action');
  const credential = context.credentials?.[target.credentialId];
  if (!credential || credential.type !== 'ssh') fail('ssh_credential_required');
  const authDir = await fs.mkdtemp(path.join(context.tempDir, 'php-ssh-'));
  await fs.chmod(authDir, 0o700);
  try {
    const auth = await prepareSshAuth({
      credential,
      tempDir: authDir,
      prefix: 'backend',
      env: environment(),
    });
    const command = [
      'python3',
      HELPER,
      action,
      '--application',
      handle.application,
      '--release',
      handle.release,
      ...(action === 'status' ? [] : ['--apply']),
    ]
      .map(quote)
      .join(' ');
    let result;
    try {
      result = await execute(
        'ssh',
        [...auth.args, '-p', '22', '--', 'root@47.118.69.157', command],
        { env: auth.env, signal: context.signal, input, captureLimit: 65536 },
      );
    } catch (error) {
      let confirmed = false;
      try {
        const value = JSON.parse(
          typeof error.stdout === 'string' && error.stdout.length <= 65536 ? error.stdout : 'null',
        );
        confirmed =
          value?.schemaVersion === 1 &&
          value.state === 'refused' &&
          value.application === handle.application &&
          value.release === handle.release &&
          value.sourceCommit === handle.sourceCommit &&
          value.archiveSha256 === handle.archiveSha256 &&
          value.rollbackConfirmed === true;
      } catch {}
      fail(`remote_${action}_failed`, confirmed);
    }
    let value;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      fail('remote_response_invalid');
    }
    const expectedState = {
      prepare: 'prepared',
      activate: 'activated',
      rollback: 'rolled_back',
      status: 'status',
    }[action];
    if (
      result.stderr ||
      value.schemaVersion !== 1 ||
      value.application !== handle.application ||
      value.release !== handle.release ||
      value.state !== expectedState ||
      value.sourceCommit !== handle.sourceCommit ||
      value.archiveSha256 !== handle.archiveSha256
    )
      fail('remote_response_mismatch');
    const projected = {
      schemaVersion: 1,
      application: value.application,
      release: value.release,
      state: value.state,
      sourceCommit: value.sourceCommit,
      archiveSha256: value.archiveSha256,
    };
    if (value.rollbackConfirmed === true) projected.rollbackConfirmed = true;
    if (action === 'status') {
      if (value.currentManagedRelease !== null && !UUID.test(value.currentManagedRelease || ''))
        fail('remote_response_mismatch');
      projected.currentManagedRelease = value.currentManagedRelease;
    }
    return projected;
  } finally {
    if (input?.destroy) input.destroy();
    await fs.rm(authDir, { recursive: true, force: true });
  }
}

/** Dependency injection is for protocol fixtures; callers normally omit the third argument. */
export async function preparePhpBackend(
  context,
  { sourceDir, sourceCommit, snapshot },
  dependencies = {},
) {
  const { application } = contextModel(context);
  checkAbort(context.signal);
  let source;
  let gitBundle;
  if (snapshot !== undefined) {
    const captured = sourceSnapshots.get(snapshot);
    if (
      !captured ||
      captured.sourceDir !== sourceDir ||
      captured.sourceCommit !== sourceCommit ||
      captured.projectId !== context.project.id ||
      captured.release !== context.run.id ||
      captured.application !== application
    )
      fail('source_snapshot_mismatch');
    source = captured.source;
    gitBundle = captured.gitBundle;
  } else source = await readPhpGitSource(sourceDir, sourceCommit, context.signal);
  const lint = await lintPhpSource(context, source, dependencies.execute || runProcess);
  const files = phpFileManifest(source.entries),
    archive = createPhpTar(source.entries);
  if (archive.length > MAX_ARCHIVE) fail('archive_size_limit');
  validatePhpTar(archive, files);
  const metadata = {
    schemaVersion: gitBundle ? 2 : 1,
    kind: 'flow-php-backend-release',
    application,
    release: context.run.id,
    sourceCommit,
    apiTreeSha256: sha(JSON.stringify(files)),
    archiveSha256: sha(archive),
    archiveBytes: archive.length,
    files,
    ...gitBundle?.metadata,
  };
  const dir = artifactDir(context, context.run.id);
  await privateDirectory(path.dirname(dir));
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch {
    fail('backend_release_already_exists');
  }
  await fs.writeFile(path.join(dir, 'source.tar'), archive, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(
    path.join(dir, 'metadata.json'),
    JSON.stringify({
      schemaVersion: 1,
      projectId: context.project.id,
      phpVersion: lint.phpVersion,
      metadata,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  const handle = handleFor(context, metadata, lint.phpVersion);
  const json = Buffer.from(JSON.stringify(metadata));
  const header = Buffer.alloc(12);
  header.write(gitBundle ? 'FPHP8502' : 'FPHP8501', 0, 8, 'ascii');
  header.writeUInt32BE(json.length, 8);
  const input = Readable.from(
    (async function* () {
      yield header;
      yield json;
      for await (const chunk of createReadStream(path.join(dir, 'source.tar'))) yield chunk;
      if (gitBundle) {
        for await (const chunk of createReadStream(gitBundle.filename, { signal: context.signal }))
          yield chunk;
      }
    })(),
  );
  await remote(context, handle, 'prepare', input, dependencies.execute || runProcess);
  await context.onLog?.(`PHP 8.5 源码检查通过（${lint.phpFiles} 个文件），后端版本已准备\n`);
  return handle;
}

function activationBody(handle, options = {}) {
  const body = {
    schemaVersion: 1,
    application: handle.application,
    release: handle.release,
    sourceCommit: handle.sourceCommit,
    archiveSha256: handle.archiveSha256,
    frontendRelease: handle.release,
  };
  if (options.expectedCurrentRelease !== undefined) {
    if (!UUID.test(options.expectedCurrentRelease)) fail('invalid_current_release');
    body.expectedCurrentRelease = options.expectedCurrentRelease;
  }
  return Buffer.from(JSON.stringify(body));
}

export async function activatePhpBackend(context, handle, dependencies = {}) {
  await checkedHandle(context, handle);
  return remote(
    context,
    handle,
    'activate',
    activationBody(handle),
    dependencies.execute || runProcess,
  );
}
export async function rollbackPhpBackend(context, handle, options = {}, dependencies = {}) {
  await checkedHandle(context, handle);
  return remote(
    context,
    handle,
    'rollback',
    activationBody(handle, options),
    dependencies.execute || runProcess,
  );
}
export async function statusPhpBackend(context, handle, dependencies = {}) {
  await checkedHandle(context, handle);
  return remote(context, handle, 'status', Buffer.alloc(0), dependencies.execute || runProcess);
}
