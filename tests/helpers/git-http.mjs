import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { runProcess } from '../../server/lib/process.mjs';
import { createGitHttpsFixture } from './git-https.mjs';

// An HTTP proxy keeps all network I/O on loopback while Git and its credential
// helper see the real, strictly allowlisted repository origin and path.
export async function createGitHttpFixture(t, options = {}) {
  const upstream = await createGitHttpsFixture(t, options);
  const ca = await fs.readFile(upstream.certificate);
  const destination = new URL(upstream.url);
  const authorization = `Basic ${Buffer.from(`${upstream.username}:${upstream.password}`).toString('base64')}`;
  const requests = [];
  let redirect = null;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    const authenticated = request.headers.authorization === authorization;
    requests.push({
      host: url.host,
      path: url.pathname,
      authenticated,
      hadCookie: Boolean(request.headers.cookie),
    });
    if (url.host !== 'git.yin-duo.com' || !url.pathname.startsWith('/mini-program/baking.git/')) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (!authenticated) {
      response.writeHead(401, {
        'www-authenticate': 'Basic realm="HTTP fixture"',
        'set-cookie': 'fixture-session=must-not-persist',
      });
      response.end();
      return;
    }
    if (redirect) {
      response.writeHead(302, { location: redirect });
      response.end();
      return;
    }
    const relay = https.request(
      {
        hostname: destination.hostname,
        port: destination.port,
        servername: 'localhost',
        path: url.pathname.replace('/mini-program/baking.git', '/team/repo.git') + url.search,
        method: request.method,
        headers: request.headers,
        ca,
      },
      (incoming) => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      },
    );
    relay.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(relay);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const proxy = `http://127.0.0.1:${server.address().port}`;
  const url = 'http://git.yin-duo.com/mini-program/baking.git';
  const proxyEnv = (env) => {
    const index = Number(env.GIT_CONFIG_COUNT || 0);
    return {
      ...env,
      GIT_CONFIG_COUNT: String(index + 1),
      [`GIT_CONFIG_KEY_${index}`]: 'http.proxy',
      [`GIT_CONFIG_VALUE_${index}`]: proxy,
    };
  };
  const runGit = (args, settings = {}) => {
    const command = [upstream.realGit, ...args];
    if (process.platform === 'darwin') {
      const denied = ['.netrc', '_netrc', '.git-credentials']
        .map((name) => `(literal ${JSON.stringify(path.join(os.homedir(), name))})`)
        .join(' ');
      command.unshift(
        '/usr/bin/sandbox-exec',
        '-p',
        `(version 1)(allow default)(deny file-read* ${denied})`,
      );
    }
    return runProcess(command[0], command.slice(1), { ...settings, env: proxyEnv(settings.env) });
  };
  async function installGitProxyShim() {
    const bin = path.join(upstream.root, 'http-bin');
    await fs.mkdir(bin);
    const trace = path.join(upstream.root, 'http-git-calls.jsonl');
    const denied = ['.netrc', '_netrc', '.git-credentials']
      .map((name) => `(literal ${JSON.stringify(path.join(os.homedir(), name))})`)
      .join(' ');
    const prefix =
      process.platform === 'darwin'
        ? ['/usr/bin/sandbox-exec', '-p', `(version 1)(allow default)(deny file-read* ${denied})`]
        : [];
    await fs.writeFile(
      path.join(bin, 'git'),
      `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({command:args[0],memoryAuth:Boolean(process.env.FLOW_GIT_CREDENTIAL_DATA),protocols:process.env.GIT_ALLOW_PROTOCOL})+'\\n');
const command=${JSON.stringify([...prefix, upstream.realGit, '-c', `http.proxy=${proxy}`])};
const child=cp.spawnSync(command[0],[...command.slice(1),...args],{env:process.env,stdio:'inherit'});
process.exit(child.status??1);
`,
      { mode: 0o755 },
    );
    const previous = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previous}`;
    t.after(() => {
      process.env.PATH = previous;
    });
    return trace;
  }
  return {
    ...upstream,
    url,
    requests,
    proxyEnv,
    runGit,
    installGitProxyShim,
    setRedirect(value) {
      redirect = value;
    },
  };
}
