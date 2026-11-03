export const statusLabels = {
  queued: '排队中',
  running: '运行中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
};

export const stageLabels = {
  queued: '等待执行',
  checkout: '拉取代码',
  install: '安装依赖',
  build: '构建',
  archive: '保存产物',
  deploy: '部署',
  prepare: '准备执行',
  commands: '执行命令',
  done: '已完成',
};

const nodeStages = ['checkout', 'install', 'build', 'archive', 'deploy'];
const commandStages = ['prepare', 'commands'];

export function isCommand(item) {
  return item?.type === 'command' || item?.projectType === 'command' || item?.kind === 'command';
}

export function runStages(run) {
  return isCommand(run) ? commandStages : nodeStages;
}

export function miniStages(project) {
  return isCommand(project) ? commandStages : ['checkout', 'build', 'deploy'];
}

export function runLabel(run) {
  return run.kind === 'rollback' ? '版本回滚' : isCommand(run) ? '命令执行' : '构建发布';
}

export function stageState(stage, run) {
  if (!run || run.status === 'queued') return '';
  const steps = runStages(run);
  const index = steps.indexOf(stage);
  const current = steps.indexOf(run.stage);
  if (run.status === 'success') return 'completed';
  if (index < current) return 'completed';
  if (index === current) return run.status === 'running' ? 'active' : run.status;
  return '';
}
