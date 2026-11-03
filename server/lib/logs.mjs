import fs from 'node:fs';
import path from 'node:path';

export function secretValues(project, credentials) {
  const items = credentials instanceof Map ? [...credentials.values()] : Object.values(credentials);
  const values = [
    ...Object.values(project.environment || {}),
    ...items.flatMap((item) =>
      (item.privateKey || '').split(/\r?\n/).filter((line) => !line.startsWith('-----')),
    ),
  ].filter((value) => typeof value === 'string' && value.length >= 3);
  // Authentication passwords must be hidden even when shorter than ordinary tokens.
  values.push(
    ...items
      .map((item) => item.password)
      .filter((value) => typeof value === 'string' && value.length > 0),
  );
  for (const item of items) {
    if (item.type !== 'git-https' || typeof item.password !== 'string' || !item.password) continue;
    values.push(encodeURIComponent(item.password.toWellFormed()));
    if (typeof item.username === 'string') {
      values.push(Buffer.from(`${item.username}:${item.password}`, 'utf8').toString('base64'));
    }
  }
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}
export function redactText(text, secrets) {
  let output = ansiNormalizer()(String(text));
  for (const value of secrets) output = output.split(value).join('[REDACTED]');
  return output;
}

// Keep a tail so a secret split across stdout chunks never reaches disk in clear text.
export function createLogWriter(filename, secrets = [], maxBytes = 10 * 1024 * 1024) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(filename, 'a', 0o600);
  let bytes = fs.fstatSync(fd).size;
  const normalize = ansiNormalizer();
  const patterns = secrets.map((value) => ({ value, prefix: prefixTable(value) }));
  let pending = '';
  let limited = false;
  let closed = false;
  const persist = (value) => {
    if (!value || limited) return;
    const buffer = Buffer.from(value);
    if (bytes + buffer.length > maxBytes) {
      const marker = '\n[Flow Lite] 日志已达到 10 MB 上限，后续输出已省略。\n';
      fs.writeSync(fd, marker);
      bytes += Buffer.byteLength(marker);
      limited = true;
      return;
    }
    fs.writeSync(fd, buffer);
    bytes += buffer.length;
  };
  function drain(final = false) {
    for (const secret of secrets) pending = pending.split(secret).join('[REDACTED]');
    const keep = final
      ? 0
      : Math.max(0, ...patterns.map((pattern) => partialSuffix(pending, pattern)));
    const cut = pending.length - keep;
    if (cut > 0) {
      persist(pending.slice(0, cut));
      pending = pending.slice(cut);
    }
  }
  return {
    write(text) {
      if (closed) return;
      pending += normalize(String(text));
      drain();
    },
    close() {
      if (closed) return;
      drain(true);
      closed = true;
      fs.closeSync(fd);
    },
  };
}

function ansiNormalizer() {
  let state = 'text';
  return (text) => {
    let result = '';
    for (const char of text) {
      if (state === 'text') {
        if (char === '\x1b') state = 'escape';
        else result += char;
      } else if (state === 'escape') state = char === '[' ? 'csi' : char === ']' ? 'osc' : 'text';
      else if (state === 'csi') {
        if (char >= '@' && char <= '~') state = 'text';
      } else if (state === 'osc') {
        if (char === '\x07') state = 'text';
        else if (char === '\x1b') state = 'osc-escape';
      } else if (state === 'osc-escape') state = char === '\\' ? 'text' : 'osc';
    }
    return result;
  };
}
function prefixTable(value) {
  const result = Array(value.length).fill(0);
  for (let i = 1, j = 0; i < value.length; i++) {
    while (j && value[i] !== value[j]) j = result[j - 1];
    if (value[i] === value[j]) j++;
    result[i] = j;
  }
  return result;
}
function partialSuffix(text, { value, prefix }) {
  let j = 0;
  for (let i = Math.max(0, text.length - value.length + 1); i < text.length; i++) {
    while (j && text[i] !== value[j]) j = prefix[j - 1];
    if (text[i] === value[j]) j++;
    if (j === value.length) j = prefix[j - 1];
  }
  return j;
}
