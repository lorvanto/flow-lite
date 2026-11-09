<script setup>
import { computed } from 'vue';
import {
  backendApplications,
  backendApplicationForSource,
  setBackendEnabled,
} from '../lib/multi-build.js';

const form = defineModel({ type: Object, required: true });
const selectedSource = computed(() =>
  form.value.sources.find((source) => source.id === form.value.backend?.sourceId),
);
function changeSource() {
  form.value.backend.application = backendApplicationForSource(selectedSource.value);
}
</script>

<template>
  <div class="form-section">
    <div class="form-section-title">
      <span>API</span>
      <h3>PHP 后端阶段</h3>
    </div>
    <label class="field">
      <span>
        <input
          type="checkbox"
          :checked="!!form.backend?.enabled"
          :disabled="form.deploy.type !== 'ssh' && !form.backend?.enabled"
          @change="setBackendEnabled(form, $event.target.checked)"
        />
        在这条流水线中发布 API
      </span>
    </label>
    <p v-if="form.deploy.type !== 'ssh'" class="backend-help">
      API 阶段需要 SSH 发布目标，请在下方发布配置中选择 SSH。
    </p>
    <template v-if="form.backend?.enabled">
      <div class="form-grid">
        <label class="field">
          PHP 目标版本
          <input value="8.5" readonly aria-label="API PHP 目标版本" />
        </label>
        <label class="field">
          API 代码来源
          <select v-model="form.backend.sourceId" required @change="changeSource">
            <option v-for="source in form.sources" :key="source.id" :value="source.id">
              {{ source.name }}
            </option>
          </select>
        </label>
        <label class="field full-width">
          API 仓库
          <input :value="selectedSource?.repoUrl || ''" readonly aria-label="API 仓库" />
          <small>API 与所有前端任务复用同一个官方业务仓库和本次提交。</small>
        </label>
        <label class="field">
          API 源码目录
          <input value="api" readonly aria-label="API 源码目录" />
        </label>
        <label class="field">
          应用标识
          <select v-model="form.backend.application" required aria-label="API 应用标识">
            <option value="" disabled>请选择对应业务</option>
            <option
              v-for="application in backendApplications"
              :key="application"
              :value="application"
            >
              {{ application }}
            </option>
          </select>
        </label>
      </div>
      <p class="backend-help">
        前端构建、API 打包在 Flow 构建服务器执行，再上传至 SSH 目标并检查 PHP 8.5。API
        发布保留服务器现有的 .env、runtime、uploads 和
        qrcode；不会自动执行数据库迁移。保存目标配置不会升级仓库源码或切换线上 PHP。
      </p>
    </template>
  </div>
</template>

<style scoped>
.backend-help {
  color: var(--text-muted, #7a8ca5);
  font-size: 12px;
  line-height: 1.7;
  margin: 12px 0 0;
}
</style>
