import { isAllowedHttpGitRepository } from '../../../shared/repository-policy.mjs';

export function createCredentialForm() {
  return {
    name: '',
    type: 'ssh',
    authType: 'key',
    username: '',
    privateKey: '',
    password: '',
    knownHosts: '',
  };
}

export function credentialKind(credential) {
  if (credential.type === 'git-https') return 'git-https';
  return credential.authType === 'password' ? 'ssh-password' : 'ssh-key';
}

export function changeCredentialKind(form, kind) {
  form.type = kind === 'git-https' ? 'git-https' : 'ssh';
  form.authType = kind === 'ssh-key' ? 'key' : 'password';
  form.username = '';
  form.privateKey = '';
  form.password = '';
  form.knownHosts = '';
}

export function credentialTypeLabel(credential) {
  if (credential.type === 'git-https') return 'Git HTTPS 账号密码';
  return credential.authType === 'password' ? 'SSH 密码' : 'SSH 私钥';
}

export function repositoryCredentialType(repoUrl = '') {
  const url = repoUrl.trim();
  if (/^https:\/\//i.test(url) || isAllowedHttpGitRepository(url)) return 'git-https';
  if (/^ssh:\/\//i.test(url) || /^[\w.-]+@[^\s:]+:/.test(url)) return 'ssh';
  return null;
}

export function matchesRepository(credential, repoUrl) {
  return (credential.type || 'ssh') === repositoryCredentialType(repoUrl);
}

export function credentialPayload(form) {
  const { name, authType, username, password, privateKey, knownHosts } = form;
  if (form.type === 'git-https') {
    return { name, type: 'git-https', authType: 'password', username, password };
  }
  return {
    name,
    type: 'ssh',
    authType,
    knownHosts,
    ...(authType === 'password' ? { password } : { privateKey }),
  };
}
