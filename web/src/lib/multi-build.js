export const isMultiBuild = (project) => project?.buildMode === 'multi';
export const multiBuildSummary = (project) =>
  `${project.sources?.length || 0} 个代码源 · ${project.tasks?.length || 0} 个构建任务`;
export const environmentText = (environment = {}) =>
  Object.entries(environment)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
export function parseEnvironment(text = '') {
  const result = {};
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const equal = line.indexOf('=');
    const key = line.slice(0, equal).trim();
    if (equal < 1 || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))
      throw new Error(`环境变量第 ${index + 1} 行格式有误，请使用 KEY=value`);
    result[key] = line.slice(equal + 1);
  }
  return result;
}
export function enableMultiBuild(form) {
  if (!form.sources?.length)
    form.sources = [
      {
        id: 'main',
        name: '主仓库',
        repoUrl: form.repoUrl || '',
        branch: form.branch || 'main',
        buildCredentialId: form.buildCredentialId || null,
      },
    ];
  if (!form.tasks?.length)
    form.tasks = [
      {
        id: 'app',
        name: '主应用',
        sourceId: form.sources[0].id,
        nodeVersion: form.nodeVersion || '24',
        packageManager: form.packageManager || 'npm',
        packageManagerVersion: form.packageManagerVersion || '',
        installCommand: form.installCommand || 'npm ci',
        buildCommand: form.buildCommand || 'npm run build',
        workdir: form.workdir || '.',
        artifactDir: form.artifactDir || 'dist',
        publishDir: '.',
        environment: {},
        envText: '',
      },
    ];
  form.buildMode = 'multi';
}
export function taskPayloads(tasks) {
  return tasks.map(({ envText, ...task }) => ({
    ...task,
    environment: envText === undefined ? task.environment || {} : parseEnvironment(envText),
  }));
}
