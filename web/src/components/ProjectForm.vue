<script setup>
import { computed, ref, watch } from 'vue';
import MultiBuildFields from './MultiBuildFields.vue';
import { enableMultiBuild, setBackendEnabled } from '../lib/multi-build.js';
import {
  Box,
  CheckCircle2,
  Globe,
  Layers,
  Loader2,
  Server,
  ShieldCheck,
  Terminal,
  XCircle,
} from '@lucide/vue';
import { credentialLabel } from '../lib/format.js';
import { matchesRepository } from '../lib/credentials.js';
import { isAllowedHttpGitRepository } from '../../../shared/repository-policy.mjs';

const form = defineModel({ type: Object, required: true });
const props = defineProps({
  editing: { type: Boolean, default: false },
  nodeVersions: { type: Array, required: true },
  credentials: { type: Array, default: () => [] },
  groups: { type: Array, default: () => [] },
  busy: { type: String, default: '' },
  formError: { type: String, default: '' },
});
defineEmits(['submit', 'cancel']);

const repositoryCredentials = computed(() =>
  props.credentials.filter((credential) => matchesRepository(credential, form.value.repoUrl)),
);
const sshCredentials = computed(() =>
  props.credentials.filter((credential) => !credential.type || credential.type === 'ssh'),
);

watch(
  [() => form.value.repoUrl, () => props.credentials],
  () => {
    if (!form.value.buildCredentialId) return;
    const selected = props.credentials.find(
      (credential) => credential.id === form.value.buildCredentialId,
    );
    if (selected && !matchesRepository(selected, form.value.repoUrl))
      form.value.buildCredentialId = null;
  },
  { immediate: true },
);

watch(
  [() => form.value.deploy.credentialId, () => props.credentials],
  () => {
    if (!form.value.deploy.credentialId) return;
    const selected = props.credentials.find(
      (credential) => credential.id === form.value.deploy.credentialId,
    );
    if (selected && selected.type && selected.type !== 'ssh') form.value.deploy.credentialId = null;
  },
  { immediate: true },
);

const nodeChoice = ref('24');
// Only reset when a different form is opened, not while a custom version is typed.
watch(
  () => form.value,
  (value) => {
    nodeChoice.value = [...props.nodeVersions, 'auto'].includes(value.nodeVersion)
      ? value.nodeVersion
      : 'custom';
  },
  { immediate: true },
);

function changeNode() {
  form.value.nodeVersion = nodeChoice.value === 'custom' ? '' : nodeChoice.value;
}
function selectSingleBuild() {
  if (form.value.backend?.enabled) setBackendEnabled(form.value, false);
  form.value.buildMode = 'single';
}

function changeManager() {
  const defaults = ['npm ci', 'pnpm install --frozen-lockfile', 'yarn install --frozen-lockfile'];
  if (
    [...defaults, 'yarn install --immutable'].includes(form.value.installCommand) ||
    !form.value.installCommand
  ) {
    form.value.installCommand = { npm: defaults[0], pnpm: defaults[1], yarn: defaults[2] }[
      form.value.packageManager
    ];
  }
  form.value.buildCommand = `${form.value.packageManager} run build`;
}
</script>

<template>
  <form class="modal-form" @submit.prevent="$emit('submit')">
    <div class="modal-body">
      <div v-if="formError" class="error-message" role="alert">
        <XCircle :size="17" />
        {{ formError }}
      </div>
      <div class="project-type-selector" aria-label="流水线类型">
        <button
          type="button"
          :class="{ active: form.type !== 'command' }"
          @click="form.type = 'node'"
        >
          <Box :size="20" />
          <span>
            <strong>{{
              form.backend?.enabled ? '前端与 API 构建发布' : 'Node.js 静态构建'
            }}</strong>
            <small>拉取代码、构建产物并发布</small>
          </span>
          <CheckCircle2 v-if="form.type !== 'command'" :size="16" />
        </button>
        <button
          type="button"
          :class="{ active: form.type === 'command' }"
          @click="form.type = 'command'"
        >
          <Terminal :size="20" />
          <span>
            <strong>PHP / 命令发布</strong>
            <small>在现有项目目录执行命令</small>
          </span>
          <CheckCircle2 v-if="form.type === 'command'" :size="16" />
        </button>
      </div>
      <div class="form-section">
        <div class="form-section-title">
          <span>01</span>
          <h3>基本信息</h3>
        </div>
        <div class="form-grid">
          <label class="field">
            <span>
              流水线名称
              <b>*</b>
            </span>
            <input v-model="form.name" required maxlength="100" placeholder="例如：官网生产环境" />
          </label>
          <label class="field">
            项目分组
            <input
              v-model="form.group"
              list="project-groups"
              maxlength="60"
              placeholder="例如：客户网站"
            />
            <datalist id="project-groups">
              <option v-for="item in groups" :key="item" :value="item" />
            </datalist>
          </label>
          <label class="field full-width">
            描述
            <input
              v-model="form.description"
              maxlength="300"
              placeholder="简单描述这个项目（可选）"
            />
          </label>
        </div>
      </div>
      <div v-if="form.type !== 'command'" class="form-section">
        <div class="segmented-control" aria-label="构建模式">
          <button
            type="button"
            :class="{ active: form.buildMode !== 'multi' }"
            @click="selectSingleBuild"
          >
            单任务构建
          </button>
          <button
            type="button"
            :class="{ active: form.buildMode === 'multi' }"
            @click="enableMultiBuild(form)"
          >
            多任务构建
          </button>
        </div>
        <small>多任务可构建 admin、H5、PC，并为同一业务配置 PHP 8.5 API 阶段。</small>
      </div>
      <MultiBuildFields
        v-if="form.type !== 'command' && form.buildMode === 'multi'"
        v-model="form"
        :credentials="credentials"
        :node-versions="nodeVersions"
      />
      <div v-if="form.type !== 'command' && form.buildMode !== 'multi'" class="form-section">
        <div class="form-section-title">
          <span>02</span>
          <h3>代码来源</h3>
        </div>
        <div class="form-grid">
          <label class="field full-width">
            <span>
              Git 仓库地址
              <b>*</b>
            </span>
            <input
              v-model="form.repoUrl"
              required
              placeholder="git@github.com:team/project.git 或 HTTPS 地址"
            />
            <small>HTTPS 或 SSH 地址可选择对应仓库凭据，请勿在地址中填写密码或令牌。</small>
            <small v-if="isAllowedHttpGitRepository(form.repoUrl.trim())">
              此仓库使用 HTTP，传输未加密。请选择 Git 账号密码凭据，仅连接已批准的仓库地址。
            </small>
          </label>
          <label class="field">
            <span>
              构建分支
              <b>*</b>
            </span>
            <input v-model="form.branch" required placeholder="main" />
          </label>
          <label class="field">
            仓库凭据
            <select
              v-model="form.buildCredentialId"
              aria-label="仓库凭据"
              :required="isAllowedHttpGitRepository(form.repoUrl.trim())"
            >
              <option :value="null" :disabled="isAllowedHttpGitRepository(form.repoUrl.trim())">
                无需凭据 / 使用服务器现有配置
              </option>
              <option
                v-for="credential in repositoryCredentials"
                :key="credential.id"
                :value="credential.id"
              >
                {{ credentialLabel(credential) }}
              </option>
            </select>
          </label>
        </div>
      </div>
      <div v-if="form.type !== 'command' && form.buildMode !== 'multi'" class="form-section">
        <div class="form-section-title">
          <span>03</span>
          <h3>构建配置</h3>
          <span class="section-caption">每个项目独立选择 Node.js 版本</span>
        </div>
        <div class="form-grid">
          <label class="field">
            <span>
              Node.js 版本
              <b>*</b>
            </span>
            <select v-model="nodeChoice" @change="changeNode">
              <option v-for="version in nodeVersions" :key="version" :value="version">
                Node.js {{ version }}
              </option>
              <option value="auto">自动识别 .nvmrc / .node-version</option>
              <option value="custom">指定其他版本</option>
            </select>
            <small>安装依赖与构建使用同一个 Node.js 环境。</small>
          </label>
          <label v-if="nodeChoice === 'custom'" class="field">
            指定版本
            <b>*</b>
            <input
              v-model="form.nodeVersion"
              required
              pattern="[0-9]{1,2}(\.[0-9]{1,3}\.[0-9]{1,3})?"
              placeholder="例如：22.14.0"
            />
          </label>
          <label class="field">
            包管理器
            <select v-model="form.packageManager" @change="changeManager">
              <option value="npm">npm</option>
              <option value="pnpm">pnpm</option>
              <option value="yarn">Yarn</option>
            </select>
          </label>
          <label class="field">
            包管理器版本
            <input v-model="form.packageManagerVersion" placeholder="留空则按项目配置或默认版本" />
            <small>可从 package.json 的 packageManager 字段读取。</small>
          </label>
          <label class="field">
            项目工作目录
            <input v-model="form.workdir" required placeholder="." />
            <small>相对于仓库根目录，单项目一般为 .</small>
          </label>
          <label class="field">
            <span>
              安装依赖命令
              <b>*</b>
            </span>
            <input v-model="form.installCommand" required class="mono" placeholder="npm ci" />
            <small>可按项目调整；Yarn 2+ 项目可使用 yarn install --immutable。</small>
          </label>
          <label class="field">
            <span>
              构建命令
              <b>*</b>
            </span>
            <input v-model="form.buildCommand" required class="mono" placeholder="npm run build" />
          </label>
          <label class="field">
            <span>
              构建产物目录
              <b>*</b>
            </span>
            <input v-model="form.artifactDir" required placeholder="dist" />
            <small>相对于工作目录，应包含 index.html。</small>
          </label>
          <label class="field">
            执行超时（秒）
            <input
              v-model.number="form.timeoutSeconds"
              type="number"
              min="30"
              max="7200"
              required
            />
          </label>
          <label class="field full-width">
            构建环境变量
            <textarea
              v-model="form.envText"
              rows="3"
              class="mono"
              spellcheck="false"
              placeholder="VITE_API_URL=https://api.example.com&#10;VITE_APP_TITLE=我的网站"
            ></textarea>
            <small>每行一个 KEY=value。变量会在构建时注入，并加密保存在服务器上。</small>
          </label>
        </div>
      </div>
      <div v-if="form.type === 'command'" class="form-section">
        <div class="form-section-title">
          <span>02</span>
          <h3>执行命令</h3>
        </div>
        <div class="form-grid">
          <label class="field full-width">
            <span>
              发布命令
              <b>*</b>
            </span>
            <textarea
              v-model="form.commands"
              required
              rows="7"
              class="mono command-editor"
              spellcheck="false"
              placeholder="git pull --ff-only&#10;# 可按需追加清理缓存等操作"
            ></textarea>
            <small>
              命令按顺序执行，任意命令失败即停止。使用目标服务器已有的 Git、PHP 等工具。
            </small>
          </label>
          <label class="field">
            执行超时（秒）
            <input
              v-model.number="form.timeoutSeconds"
              type="number"
              min="30"
              max="7200"
              required
            />
          </label>
          <label class="field full-width">
            执行环境变量
            <textarea
              v-model="form.envText"
              rows="3"
              class="mono"
              spellcheck="false"
              placeholder="APP_ENV=production"
            ></textarea>
            <small>每行一个 KEY=value，变量会在执行命令时注入，并加密保存。</small>
          </label>
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-title">
          <span>{{ form.type === 'command' ? '03' : '04' }}</span>
          <h3>{{ form.type === 'command' ? '执行位置' : '发布配置' }}</h3>
        </div>
        <div class="segmented-control">
          <button
            type="button"
            :class="{ active: form.deploy.type === 'local' }"
            @click="form.deploy.type = 'local'"
          >
            <Server :size="16" />
            {{ form.type === 'command' ? '本机执行' : '发布到本机' }}
          </button>
          <button
            type="button"
            :class="{ active: form.deploy.type === 'ssh' }"
            @click="form.deploy.type = 'ssh'"
          >
            <Globe :size="16" />
            {{ form.type === 'command' ? 'SSH 远程执行' : 'SSH 远程发布' }}
          </button>
        </div>
        <div class="form-grid">
          <template v-if="form.deploy.type === 'ssh'">
            <label class="field">
              <span>
                服务器地址
                <b>*</b>
              </span>
              <input v-model="form.deploy.host" required placeholder="服务器 IP 或域名" />
            </label>
            <label class="field">
              <span>
                SSH 端口
                <b>*</b>
              </span>
              <input v-model.number="form.deploy.port" type="number" min="1" max="65535" required />
            </label>
            <label class="field">
              <span>
                SSH 用户
                <b>*</b>
              </span>
              <input v-model="form.deploy.user" required placeholder="root 或 deploy" />
              <small>可填写 root；使用密码时，请先在凭据管理中添加 SSH 密码凭据。</small>
            </label>
            <label class="field">
              部署 SSH 凭据
              <select v-model="form.deploy.credentialId" required aria-label="部署 SSH 凭据">
                <option :value="null" disabled>请选择 SSH 部署凭据</option>
                <option
                  v-for="credential in sshCredentials"
                  :key="credential.id"
                  :value="credential.id"
                >
                  {{ credentialLabel(credential) }}
                </option>
              </select>
            </label>
          </template>
          <label class="field full-width">
            <span>
              {{ form.type === 'command' ? '执行目录' : '网站发布根目录' }}
              <b>*</b>
            </span>
            <input v-model="form.deploy.root" required placeholder="/www/wwwroot/example.com" />
            <small>
              {{
                form.type === 'command'
                  ? '填写已存在的项目目录，命令将在此目录内直接执行。'
                  : '网站服务目录应指向该目录下的 current，发布版本保存在 releases 中。'
              }}
            </small>
          </label>
          <label v-if="form.type !== 'command'" class="field">
            保留构建版本数
            <input v-model.number="form.retainReleases" type="number" required min="1" max="30" />
            <small>{{
              form.backend?.enabled
                ? '保留代码产物用于回滚；数据库、环境配置和上传数据单独保留。'
                : '保留的产物可用于后续回滚。'
            }}</small>
          </label>
        </div>
        <div v-if="form.type === 'command'" class="inline-notice">
          <Terminal :size="16" />
          命令直接更新现有目录，请确保目标机已安装所需工具。命令执行不提供自动回滚。
        </div>
        <div v-else class="inline-notice">
          <Layers :size="16" />
          {{
            form.backend?.enabled
              ? '前端与 API 均检查成功后发布。代码回滚不会回退数据库、环境配置或上传数据。'
              : '每次成功构建生成独立版本，上传完成后再切换网站。'
          }}
        </div>
      </div>
    </div>
    <footer class="modal-footer">
      <span>
        <ShieldCheck :size="14" />
        凭据与环境变量加密保存
      </span>
      <div>
        <button type="button" class="button secondary" :disabled="!!busy" @click="$emit('cancel')">
          取消
        </button>
        <button class="button primary" :disabled="busy === 'save-project'">
          <Loader2 v-if="busy === 'save-project'" :size="16" class="spin" />
          {{ editing ? '保存配置' : '创建流水线' }}
        </button>
      </div>
    </footer>
  </form>
</template>
