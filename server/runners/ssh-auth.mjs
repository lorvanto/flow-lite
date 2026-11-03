import fs from 'node:fs/promises';
import path from 'node:path';

/** Prepare OpenSSH authentication inside an existing task-private directory.
 * The caller must remove that directory in its finally block.
 */
export async function prepareSshAuth({ credential, tempDir, prefix = 'ssh', env = {} }) {
  if (!path.isAbsolute(tempDir || '') || !/^[A-Za-z\d_-]{1,40}$/.test(prefix))
    throw new Error('SSH 临时目录或文件前缀无效');
  const directory = await fs.lstat(tempDir);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error('SSH 临时目录必须是实际目录');
  await fs.chmod(tempDir, 0o700);
  if (credential && credential.type !== 'ssh') throw new Error('SSH 凭据类型无效');
  const authType = credential?.authType || 'key';
  if (!['key', 'password'].includes(authType)) throw new Error('SSH 认证方式无效');
  const args = [
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
  ];
  const authEnv = { ...env };
  const writePrivate = async (filename, content, mode) => {
    await fs.writeFile(filename, content, { mode, flag: 'wx' });
    await fs.chmod(filename, mode);
  };
  if (authType === 'password') {
    if (
      typeof credential.password !== 'string' ||
      !credential.password ||
      /[\0\r\n]/.test(credential.password)
    )
      throw new Error('SSH 密码未配置或包含不支持的换行字符');
    const passwordFile = path.join(tempDir, `${prefix}.password`);
    const askpassFile = path.join(tempDir, `${prefix}.askpass`);
    await writePrivate(passwordFile, `${credential.password}\n`, 0o600);
    await writePrivate(
      askpassFile,
      '#!/bin/sh\n[ -n "${FLOW_SSH_PASSWORD_FILE:-}" ] || exit 1\nexec /bin/cat -- "$FLOW_SSH_PASSWORD_FILE"\n',
      0o700,
    );
    Object.assign(authEnv, {
      SSH_ASKPASS: askpassFile,
      SSH_ASKPASS_REQUIRE: 'force',
      FLOW_SSH_PASSWORD_FILE: passwordFile,
      DISPLAY: ':0',
    });
    args.push(
      '-o',
      'BatchMode=no',
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'PasswordAuthentication=yes',
      '-o',
      'KbdInteractiveAuthentication=yes',
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'NumberOfPasswordPrompts=1',
    );
  } else {
    args.push('-o', 'BatchMode=yes');
    if (credential) {
      if (typeof credential.privateKey !== 'string' || !credential.privateKey.trim())
        throw new Error('SSH 私钥未配置');
      const keyFile = path.join(tempDir, `${prefix}.key`);
      await writePrivate(
        keyFile,
        `${credential.privateKey.trim().replaceAll('\r\n', '\n')}\n`,
        0o600,
      );
      args.push('-i', keyFile, '-o', 'IdentitiesOnly=yes');
    }
  }
  if (credential?.knownHosts?.trim()) {
    const hostsFile = path.join(tempDir, `${prefix}.known_hosts`);
    await writePrivate(hostsFile, `${credential.knownHosts.trim()}\n`, 0o600);
    const optionPath = /\s/.test(hostsFile)
      ? `"${hostsFile.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
      : hostsFile;
    args.push('-o', `UserKnownHostsFile=${optionPath}`);
  }
  return { args, env: authEnv };
}
