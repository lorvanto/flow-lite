export function date(value, full = false) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(full ? { year: 'numeric' } : {}),
    hour12: false,
  }).format(parsed);
}

export function duration(run) {
  if (!run?.startedAt) return '—';
  const seconds = Math.max(
    0,
    Math.floor((new Date(run.finishedAt || Date.now()) - new Date(run.startedAt)) / 1000),
  );
  return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
}

export function repoName(url = '') {
  return url.replace(/\.git$/, '').replace(/^(?:https?:\/\/|ssh:\/\/|git@)/, '');
}

export function executionDirectory(run) {
  return run.executionDirectory || run.releasePath || '等待执行';
}

export function credentialLabel(credential) {
  return `${credential.name}（${credential.authType === 'password' ? '密码' : '私钥'}）`;
}
