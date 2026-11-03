import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/** A real local TLS Git smart-HTTP server. No external Git/CA endpoint is used. */
export async function createGitHttpsFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-git-https-fixture-'));
  const realGit = (await exec('which', ['git'])).stdout.trim();
  const openssl = (await exec('which', ['openssl'])).stdout.trim();
  const username = options.username || 'developer+ci@example.invalid';
  const password = options.password || "  fixture token '$HOME:@/+= with spaces  ";
  const git = (args, settings = {}) => exec(realGit, args, settings);
  const key = path.join(root, 'tls.key');
  const certificate = path.join(root, 'tls.pem');
  await exec(openssl, [
    'req',
    '-new',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-out',
    certificate,
    '-keyout',
    key,
  ]);
  const projectRoot = path.join(root, 'repos');
  const bare = path.join(projectRoot, 'team', 'repo.git');
  await fs.mkdir(path.dirname(bare), { recursive: true });
  let source = options.repoDir;
  if (!source) {
    source = path.join(root, 'source');
    await fs.mkdir(source);
    await git(['init', '-b', 'main'], { cwd: source });
    await git(['config', 'user.email', 'test@example.invalid'], { cwd: source });
    await git(['config', 'user.name', 'Fixture'], { cwd: source });
    await fs.writeFile(path.join(source, 'README.txt'), 'real TLS Git fixture\n');
    await git(['add', '.'], { cwd: source });
    await git(['commit', '-m', 'initial'], { cwd: source });
  }
  await git(['clone', '--bare', source, bare]);
  await git(['config', 'uploadpack.allowReachableSHA1InWant', 'true'], { cwd: bare });
  const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const requests = [];
  const processes = new Set();
  const server = https.createServer(
    { key: await fs.readFile(key), cert: await fs.readFile(certificate) },
    (request, response) => {
      const target = new URL(request.url, 'https://fixture.invalid');
      const authenticated = request.headers.authorization === expectedAuthorization;
      requests.push({
        pathname: target.pathname,
        authenticated,
        hadAuthorization: Boolean(request.headers.authorization),
      });
      if (!authenticated) {
        response.writeHead(401, { 'www-authenticate': 'Basic realm="Git fixture"' });
        response.end('Authentication required');
        return;
      }
      if (target.pathname.startsWith('/redirect.git')) {
        response.writeHead(302, { location: '/team/other.git/info/refs?service=git-upload-pack' });
        response.end();
        return;
      }
      const backend = spawn(realGit, ['http-backend'], {
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          HOME: root,
          LANG: 'C',
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: target.pathname,
          QUERY_STRING: target.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers['content-type'] || '',
          CONTENT_LENGTH: request.headers['content-length'] || '',
          HTTP_GIT_PROTOCOL: request.headers['git-protocol'] || '',
          REMOTE_USER: username,
          REMOTE_ADDR: '127.0.0.1',
          SERVER_PROTOCOL: 'HTTP/1.1',
          HTTPS: 'on',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      processes.add(backend);
      backend.stderr.resume();
      let headers = Buffer.alloc(0);
      let sent = false;
      backend.stdout.on('data', (chunk) => {
        if (sent) {
          response.write(chunk);
          return;
        }
        headers = Buffer.concat([headers, chunk]);
        let end = headers.indexOf('\r\n\r\n');
        let separator = 4;
        if (end < 0) {
          end = headers.indexOf('\n\n');
          separator = 2;
        }
        if (end < 0) return;
        let status = 200;
        const fields = {};
        for (const line of headers.subarray(0, end).toString('utf8').split(/\r?\n/)) {
          const colon = line.indexOf(':');
          if (colon < 0) continue;
          const name = line.slice(0, colon);
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
          else fields[name] = value;
        }
        response.writeHead(status, fields);
        sent = true;
        response.write(headers.subarray(end + separator));
      });
      backend.on('error', () => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      backend.on('close', () => {
        processes.delete(backend);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      request.on('error', () => backend.kill());
      backend.stdin.on('error', () => {});
      request.pipe(backend.stdin);
    },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const child of processes) child.kill('SIGKILL');
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await fs.rm(root, { recursive: true, force: true });
  });
  const url = `https://127.0.0.1:${server.address().port}/team/repo.git`;
  const trust = (env) => ({ ...env, GIT_SSL_CAINFO: certificate });
  async function installGitCaShim() {
    const bin = path.join(root, 'bin');
    await fs.mkdir(bin);
    const calls = path.join(root, 'git-calls.txt');
    await fs.writeFile(
      path.join(bin, 'git'),
      `#!/bin/sh\nprintf '%s\\n' "$1" >> ${quote(calls)}\nGIT_SSL_CAINFO=${quote(certificate)} exec ${quote(realGit)} "$@"\n`,
      { mode: 0o755 },
    );
    const previous = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previous}`;
    t.after(() => {
      process.env.PATH = previous;
    });
    return calls;
  }
  return {
    root,
    realGit,
    git,
    source,
    bare,
    url,
    username,
    password,
    requests,
    certificate,
    trust,
    installGitCaShim,
  };
}
