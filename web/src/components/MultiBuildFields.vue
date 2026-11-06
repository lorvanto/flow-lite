<script setup>
import { watch } from 'vue';
import { credentialLabel } from '../lib/format.js';
import { matchesRepository } from '../lib/credentials.js';
import { isAllowedHttpGitRepository } from '../../../shared/repository-policy.mjs';

const form = defineModel({ type: Object, required: true });
const props = defineProps({
  credentials: { type: Array, default: () => [] },
  nodeVersions: { type: Array, default: () => [] },
});
const id = (prefix) => prefix + '-' + crypto.randomUUID().slice(0, 8);
const matches = (source) =>
  props.credentials.filter((credential) => matchesRepository(credential, source.repoUrl));
watch(
  () => [
    form.value.sources.map((source) => [source.repoUrl, source.buildCredentialId]),
    props.credentials,
  ],
  () => {
    for (const source of form.value.sources) {
      const selected = props.credentials.find(
        (credential) => credential.id === source.buildCredentialId,
      );
      if (selected && !matchesRepository(selected, source.repoUrl)) source.buildCredentialId = null;
    }
  },
  { deep: true, immediate: true },
);
function addSource() {
  form.value.sources.push({
    id: id('source'),
    name: `仓库 ${form.value.sources.length + 1}`,
    repoUrl: '',
    branch: 'main',
    buildCredentialId: null,
  });
}
function addTask() {
  const number = form.value.tasks.length + 1;
  form.value.tasks.push({
    id: id('task'),
    name: `任务 ${number}`,
    sourceId: form.value.sources[0].id,
    nodeVersion: '22',
    packageManager: 'npm',
    packageManagerVersion: '',
    workdir: '.',
    installCommand: 'npm ci',
    buildCommand: 'npm run build',
    artifactDir: 'dist',
    publishDir: `app-${number}`,
    environment: {},
    envText: '',
  });
}
function moveTask(index, offset) {
  const task = form.value.tasks.splice(index, 1)[0];
  form.value.tasks.splice(index + offset, 0, task);
}
function changeManager(task) {
  const commands = {
    npm: 'npm ci',
    pnpm: 'pnpm install --frozen-lockfile',
    yarn: 'yarn install --frozen-lockfile',
  };
  if (Object.values(commands).includes(task.installCommand))
    task.installCommand = commands[task.packageManager];
}
</script>

<template>
  <div class="form-section">
    <div class="form-section-title">
      <span>02</span>
      <h3>代码来源</h3>
    </div>
    <p class="multi-help">
      一个代码源可供多个任务复用，每次运行只拉取一次。不同仓库分别选择分支和凭据。
    </p>
    <section v-for="(source, index) in form.sources" :key="source.id" class="multi-card">
      <div class="multi-card-heading">
        <strong>代码源 {{ index + 1 }}</strong
        ><button
          type="button"
          class="button secondary"
          :disabled="
            form.sources.length === 1 || form.tasks.some((task) => task.sourceId === source.id)
          "
          @click="form.sources.splice(index, 1)"
        >
          移除
        </button>
      </div>
      <div class="form-grid">
        <label class="field"
          >代码源名称<input
            v-model="source.name"
            required
            maxlength="80"
            placeholder="例如：商城仓库"
        /></label>
        <label class="field"
          >分支<input v-model="source.branch" required placeholder="main"
        /></label>
        <label class="field full-width"
          >Git 仓库地址<input
            v-model="source.repoUrl"
            required
            placeholder="HTTPS 或 SSH 仓库地址"
          /><small v-if="isAllowedHttpGitRepository(source.repoUrl.trim())"
            >此 HTTP 仓库需要选择 Git 账号密码凭据。</small
          ></label
        >
        <label class="field full-width"
          >仓库凭据<select
            v-model="source.buildCredentialId"
            :required="isAllowedHttpGitRepository(source.repoUrl.trim())"
          >
            <option :value="null" :disabled="isAllowedHttpGitRepository(source.repoUrl.trim())">
              无需凭据 / 使用服务器现有配置
            </option>
            <option
              v-for="credential in matches(source)"
              :key="credential.id"
              :value="credential.id"
            >
              {{ credentialLabel(credential) }}
            </option>
          </select></label
        >
      </div>
      <small v-if="form.tasks.some((task) => task.sourceId === source.id)" class="multi-help"
        >移除代码源前，请先为关联任务选择其他代码源。</small
      >
    </section>
    <button
      type="button"
      class="button secondary"
      :disabled="form.sources.length >= 8"
      @click="addSource"
    >
      ＋ 添加代码源
    </button>
  </div>
  <div class="form-section">
    <div class="form-section-title">
      <span>03</span>
      <h3>构建任务</h3>
    </div>
    <p class="multi-help">
      按下面的顺序构建；全部成功后，合并为一个版本并统一发布、回滚。多个任务请使用互不包含的发布子目录。
    </p>
    <datalist id="multi-node-versions">
      <option v-for="version in nodeVersions" :key="version" :value="version" />
      <option value="auto" />
    </datalist>
    <section v-for="(task, index) in form.tasks" :key="task.id" class="multi-card">
      <div class="multi-card-heading">
        <strong>任务 {{ index + 1 }} · {{ task.name }}</strong>
        <div>
          <button
            type="button"
            class="button secondary"
            :disabled="index === 0"
            @click="moveTask(index, -1)"
          >
            上移</button
          ><button
            type="button"
            class="button secondary"
            :disabled="index === form.tasks.length - 1"
            @click="moveTask(index, 1)"
          >
            下移</button
          ><button
            type="button"
            class="button secondary"
            :disabled="form.tasks.length === 1"
            @click="form.tasks.splice(index, 1)"
          >
            移除
          </button>
        </div>
      </div>
      <div class="form-grid">
        <label class="field"
          >任务名称<input
            v-model="task.name"
            required
            maxlength="80"
            placeholder="例如：admin、H5、PC"
        /></label>
        <label class="field"
          >代码来源<select v-model="task.sourceId" required>
            <option v-for="source in form.sources" :key="source.id" :value="source.id">
              {{ source.name }}
            </option>
          </select></label
        >
        <label class="field"
          >工作目录<input
            v-model="task.workdir"
            required
            placeholder="例如：admin、mobile、pc 或 ."
        /></label>
        <label class="field"
          >Node.js 版本<input
            v-model="task.nodeVersion"
            required
            list="multi-node-versions"
            placeholder="例如：22.18.0 或 auto"
        /></label>
        <label class="field"
          >包管理器<select v-model="task.packageManager" @change="changeManager(task)">
            <option value="npm">npm</option>
            <option value="pnpm">pnpm</option>
            <option value="yarn">Yarn</option>
          </select></label
        >
        <label class="field"
          >包管理器版本<input
            v-model="task.packageManagerVersion"
            placeholder="留空按项目或默认版本"
        /></label>
        <label class="field full-width"
          >安装依赖命令<textarea
            v-model="task.installCommand"
            required
            rows="2"
            class="mono"
            placeholder="npm ci"
          ></textarea>
        </label>
        <label class="field full-width"
          >构建命令<textarea
            v-model="task.buildCommand"
            required
            rows="2"
            class="mono"
            placeholder="npm run build"
          ></textarea>
        </label>
        <label class="field"
          >产物目录<input
            v-model="task.artifactDir"
            required
            placeholder="dist 或 dist/build/h5"
          /><small>相对于工作目录，需包含 index.html。</small></label
        >
        <label class="field"
          >发布子目录<input
            v-model="task.publishDir"
            required
            placeholder="例如：static/admin、h5、pc"
          /><small>相对于统一版本目录 current；单任务可填 .</small></label
        >
        <label class="field full-width"
          >任务环境变量<textarea
            v-model="task.envText"
            rows="3"
            class="mono"
            spellcheck="false"
            placeholder="VITE_BASE=/h5/"
          ></textarea
          ><small>每行 KEY=value；同名变量覆盖公共构建变量，并加密保存。</small></label
        >
      </div>
    </section>
    <button
      type="button"
      class="button secondary"
      :disabled="form.tasks.length >= 12"
      @click="addTask"
    >
      ＋ 添加构建任务
    </button>
    <div class="form-grid multi-common">
      <label class="field"
        >整条流水线超时（秒）<input
          v-model.number="form.timeoutSeconds"
          type="number"
          min="30"
          max="7200"
          required
      /></label>
      <label class="field full-width"
        >公共构建环境变量<textarea
          v-model="form.envText"
          rows="3"
          class="mono"
          spellcheck="false"
          placeholder="NODE_ENV=production"
        ></textarea
        ><small>应用于每个任务；不会传给 Git 认证过程。</small></label
      >
    </div>
  </div>
</template>

<style scoped>
.multi-help {
  color: var(--text-muted, #7a8ca5);
  font-size: 12px;
  line-height: 1.7;
  margin: 0 0 16px;
}
.multi-card {
  padding: 18px;
  margin: 16px 0;
  border: 1px solid var(--border, #e4ebf4);
  border-radius: 12px;
}
.multi-card-heading {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.multi-card-heading > div {
  display: flex;
  gap: 6px;
}
.multi-card-heading .button {
  padding: 6px 10px;
  font-size: 12px;
}
.multi-common {
  margin-top: 24px;
}
</style>
