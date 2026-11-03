<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Folder,
  GitBranch,
  Globe,
  KeyRound,
  Layers,
  Loader2,
  LogOut,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  Workflow,
  XCircle,
} from '@lucide/vue';
import { request } from './lib/api.js';
import { date, duration, executionDirectory, repoName } from './lib/format.js';
import { createCredentialForm, credentialPayload, credentialTypeLabel } from './lib/credentials.js';
import { isCommand, runLabel, stageLabels } from './lib/pipeline.js';
import { useRunLogs } from './composables/useRunLogs.js';
import BaseModal from './components/BaseModal.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import CredentialForm from './components/CredentialForm.vue';
import ProjectForm from './components/ProjectForm.vue';
import PipelineStages from './components/PipelineStages.vue';
import RunDetailDrawer from './components/RunDetailDrawer.vue';
import StatusBadge from './components/StatusBadge.vue';
import ToastNotice from './components/ToastNotice.vue';

const auth = ref(null);
const authForm = ref({ username: 'admin', password: '', confirmPassword: '', setupToken: '' });
const authError = ref('');
const authBusy = ref(false);
const view = ref('projects');
const projects = ref([]);
const runs = ref([]);
const scopedRuns = ref([]);
const credentials = ref([]);
const system = ref(null);
const loading = ref(false);
const busy = ref('');
const search = ref('');
const filter = ref('all');
const group = ref(null);
const activeProjectId = ref(null);
const projectTab = ref('runs');
const modal = ref(null);
const editingId = ref(null);
const formError = ref('');
const form = ref({});
const credentialForm = ref(createCredentialForm());
watch(
  modal,
  (current, previous) => {
    if (previous === 'credential' && current !== 'credential')
      credentialForm.value = createCredentialForm();
  },
  { flush: 'sync' },
);
const passwordForm = ref({ currentPassword: '', newPassword: '', confirmPassword: '' });
const passwordError = ref('');
const confirmation = ref(null);
const toast = ref(null);
let refreshTimer;
let toastTimer;
let refreshing = false;
const { detailRun, logText, logConnected, openRun, closeRun, stopLogs } = useRunLogs({
  isAuthenticated: () => Boolean(auth.value?.authenticated),
  onComplete: () => refresh(),
});

const nodeVersions = computed(() => system.value?.nodeVersions || ['14', '18', '22', '24', '26']);
const dockerNotReady = computed(
  () => system.value?.runnerMode === 'docker' && system.value.dockerAvailable === false,
);
const hasNodeProjects = computed(() => projects.value.some((project) => !isCommand(project)));
const groups = computed(() =>
  [...new Set(projects.value.map((p) => p.group).filter(Boolean))].sort(),
);
const activeProject = computed(() => projects.value.find((p) => p.id === activeProjectId.value));
const showReleases = computed(
  () => projectTab.value === 'releases' && !isCommand(activeProject.value),
);
const projectRuns = computed(() =>
  scopedRuns.value.filter((r) => r.projectId === activeProjectId.value),
);
const releases = computed(() =>
  projectRuns.value.filter((r) => r.kind === 'build' && r.status === 'success'),
);
const activeCount = computed(
  () => runs.value.filter((r) => ['queued', 'running'].includes(r.status)).length,
);
const failedCount = computed(
  () => projects.value.filter((p) => p.latestRun?.status === 'failed').length,
);
const successRate = computed(() => {
  const finished = runs.value.filter(
    (r) => r.kind !== 'rollback' && ['success', 'failed'].includes(r.status),
  );
  return finished.length
    ? Math.round((finished.filter((r) => r.status === 'success').length / finished.length) * 100)
    : null;
});
const filteredProjects = computed(() =>
  projects.value.filter((p) => {
    const query = search.value.trim().toLowerCase();
    return (
      (group.value === null || (group.value === '' ? !p.group : p.group === group.value)) &&
      (!query ||
        [p.name, p.repoUrl, p.group, p.description].some((s) =>
          s?.toLowerCase().includes(query),
        )) &&
      (filter.value === 'all' ||
        (filter.value === 'idle' ? !p.latestRun : p.latestRun?.status === filter.value))
    );
  }),
);
const filteredRuns = computed(() =>
  runs.value.filter((r) => {
    const query = search.value.trim().toLowerCase();
    return (
      (!query ||
        [r.projectName, r.commitSha, String(r.number)].some((s) =>
          s?.toLowerCase().includes(query),
        )) &&
      (filter.value === 'all' || r.status === filter.value)
    );
  }),
);
const viewLabel = computed(
  () =>
    ({
      projects: '流水线',
      runs: '运行记录',
      credentials: '凭据管理',
      settings: '系统设置',
      project: activeProject.value?.name || '项目详情',
    })[view.value],
);
const authTitle = computed(() => (auth.value?.initialized ? '登录工作空间' : '创建你的工作空间'));

function notify(message, type = 'success') {
  clearTimeout(toastTimer);
  toast.value = { message, type };
  toastTimer = setTimeout(
    () => {
      toast.value = null;
    },
    type === 'error' ? 8000 : 4000,
  );
}
function navigate(next, selectedGroup = null) {
  view.value = next;
  group.value = selectedGroup;
  search.value = '';
  filter.value = 'all';
}
function openProject(project) {
  activeProjectId.value = project.id;
  scopedRuns.value = runs.value.filter((r) => r.projectId === project.id);
  projectTab.value = 'runs';
  navigate('project');
  request(`/runs?projectId=${encodeURIComponent(project.id)}&limit=100`)
    .then((data) => {
      if (activeProjectId.value === project.id) scopedRuns.value = data.runs;
    })
    .catch((error) => notify(error.message, 'error'));
}
async function refresh(includeSystem = false) {
  if (refreshing || !auth.value?.authenticated) return;
  refreshing = true;
  try {
    const [p, r, c] = await Promise.all([
      request('/projects'),
      request('/runs?limit=100'),
      request('/credentials'),
    ]);
    projects.value = p.projects;
    runs.value = r.runs;
    credentials.value = c.credentials;
    if (view.value === 'project' && activeProjectId.value) {
      const result = await request(
        `/runs?projectId=${encodeURIComponent(activeProjectId.value)}&limit=100`,
      );
      scopedRuns.value = result.runs;
    }
    if (includeSystem || !system.value || view.value === 'settings')
      system.value = await request('/system');
  } finally {
    refreshing = false;
  }
}
async function load() {
  loading.value = true;
  try {
    await refresh(true);
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    loading.value = false;
  }
}
async function initialize() {
  try {
    auth.value = await request('/auth/status');
    if (auth.value.authenticated) await load();
  } catch (error) {
    authError.value = error.message;
    auth.value = { initialized: true, authenticated: false };
  }
}
async function authenticate() {
  authError.value = '';
  if (!auth.value.initialized && authForm.value.password !== authForm.value.confirmPassword) {
    authError.value = '两次输入的密码不一致';
    return;
  }
  authBusy.value = true;
  try {
    await request(`/auth/${auth.value.initialized ? 'login' : 'setup'}`, {
      method: 'POST',
      body: authForm.value,
    });
    authForm.value.password = '';
    authForm.value.confirmPassword = '';
    authForm.value.setupToken = '';
    auth.value = await request('/auth/status');
    await load();
  } catch (error) {
    authError.value = error.message;
  } finally {
    authBusy.value = false;
  }
}
function unauthorized() {
  stopLogs();
  auth.value = { initialized: true, authenticated: false };
  detailRun.value = null;
  modal.value = null;
  authError.value = '登录已过期，请重新登录';
}
async function logout() {
  try {
    await request('/auth/logout', { method: 'POST' });
    stopLogs();
    auth.value = { initialized: true, authenticated: false };
    authError.value = '';
    detailRun.value = null;
    modal.value = null;
  } catch (error) {
    notify(error.message, 'error');
  }
}
function newProject(project = null) {
  editingId.value = project?.id || null;
  formError.value = '';
  const defaults = {
    type: 'node',
    commands: 'git pull --ff-only',
    name: '',
    group: group.value || '',
    description: '',
    repoUrl: '',
    branch: 'main',
    nodeVersion: '24',
    packageManager: 'npm',
    packageManagerVersion: '',
    installCommand: 'npm ci',
    buildCommand: 'npm run build',
    workdir: '.',
    artifactDir: 'dist',
    timeoutSeconds: 900,
    environment: {},
    buildCredentialId: null,
    deploy: { type: 'local', root: '', host: '', port: 22, user: '', credentialId: null },
    retainReleases: 5,
  };
  const source = project ? JSON.parse(JSON.stringify(project)) : {};
  form.value = { ...defaults, ...source, deploy: { ...defaults.deploy, ...source.deploy } };
  form.value.envText = Object.entries(form.value.environment || {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  modal.value = 'project';
}
async function saveProject() {
  formError.value = '';
  busy.value = 'save-project';
  try {
    const environment = {};
    for (const [index, line] of form.value.envText.split('\n').entries()) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const separator = line.indexOf('=');
      const key = line.slice(0, separator).trim();
      if (separator < 1 || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))
        throw new Error(`环境变量第 ${index + 1} 行格式有误，请使用 KEY=value`);
      environment[key] = line.slice(separator + 1);
    }
    const { envText, latestRun, currentReleaseId, createdAt, updatedAt, id, ...values } =
      form.value;
    values.environment = environment;
    values.buildCredentialId ||= null;
    values.deploy.credentialId ||= null;
    values.deploy.port = Number(values.deploy.port || 22);
    let payload = values;
    if (values.type === 'command') {
      const { type, name, group, description, commands, timeoutSeconds, environment, deploy } =
        values;
      payload = { type, name, group, description, commands, timeoutSeconds, environment, deploy };
    } else delete payload.commands;
    const response = await request(editingId.value ? `/projects/${editingId.value}` : '/projects', {
      method: editingId.value ? 'PUT' : 'POST',
      body: payload,
    });
    modal.value = null;
    notify(editingId.value ? '项目配置已更新' : '流水线创建成功');
    await refresh();
    if (!editingId.value) openProject(response.project);
  } catch (error) {
    formError.value = error.message;
  } finally {
    busy.value = '';
  }
}
async function runProject(project) {
  busy.value = `run-${project.id}`;
  try {
    const { run } = await request(`/projects/${project.id}/runs`, { method: 'POST' });
    await refresh();
    openRun(run);
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    busy.value = '';
  }
}
async function retryRun(run) {
  busy.value = 'retry';
  try {
    const response = await request(`/runs/${run.id}/retry`, { method: 'POST' });
    openRun(response.run);
    await refresh();
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    busy.value = '';
  }
}
async function cancelRun(run) {
  busy.value = 'cancel';
  try {
    await request(`/runs/${run.id}/cancel`, { method: 'POST' });
    notify('已发送取消请求');
    const response = await request(`/runs/${run.id}`);
    if (detailRun.value?.id === run.id) detailRun.value = response.run;
    await refresh();
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    busy.value = '';
  }
}
function askDelete(project) {
  confirmation.value = {
    title: `删除「${project.name}」？`,
    description: '项目配置和运行记录将被删除。已发布的网站文件会保留。',
    label: '删除项目',
    danger: true,
    action: async () => {
      await request(`/projects/${project.id}`, { method: 'DELETE' });
      if (activeProjectId.value === project.id) navigate('projects');
      await refresh();
      notify('项目已删除');
    },
  };
}
function askRollback(run) {
  confirmation.value = {
    title: `回滚到 #${run.number}？`,
    description:
      '将使用这次构建保存的产物重新发布，无须重新构建。当前网站将在发布完成后切换到该版本。',
    label: '确认回滚',
    danger: false,
    action: async () => {
      const { run: queuedRun } = await request(`/projects/${run.projectId}/rollback`, {
        method: 'POST',
        body: { releaseId: run.id },
      });
      openRun(queuedRun);
      await refresh();
    },
  };
}
async function confirmAction() {
  busy.value = 'confirm';
  try {
    await confirmation.value.action();
    confirmation.value = null;
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    busy.value = '';
  }
}
async function copyLog() {
  try {
    await navigator.clipboard.writeText(logText.value);
    notify('日志已复制');
  } catch {
    notify('浏览器未允许复制，请下载日志', 'error');
  }
}
function addCredential() {
  credentialForm.value = createCredentialForm();
  formError.value = '';
  modal.value = 'credential';
}
async function saveCredential() {
  busy.value = 'save-credential';
  formError.value = '';
  try {
    await request('/credentials', {
      method: 'POST',
      body: credentialPayload(credentialForm.value),
    });
    credentialForm.value = createCredentialForm();
    modal.value = null;
    notify('凭据已保存');
    await refresh();
  } catch (error) {
    formError.value = error.message;
  } finally {
    busy.value = '';
  }
}
function deleteCredential(credential) {
  confirmation.value = {
    title: `删除凭据「${credential.name}」？`,
    description: '正在被项目使用的凭据无法删除，请先更新项目配置。',
    label: '删除凭据',
    danger: true,
    action: async () => {
      await request(`/credentials/${credential.id}`, { method: 'DELETE' });
      await refresh();
      notify('凭据已删除');
    },
  };
}
async function changePassword() {
  passwordError.value = '';
  if (passwordForm.value.newPassword !== passwordForm.value.confirmPassword) {
    passwordError.value = '两次输入的新密码不一致';
    return;
  }
  busy.value = 'password';
  try {
    await request('/auth/password', { method: 'POST', body: passwordForm.value });
    passwordForm.value = { currentPassword: '', newPassword: '', confirmPassword: '' };
    notify('密码已更新');
  } catch (error) {
    passwordError.value = error.message;
  } finally {
    busy.value = '';
  }
}
function escape(event) {
  if (event.key !== 'Escape' || busy.value) return;
  if (confirmation.value) confirmation.value = null;
  else if (modal.value) modal.value = null;
  else if (detailRun.value) closeRun();
}
onMounted(() => {
  initialize();
  refreshTimer = setInterval(() => {
    refresh().catch((error) => {
      if (error.status !== 401) console.warn('刷新失败', error.message);
    });
  }, 5000);
  window.addEventListener('flow:unauthorized', unauthorized);
  window.addEventListener('keydown', escape);
});
onUnmounted(() => {
  clearInterval(refreshTimer);
  clearTimeout(toastTimer);
  window.removeEventListener('flow:unauthorized', unauthorized);
  window.removeEventListener('keydown', escape);
});
</script>

<template>
  <div v-if="!auth" class="boot">
    <Loader2 class="spin" :size="28" />
    <span>正在连接工作空间…</span>
  </div>

  <div v-else-if="!auth.authenticated" class="auth-layout">
    <section class="auth-visual">
      <a href="/" class="brand">
        <span class="brand-symbol">
          F
          <span></span>
        </span>
        <strong>
          Flow
          <em>Lite</em>
        </strong>
      </a>
      <div class="auth-story">
        <span class="eyebrow">
          <span class="tiny-dot"></span>
          为项目交付而生
        </span>
        <h1>
          让每一次发布，
          <br />
          清晰、从容。
        </h1>
        <p>
          从代码到上线，在一个工作空间里完成。
          <br />
          Node.js 静态构建与 PHP / 命令发布。
        </p>
        <div class="auth-pipeline">
          <div>
            <GitBranch :size="21" />
            <span>代码</span>
          </div>
          <span class="pipeline-link"></span>
          <div>
            <Box :size="21" />
            <span>构建</span>
          </div>
          <span class="pipeline-link"></span>
          <div>
            <Globe :size="21" />
            <span>发布</span>
          </div>
        </div>
      </div>
      <div class="auth-foot">
        简单的流程，可靠的交付。
        <span>FLOW LITE</span>
      </div>
    </section>
    <main class="auth-main">
      <form class="auth-card" @submit.prevent="authenticate">
        <span class="auth-icon"><Workflow :size="25" /></span>
        <h2>{{ authTitle }}</h2>
        <p>
          {{
            auth.initialized
              ? '欢迎回来，继续你的构建与发布。'
              : '设置管理员账号，开始你的第一次发布。'
          }}
        </p>
        <div v-if="authError" class="error-message" role="alert">
          <XCircle :size="17" />
          {{ authError }}
        </div>
        <label class="field">
          管理员账号
          <input
            v-model="authForm.username"
            name="username"
            autocomplete="username"
            placeholder="请输入账号"
            required
            maxlength="50"
          />
        </label>
        <label class="field">
          {{ auth.initialized ? '密码' : '设置密码' }}
          <input
            v-model="authForm.password"
            name="password"
            type="password"
            :autocomplete="auth.initialized ? 'current-password' : 'new-password'"
            :minlength="auth.initialized ? 1 : 12"
            required
            :placeholder="auth.initialized ? '请输入密码' : '至少 12 位字符'"
          />
        </label>
        <label v-if="!auth.initialized" class="field">
          确认密码
          <input
            v-model="authForm.confirmPassword"
            name="confirm-password"
            type="password"
            autocomplete="new-password"
            minlength="12"
            required
            placeholder="再次输入密码"
          />
        </label>
        <label v-if="!auth.initialized && auth.setupTokenRequired" class="field">
          初始化令牌
          <input
            v-model="authForm.setupToken"
            name="setup-token"
            type="password"
            autocomplete="off"
            required
            placeholder="输入服务器上的初始化令牌"
          />
          <small>首次启动令牌保存在服务器数据目录的 setup-token 文件中。</small>
        </label>
        <button class="button primary auth-submit" :disabled="authBusy">
          <Loader2 v-if="authBusy" :size="17" class="spin" />
          {{ auth.initialized ? '登录' : '创建工作空间' }}
          <ArrowRight v-if="!authBusy" :size="17" />
        </button>
        <div class="auth-secure">
          <ShieldCheck :size="15" />
          仅授权管理员可以访问此工作空间
        </div>
      </form>
      <footer>Flow Lite · 项目构建发布</footer>
    </main>
  </div>

  <div v-else class="app-shell">
    <aside class="sidebar">
      <a href="/" class="brand" @click.prevent="navigate('projects')">
        <span class="brand-symbol">
          F
          <span></span>
        </span>
        <strong>
          Flow
          <em>Lite</em>
        </strong>
      </a>
      <div class="workspace">
        <span class="workspace-avatar">W</span>
        <div>
          <strong>我的工作空间</strong>
          <small>项目构建与发布</small>
        </div>
        <ChevronDown :size="15" class="muted" />
      </div>
      <div class="nav-section-label">工作台</div>
      <nav class="primary-nav" aria-label="主导航">
        <button
          :class="{ selected: ['projects', 'project'].includes(view) && group === null }"
          @click="navigate('projects')"
        >
          <Workflow :size="18" />
          全部流水线
          <span class="nav-count">{{ projects.length }}</span>
        </button>
        <button :class="{ selected: view === 'runs' }" @click="navigate('runs')">
          <Activity :size="18" />
          运行记录
          <span v-if="activeCount" class="nav-count blue">{{ activeCount }}</span>
        </button>
        <button :class="{ selected: view === 'credentials' }" @click="navigate('credentials')">
          <KeyRound :size="18" />
          凭据管理
        </button>
      </nav>
      <div class="nav-section-label groups-label">
        项目分组
        <span>{{ groups.length }}</span>
      </div>
      <nav class="group-nav" aria-label="项目分组">
        <button
          v-for="item in groups"
          :key="item"
          :class="{ selected: view === 'projects' && group === item }"
          @click="navigate('projects', item)"
        >
          <Folder :size="16" />
          <span>{{ item }}</span>
          <small>{{ projects.filter((p) => p.group === item).length }}</small>
        </button>
        <button
          :class="{ selected: view === 'projects' && group === '' }"
          @click="navigate('projects', '')"
        >
          <Folder :size="16" />
          <span>未分组</span>
          <small>{{ projects.filter((p) => !p.group).length }}</small>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <div class="sidebar-tip">
          <span class="tip-icon"><Box :size="17" /></span>
          <strong>专注每一次交付</strong>
          <p>构建、命令、发布，一处完成。</p>
        </div>
        <button
          class="settings-nav"
          :class="{ selected: view === 'settings' }"
          @click="navigate('settings')"
        >
          <Settings2 :size="17" />
          系统设置
        </button>
        <div class="sidebar-version">
          <span class="tiny-dot green"></span>
          Flow Lite
          <span>v{{ system?.version || '0.1.0' }}</span>
        </div>
      </div>
    </aside>

    <div class="main-shell">
      <header class="topbar">
        <div class="breadcrumbs">
          <span>工作空间</span>
          <ChevronRight :size="14" />
          <strong>{{ viewLabel }}</strong>
        </div>
        <div class="topbar-actions">
          <span class="node-only">
            <span class="tiny-dot green"></span>
            Node.js / PHP 项目发布
          </span>
          <span class="topbar-divider"></span>
          <span class="user-avatar">{{ (auth.username || 'A').slice(0, 1).toUpperCase() }}</span>
          <span class="username">{{ auth.username || '管理员' }}</span>
          <button class="icon-button" title="退出登录" aria-label="退出登录" @click="logout">
            <LogOut :size="17" />
          </button>
        </div>
      </header>
      <main class="page-content">
        <div v-if="loading" class="loading-line"></div>
        <template v-if="view === 'projects'">
          <div class="page-heading">
            <div>
              <div class="page-eyebrow">PIPELINES</div>
              <h1>
                {{ group === null ? '我的流水线' : group || '未分组' }}
                <span class="heading-count">
                  {{ group === null ? projects.length : filteredProjects.length }}
                </span>
              </h1>
              <p>让代码有序流动，让发布轻松发生。</p>
            </div>
            <button class="button primary" @click="newProject()">
              <Plus :size="17" />
              新建流水线
            </button>
          </div>
          <div
            v-if="dockerNotReady && (hasNodeProjects || !projects.length)"
            class="environment-notice"
            role="status"
          >
            <Server :size="17" />
            <span>
              Node.js 构建环境未就绪，请在服务器上启动 Docker。Node.js
              任务保持排队，命令任务可正常执行。
            </span>
            <button class="text-button" :disabled="loading" @click="load">
              <RefreshCw :size="13" :class="{ spin: loading }" />
              重新检查
            </button>
          </div>
          <div class="stats-grid">
            <div class="stat-card">
              <span class="stat-icon blue-bg"><Workflow :size="20" /></span>
              <div>
                <span class="stat-label">全部流水线</span>
                <strong>
                  {{ projects.length }}
                  <small>个项目</small>
                </strong>
              </div>
            </div>
            <div class="stat-card">
              <span class="stat-icon purple-bg"><Activity :size="20" /></span>
              <div>
                <span class="stat-label">进行中</span>
                <strong>
                  {{ activeCount }}
                  <small>个任务</small>
                </strong>
              </div>
              <span v-if="activeCount" class="live-dot"></span>
            </div>
            <div class="stat-card">
              <span class="stat-icon green-bg"><CheckCircle2 :size="20" /></span>
              <div>
                <span class="stat-label">最近执行成功率</span>
                <strong>
                  {{ successRate === null ? '—' : successRate }}
                  <small v-if="successRate !== null">%</small>
                </strong>
              </div>
            </div>
            <div class="stat-card">
              <span class="stat-icon amber-bg"><CircleHelp :size="20" /></span>
              <div>
                <span class="stat-label">需要关注</span>
                <strong>
                  {{ failedCount }}
                  <small>个项目</small>
                </strong>
              </div>
            </div>
          </div>
          <section class="panel pipeline-panel">
            <div class="panel-toolbar">
              <div class="table-tabs">
                <button class="active">
                  流水线列表
                  <span>{{ filteredProjects.length }}</span>
                </button>
              </div>
              <div class="table-tools">
                <label class="search-input">
                  <Search :size="16" />
                  <input
                    v-model="search"
                    placeholder="搜索项目名称或仓库"
                    aria-label="搜索流水线"
                  />
                </label>
                <select v-model="filter" aria-label="筛选运行状态">
                  <option value="all">全部状态</option>
                  <option value="success">执行成功</option>
                  <option value="failed">执行失败</option>
                  <option value="running">运行中</option>
                  <option value="queued">排队中</option>
                  <option value="idle">未运行</option>
                </select>
                <button
                  class="icon-button bordered"
                  title="刷新"
                  aria-label="刷新流水线"
                  @click="load"
                >
                  <RefreshCw :size="16" :class="{ spin: loading }" />
                </button>
              </div>
            </div>
            <div v-if="loading && !projects.length" class="empty-state compact" aria-live="polite">
              <Loader2 :size="28" class="spin" />
              <p>正在加载流水线…</p>
            </div>
            <div v-else-if="!projects.length" class="empty-state primary-empty">
              <div class="empty-illustration">
                <span class="empty-card back"></span>
                <span class="empty-card front">
                  <Workflow :size="33" />
                  <i></i>
                  <i></i>
                </span>
                <span class="empty-spark">+</span>
              </div>
              <h2>从第一条流水线开始</h2>
              <p>
                配置 Node.js 构建或 PHP / 命令发布，
                <br />
                把重复的操作交给 Flow Lite。
              </p>
              <button class="button primary" @click="newProject()">
                <Plus :size="17" />
                创建第一条流水线
              </button>
              <div class="empty-steps">
                <span>
                  <GitBranch :size="14" />
                  连接项目
                </span>
                <ArrowRight :size="13" />
                <span>
                  <Box :size="14" />
                  自动构建
                </span>
                <ArrowRight :size="13" />
                <span>
                  <Globe :size="14" />
                  发布上线
                </span>
              </div>
            </div>
            <div v-else-if="!filteredProjects.length" class="empty-state compact">
              <Search :size="30" />
              <h3>没有找到匹配的流水线</h3>
              <p>试试其他名称，或调整筛选条件。</p>
              <button
                class="button secondary"
                @click="
                  search = '';
                  filter = 'all';
                "
              >
                清除筛选
              </button>
            </div>
            <div v-else class="table-scroll">
              <table class="data-table project-table">
                <thead>
                  <tr>
                    <th>流水线名称</th>
                    <th>最近运行</th>
                    <th>执行阶段</th>
                    <th>执行方式</th>
                    <th>最近运行时间</th>
                    <th class="right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="project in filteredProjects" :key="project.id">
                    <td>
                      <button class="project-link" @click="openProject(project)">
                        <span
                          class="project-symbol"
                          :class="{ 'command-symbol': isCommand(project) }"
                        >
                          <component :is="isCommand(project) ? Terminal : Workflow" :size="21" />
                        </span>
                        <span>
                          <strong>{{ project.name }}</strong>
                          <small>
                            {{
                              project.description ||
                              (isCommand(project) ? project.deploy.root : repoName(project.repoUrl))
                            }}
                          </small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <button
                        v-if="project.latestRun"
                        class="run-status-link"
                        @click="openRun(project.latestRun)"
                      >
                        <span class="run-number">#{{ project.latestRun.number }}</span>
                        <StatusBadge :status="project.latestRun.status" />
                      </button>
                      <span v-else class="muted">尚未运行</span>
                    </td>
                    <td>
                      <PipelineStages
                        :run="project.latestRun"
                        :project-type="project.type || 'node'"
                        compact
                      />
                    </td>
                    <td>
                      <span v-if="isCommand(project)" class="command-badge">
                        <Terminal :size="12" />
                        PHP / 命令
                      </span>
                      <span v-else class="node-badge">
                        <span class="node-hex">N</span>
                        {{
                          project.nodeVersion === 'auto'
                            ? '自动识别'
                            : 'Node ' + project.nodeVersion
                        }}
                      </span>
                    </td>
                    <td class="subtle-text">{{ date(project.latestRun?.createdAt) }}</td>
                    <td>
                      <div class="row-actions">
                        <button
                          class="icon-button run-button"
                          :disabled="busy === `run-${project.id}`"
                          title="运行流水线"
                          :aria-label="`运行 ${project.name}`"
                          @click="runProject(project)"
                        >
                          <Loader2 v-if="busy === `run-${project.id}`" :size="17" class="spin" />
                          <Play v-else :size="17" />
                        </button>
                        <button
                          class="icon-button"
                          title="编辑配置"
                          :aria-label="`编辑 ${project.name}`"
                          @click="newProject(project)"
                        >
                          <Pencil :size="16" />
                        </button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="table-footer">
              <span>共 {{ filteredProjects.length }} 条流水线</span>
              <span>
                <span class="tiny-dot green"></span>
                每 5 秒自动刷新
              </span>
            </div>
          </section>
          <div class="page-note">
            <ShieldCheck :size="15" />
            Node.js 构建支持产物回滚，命令发布保留完整执行记录。
          </div>
        </template>

        <template v-else-if="view === 'project' && activeProject">
          <button class="back-link" @click="navigate('projects')">
            <ArrowLeft :size="15" />
            返回流水线列表
          </button>
          <div class="page-heading project-heading">
            <div>
              <div class="project-title">
                <span
                  class="project-symbol large"
                  :class="{ 'command-symbol': isCommand(activeProject) }"
                >
                  <component :is="isCommand(activeProject) ? Terminal : Workflow" :size="26" />
                </span>
                <h1>{{ activeProject.name }}</h1>
                <span v-if="activeProject.group" class="neutral-badge">
                  {{ activeProject.group }}
                </span>
              </div>
              <p>
                {{
                  activeProject.description ||
                  (isCommand(activeProject) ? 'PHP / 命令发布' : repoName(activeProject.repoUrl))
                }}
              </p>
            </div>
            <div class="heading-actions">
              <button class="button secondary" @click="newProject(activeProject)">
                <Settings2 :size="16" />
                配置
              </button>
              <button
                class="button primary"
                :disabled="busy === `run-${activeProject.id}`"
                @click="runProject(activeProject)"
              >
                <Play :size="16" />
                运行流水线
              </button>
            </div>
          </div>
          <div
            v-if="dockerNotReady && !isCommand(activeProject)"
            class="environment-notice"
            role="status"
          >
            <Server :size="17" />
            <span>
              Node.js 构建环境未就绪，请在服务器上启动 Docker。Node.js
              任务保持排队，命令任务可正常执行。
            </span>
            <button class="text-button" :disabled="loading" @click="load">
              <RefreshCw :size="13" :class="{ spin: loading }" />
              重新检查
            </button>
          </div>
          <section v-if="isCommand(activeProject)" class="panel project-overview command-overview">
            <div>
              <span class="metadata-label">
                <Terminal :size="14" />
                执行方式
              </span>
              <strong>
                {{ activeProject.deploy.type === 'ssh' ? 'SSH 远程执行' : '本机执行' }}
              </strong>
            </div>
            <div>
              <span class="metadata-label">
                <Folder :size="14" />
                执行目录
              </span>
              <strong class="mono truncate" :title="activeProject.deploy.root">
                {{ activeProject.deploy.type === 'ssh' ? activeProject.deploy.host + ':' : ''
                }}{{ activeProject.deploy.root }}
              </strong>
            </div>
            <div>
              <span class="metadata-label">
                <Clock3 :size="14" />
                执行超时
              </span>
              <strong>{{ activeProject.timeoutSeconds }} 秒</strong>
            </div>
            <div>
              <span class="metadata-label">
                <Activity :size="14" />
                最近运行
              </span>
              <strong>
                {{ activeProject.latestRun ? '#' + activeProject.latestRun.number : '尚未运行' }}
              </strong>
            </div>
          </section>
          <section v-else class="panel project-overview">
            <div>
              <span class="metadata-label">
                <GitBranch :size="14" />
                代码分支
              </span>
              <strong>{{ activeProject.branch }}</strong>
            </div>
            <div>
              <span class="metadata-label">
                <Box :size="14" />
                构建环境
              </span>
              <strong>
                Node.js
                {{ activeProject.nodeVersion === 'auto' ? '自动识别' : activeProject.nodeVersion }}
                <small>· {{ activeProject.packageManager }}</small>
              </strong>
            </div>
            <div>
              <span class="metadata-label">
                <Server :size="14" />
                发布位置
              </span>
              <strong class="mono truncate" :title="activeProject.deploy.root">
                {{ activeProject.deploy.type === 'ssh' ? activeProject.deploy.host + ':' : ''
                }}{{ activeProject.deploy.root }}
              </strong>
            </div>
            <div>
              <span class="metadata-label">
                <Layers :size="14" />
                当前版本
              </span>
              <strong>
                {{
                  activeProject.currentReleaseId
                    ? '#' +
                      (projectRuns.find((r) => r.id === activeProject.currentReleaseId)?.number ||
                        activeProject.currentReleaseId.slice(0, 8))
                    : '尚未发布'
                }}
              </strong>
            </div>
          </section>
          <section v-if="isCommand(activeProject)" class="panel project-command-panel">
            <div class="command-panel-heading">
              <Terminal :size="15" />
              <h2>发布命令</h2>
              <span>按顺序执行，失败即停止</span>
            </div>
            <pre>{{ activeProject.commands }}</pre>
            <p>命令在现有目录中直接执行，不提供自动回滚。</p>
          </section>
          <section class="panel">
            <div class="panel-toolbar">
              <div class="table-tabs">
                <button :class="{ active: !showReleases }" @click="projectTab = 'runs'">
                  运行记录
                  <span>{{ projectRuns.length }}</span>
                </button>
                <button
                  v-if="!isCommand(activeProject)"
                  :class="{ active: showReleases }"
                  @click="projectTab = 'releases'"
                >
                  发布历史
                  <span>{{ releases.length }}</span>
                </button>
              </div>
              <button class="icon-button bordered" title="刷新" aria-label="刷新记录" @click="load">
                <RefreshCw :size="16" :class="{ spin: loading }" />
              </button>
            </div>
            <div
              v-if="!(!showReleases ? projectRuns : releases).length"
              class="empty-state compact"
            >
              <span class="empty-round"><Clock3 :size="29" /></span>
              <h3>{{ !showReleases ? '这条流水线还没有运行' : '还没有成功发布的版本' }}</h3>
              <p>
                {{
                  !showReleases
                    ? '配置准备就绪，开始第一次运行吧。'
                    : '构建并发布成功后，可以在这里查看和回滚。'
                }}
              </p>
              <button class="button primary" @click="runProject(activeProject)">
                <Play :size="15" />
                运行流水线
              </button>
            </div>
            <div v-else class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>运行版本</th>
                    <th>状态</th>
                    <th>{{ isCommand(activeProject) ? '执行目录' : '提交' }}</th>
                    <th>耗时</th>
                    <th>运行时间</th>
                    <th class="right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="run in !showReleases ? projectRuns : releases" :key="run.id">
                    <td>
                      <button class="text-button" @click="openRun(run)">
                        <span class="run-number">#{{ run.number }}</span>
                        <span class="neutral-badge">{{ runLabel(run) }}</span>
                      </button>
                      <span
                        v-if="
                          !isCommand(activeProject) && activeProject.currentReleaseId === run.id
                        "
                        class="current-tag"
                      >
                        当前版本
                      </span>
                    </td>
                    <td><StatusBadge :status="run.status" /></td>
                    <td>
                      <span
                        v-if="isCommand(run)"
                        class="execution-path truncate"
                        :title="executionDirectory(run)"
                      >
                        {{ executionDirectory(run) }}
                      </span>
                      <span v-else class="commit">
                        <GitBranch :size="13" />
                        {{ run.commitSha?.slice(0, 8) || '—' }}
                      </span>
                    </td>
                    <td class="subtle-text">{{ duration(run) }}</td>
                    <td class="subtle-text">{{ date(run.createdAt, true) }}</td>
                    <td>
                      <div class="row-actions">
                        <button
                          v-if="showReleases"
                          class="text-button"
                          :disabled="
                            !run.artifactAvailable || activeProject.currentReleaseId === run.id
                          "
                          @click="askRollback(run)"
                        >
                          <RotateCcw :size="14" />
                          {{ run.artifactAvailable ? '回滚到此版本' : '产物已清理' }}
                        </button>
                        <button v-else class="text-button" @click="openRun(run)">
                          查看日志
                          <ChevronRight :size="14" />
                        </button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
          <div class="danger-zone">
            <span>项目不再使用时，可以删除配置及运行记录。</span>
            <button class="text-button danger-text" @click="askDelete(activeProject)">
              <Trash2 :size="14" />
              删除项目
            </button>
          </div>
        </template>

        <template v-else-if="view === 'runs'">
          <div class="page-heading">
            <div>
              <div class="page-eyebrow">ACTIVITY</div>
              <h1>运行记录</h1>
              <p>每一次构建与发布，都有迹可循。</p>
            </div>
            <button class="button secondary" @click="load">
              <RefreshCw :size="16" :class="{ spin: loading }" />
              刷新记录
            </button>
          </div>
          <section class="panel">
            <div class="panel-toolbar">
              <div class="table-tabs">
                <button class="active">
                  最近运行
                  <span>{{ runs.length }}</span>
                </button>
              </div>
              <div class="table-tools">
                <label class="search-input">
                  <Search :size="16" />
                  <input
                    v-model="search"
                    placeholder="搜索项目、版本或提交"
                    aria-label="搜索运行记录"
                  />
                </label>
                <select v-model="filter" aria-label="筛选运行状态">
                  <option value="all">全部状态</option>
                  <option value="success">成功</option>
                  <option value="failed">失败</option>
                  <option value="running">运行中</option>
                  <option value="queued">排队中</option>
                  <option value="cancelled">已取消</option>
                </select>
              </div>
            </div>
            <div v-if="!filteredRuns.length" class="empty-state compact">
              <span class="empty-round"><Activity :size="29" /></span>
              <h3>{{ runs.length ? '没有匹配的运行记录' : '还没有运行记录' }}</h3>
              <p>
                {{
                  runs.length
                    ? '调整搜索条件后再试一次。'
                    : '运行一条流水线，记录将在这里自动出现。'
                }}
              </p>
              <button v-if="!runs.length" class="button secondary" @click="navigate('projects')">
                查看流水线
                <ArrowRight :size="15" />
              </button>
            </div>
            <div v-else class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>流水线 / 版本</th>
                    <th>状态</th>
                    <th>当前步骤</th>
                    <th>提交 / 执行目录</th>
                    <th>耗时</th>
                    <th>运行时间</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="run in filteredRuns" :key="run.id">
                    <td>
                      <button class="text-button dark" @click="openRun(run)">
                        <strong>{{ run.projectName }}</strong>
                        <span class="run-number">#{{ run.number }}</span>
                        <span
                          v-if="run.kind === 'rollback' || isCommand(run)"
                          class="neutral-badge"
                        >
                          {{ isCommand(run) ? '命令' : '回滚' }}
                        </span>
                      </button>
                    </td>
                    <td><StatusBadge :status="run.status" /></td>
                    <td class="subtle-text">{{ stageLabels[run.stage] || run.stage }}</td>
                    <td>
                      <span
                        v-if="isCommand(run)"
                        class="execution-path truncate"
                        :title="executionDirectory(run)"
                      >
                        {{ executionDirectory(run) }}
                      </span>
                      <span v-else class="commit">{{ run.commitSha?.slice(0, 8) || '—' }}</span>
                    </td>
                    <td class="subtle-text">{{ duration(run) }}</td>
                    <td class="subtle-text">{{ date(run.createdAt) }}</td>
                    <td>
                      <button
                        class="icon-button"
                        title="查看运行详情"
                        aria-label="查看运行详情"
                        @click="openRun(run)"
                      >
                        <ChevronRight :size="17" />
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="table-footer">
              <span>显示最近 {{ runs.length }} 条记录</span>
              <span>每 5 秒自动刷新</span>
            </div>
          </section>
        </template>

        <template v-else-if="view === 'credentials'">
          <div class="page-heading">
            <div>
              <div class="page-eyebrow">CREDENTIALS</div>
              <h1>凭据管理</h1>
              <p>集中管理 SSH 私钥、SSH 密码与 Git HTTPS 仓库账号密码。</p>
            </div>
            <button class="button primary" @click="addCredential">
              <Plus :size="17" />
              添加凭据
            </button>
          </div>
          <div class="info-banner">
            <ShieldCheck :size="20" />
            <div>
              <strong>凭据加密保存，按项目使用</strong>
              <p>账号、密码和私钥加密保存，保存后不会回显。为仓库和部署服务器选择对应凭据。</p>
            </div>
          </div>
          <section class="panel">
            <div class="panel-toolbar">
              <h2>
                连接凭据
                <span class="heading-count">{{ credentials.length }}</span>
              </h2>
            </div>
            <div v-if="!credentials.length" class="empty-state compact">
              <span class="empty-round"><KeyRound :size="29" /></span>
              <h3>还没有添加凭据</h3>
              <p>
                访问私有仓库或通过 SSH 发布时，
                <br />
                添加对应的仓库或 SSH 连接凭据。
              </p>
              <button class="button secondary" @click="addCredential">
                <Plus :size="16" />
                添加连接凭据
              </button>
            </div>
            <div v-else class="table-scroll">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>凭据名称</th>
                    <th>类型</th>
                    <th>连接校验</th>
                    <th>创建时间</th>
                    <th class="right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="credential in credentials" :key="credential.id">
                    <td>
                      <div class="credential-name">
                        <span class="credential-icon"><KeyRound :size="18" /></span>
                        <strong>{{ credential.name }}</strong>
                      </div>
                    </td>
                    <td>
                      <span class="neutral-badge">
                        {{ credentialTypeLabel(credential) }}
                      </span>
                    </td>
                    <td>
                      <span class="subtle-text">
                        {{
                          credential.type === 'git-https'
                            ? 'HTTPS 证书校验'
                            : credential.hasKnownHosts
                              ? '已配置可信主机'
                              : '使用服务器 known_hosts'
                        }}
                      </span>
                    </td>
                    <td class="subtle-text">{{ date(credential.createdAt, true) }}</td>
                    <td>
                      <div class="row-actions">
                        <button
                          class="icon-button danger-text"
                          title="删除凭据"
                          aria-label="删除凭据"
                          @click="deleteCredential(credential)"
                        >
                          <Trash2 :size="16" />
                        </button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>

        <template v-else-if="view === 'settings'">
          <div class="page-heading">
            <div>
              <div class="page-eyebrow">SETTINGS</div>
              <h1>系统设置</h1>
              <p>查看工作空间状态，管理你的账号安全。</p>
            </div>
            <button class="button secondary" @click="load">
              <RefreshCw :size="16" :class="{ spin: loading }" />
              检查状态
            </button>
          </div>
          <div class="settings-grid">
            <section class="panel settings-panel">
              <div class="section-heading">
                <span class="section-icon"><Server :size="19" /></span>
                <div>
                  <h2>运行环境</h2>
                  <p>当前服务器与构建执行器的状态</p>
                </div>
              </div>
              <dl class="system-list">
                <div>
                  <dt>服务版本</dt>
                  <dd>Flow Lite {{ system?.version || '—' }}</dd>
                </div>
                <div>
                  <dt>平台 Node.js</dt>
                  <dd class="mono">{{ system?.hostNodeVersion || '—' }}</dd>
                </div>
                <div>
                  <dt>Node.js 构建模式</dt>
                  <dd>
                    <span class="neutral-badge">
                      {{ system?.runnerMode === 'docker' ? 'Docker 隔离构建' : '本机执行' }}
                    </span>
                  </dd>
                </div>
                <div v-if="system?.runnerMode === 'docker'">
                  <dt>Docker 服务</dt>
                  <dd>
                    <span
                      class="status-badge"
                      :class="system.dockerAvailable ? 'success' : 'failed'"
                    >
                      <component :is="system.dockerAvailable ? CheckCircle2 : XCircle" :size="13" />
                      {{ system.dockerAvailable ? '可用' : '未连接' }}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>任务执行器</dt>
                  <dd>
                    <span
                      class="status-badge"
                      :class="system?.worker?.online ? 'success' : 'failed'"
                    >
                      <span
                        class="tiny-dot"
                        :class="system?.worker?.online ? 'green' : 'red'"
                      ></span>
                      {{ system?.worker?.online ? '在线' : '离线' }}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>最近心跳</dt>
                  <dd>{{ date(system?.worker?.lastSeen, true) }}</dd>
                </div>
                <div>
                  <dt>数据目录</dt>
                  <dd class="mono path-value">{{ system?.dataDir || '—' }}</dd>
                </div>
              </dl>
              <div
                v-if="system?.runnerMode === 'docker' && !system.dockerAvailable"
                class="inline-notice"
              >
                Docker 服务尚未连接，启动后即可使用不同版本的 Node.js 构建项目。
              </div>
              <div v-if="!system?.worker?.online" class="inline-notice">
                执行器尚未上线，请在服务器上启动 Worker 进程。
              </div>
            </section>
            <section class="panel settings-panel">
              <div class="section-heading">
                <span class="section-icon"><ShieldCheck :size="19" /></span>
                <div>
                  <h2>账号安全</h2>
                  <p>当前账号：{{ auth.username || '管理员' }}</p>
                </div>
              </div>
              <form class="password-form" @submit.prevent="changePassword">
                <div v-if="passwordError" class="error-message" role="alert">
                  <XCircle :size="16" />
                  {{ passwordError }}
                </div>
                <label class="field">
                  当前密码
                  <input
                    v-model="passwordForm.currentPassword"
                    type="password"
                    autocomplete="current-password"
                    required
                    placeholder="请输入当前密码"
                  />
                </label>
                <label class="field">
                  新密码
                  <input
                    v-model="passwordForm.newPassword"
                    type="password"
                    autocomplete="new-password"
                    required
                    minlength="12"
                    placeholder="至少 12 位字符"
                  />
                </label>
                <label class="field">
                  确认新密码
                  <input
                    v-model="passwordForm.confirmPassword"
                    type="password"
                    autocomplete="new-password"
                    required
                    minlength="12"
                    placeholder="再次输入新密码"
                  />
                </label>
                <button class="button primary" :disabled="busy === 'password'">
                  <Loader2 v-if="busy === 'password'" :size="15" class="spin" />
                  更新密码
                </button>
              </form>
            </section>
          </div>
        </template>
        <div v-else class="empty-state">
          <h2>项目不存在</h2>
          <button class="button secondary" @click="navigate('projects')">返回流水线</button>
        </div>
      </main>
      <footer class="app-footer">
        <span>Flow Lite</span>
        <span>让项目交付更简单</span>
      </footer>
    </div>
  </div>

  <ToastNotice :notification="toast" @dismiss="toast = null" />

  <BaseModal
    :open="Boolean(modal)"
    :title="modal === 'project' ? (editingId ? '编辑流水线' : '新建流水线') : '添加连接凭据'"
    :label="modal === 'project' ? '流水线配置' : '添加凭据'"
    :icon="modal === 'project' ? Workflow : KeyRound"
    :variant="modal || 'project'"
    :busy="Boolean(busy)"
    @close="modal = null"
  >
    <template #badge>
      <span v-if="modal === 'project' && form.type !== 'command'" class="node-badge">
        <span class="node-hex">N</span>
        Node.js
      </span>
      <span v-else-if="modal === 'project'" class="command-badge">
        <Terminal :size="12" />
        PHP / 命令
      </span>
    </template>
    <ProjectForm
      v-if="modal === 'project'"
      v-model="form"
      :editing="Boolean(editingId)"
      :node-versions="nodeVersions"
      :credentials="credentials"
      :groups="groups"
      :busy="busy"
      :form-error="formError"
      @submit="saveProject"
      @cancel="modal = null"
    />
    <CredentialForm
      v-else
      v-model="credentialForm"
      :busy="busy"
      :form-error="formError"
      @submit="saveCredential"
      @cancel="modal = null"
    />
  </BaseModal>

  <RunDetailDrawer
    :run="detailRun"
    :log-text="logText"
    :connected="logConnected"
    :busy="busy"
    :elapsed="duration(detailRun)"
    @close="closeRun"
    @cancel="cancelRun"
    @retry="retryRun"
    @copy="copyLog"
  />

  <ConfirmDialog
    :confirmation="confirmation"
    :busy="busy === 'confirm'"
    :locked="Boolean(busy)"
    @cancel="confirmation = null"
    @confirm="confirmAction"
  />
</template>
