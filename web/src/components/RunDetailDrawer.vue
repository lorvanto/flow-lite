<script setup>
import { nextTick, ref, watch } from 'vue';
import {
  ArrowDownToLine,
  Box,
  Clock3,
  Copy,
  Folder,
  GitBranch,
  Globe,
  RefreshCw,
  RotateCcw,
  Square,
  Terminal,
  X,
  XCircle,
} from '@lucide/vue';
import { date, executionDirectory } from '../lib/format.js';
import { isCommand, runLabel, stageLabels } from '../lib/pipeline.js';
import PipelineStages from './PipelineStages.vue';
import StatusBadge from './StatusBadge.vue';

const props = defineProps({
  run: { type: Object, default: null },
  logText: { type: String, default: '' },
  connected: { type: Boolean, default: false },
  busy: { type: String, default: '' },
  elapsed: { type: String, default: '—' },
});
defineEmits(['close', 'cancel', 'retry', 'copy']);

const followLog = ref(true);
const logElement = ref(null);

watch(
  () => props.run?.id,
  () => {
    followLog.value = true;
  },
);
watch(
  () => props.logText,
  async () => {
    if (!followLog.value) return;
    await nextTick();
    logElement.value?.scrollTo({ top: logElement.value.scrollHeight });
  },
);
</script>

<template>
  <div v-if="run" class="drawer-backdrop" @click.self="$emit('close')">
    <section class="run-drawer" role="dialog" aria-modal="true" aria-label="运行详情">
      <header class="drawer-header">
        <div>
          <span class="modal-header-icon"><Terminal :size="21" /></span>
          <strong>运行详情</strong>
          <span class="run-number">#{{ run.number }}</span>
        </div>
        <button class="icon-button" aria-label="关闭运行详情" @click="$emit('close')">
          <X :size="21" />
        </button>
      </header>

      <div class="drawer-main">
        <div class="run-heading">
          <div>
            <h2>{{ run.projectName }}</h2>
            <p>
              {{ runLabel(run) }}
              <span>·</span>
              {{ date(run.createdAt, true) }}
            </p>
          </div>
          <StatusBadge :status="run.status" :size="15" />
        </div>

        <div class="run-metadata">
          <template v-if="!isCommand(run)">
            <span>
              <GitBranch :size="14" />
              {{ run.commitSha?.slice(0, 8) || '等待拉取提交' }}
            </span>
            <span>
              <Box :size="14" />
              Node {{ run.nodeVersion || '待识别' }}
            </span>
          </template>
          <template v-else>
            <span>
              <Terminal :size="14" />
              {{ run.executionHost ? 'SSH · ' + run.executionHost : '命令执行' }}
            </span>
            <span>
              <Folder :size="14" />
              {{ executionDirectory(run) }}
            </span>
          </template>
          <span>
            <Clock3 :size="14" />
            {{ elapsed }}
          </span>
        </div>

        <PipelineStages v-if="run.kind !== 'rollback'" :run="run" />
        <div v-else class="inline-notice">
          <RotateCcw :size="16" />
          使用历史产物发布，跳过依赖安装与构建。
        </div>

        <section v-if="isCommand(run)" class="command-preview">
          <div>
            <Terminal :size="14" />
            <strong>执行命令</strong>
          </div>
          <pre>{{ run.commands || '正在读取命令…' }}</pre>
          <small>命令失败即停止，直接更新执行目录，不提供自动回滚。</small>
        </section>

        <div v-if="run.error" class="error-message run-error" role="alert">
          <XCircle :size="17" />
          <span>{{ run.error }}</span>
        </div>

        <section class="log-panel">
          <div class="log-toolbar">
            <div>
              <Terminal :size="16" />
              <strong>执行日志</strong>
              <span v-if="['queued', 'running'].includes(run.status)" class="log-live">
                <span class="tiny-dot" :class="connected ? 'green' : ''"></span>
                {{ connected ? '实时' : '连接中' }}
              </span>
            </div>
            <div>
              <label class="follow-log">
                <input v-model="followLog" type="checkbox" />
                自动滚动
              </label>
              <button
                class="icon-button"
                title="复制日志"
                aria-label="复制日志"
                @click="$emit('copy')"
              >
                <Copy :size="15" />
              </button>
              <a
                class="icon-button"
                :href="`/api/runs/${run.id}/logs/download`"
                title="下载完整日志"
                aria-label="下载完整日志"
                download
              >
                <ArrowDownToLine :size="16" />
              </a>
            </div>
          </div>
          <pre ref="logElement" class="log-output" tabindex="0">{{
            logText ||
            (run.status === 'queued' ? '任务已加入队列，等待执行器运行…' : '正在读取日志…')
          }}</pre>
        </section>

        <div v-if="run.releasePath" class="release-path">
          <Globe :size="14" />
          <span>{{ isCommand(run) ? '执行目录' : '发布位置' }}</span>
          <code>{{ run.releasePath }}</code>
        </div>
      </div>

      <footer class="drawer-footer">
        <span>
          运行 #{{ run.number }}
          <span class="dot-separator">·</span>
          {{ stageLabels[run.stage] || run.stage }}
        </span>
        <div>
          <button class="button secondary" @click="$emit('close')">关闭</button>
          <button
            v-if="['queued', 'running'].includes(run.status)"
            class="button danger-outline"
            :disabled="busy === 'cancel'"
            @click="$emit('cancel', run)"
          >
            <Square :size="14" />
            取消运行
          </button>
          <button
            v-else-if="run.kind !== 'rollback'"
            class="button primary"
            :disabled="busy === 'retry'"
            @click="$emit('retry', run)"
          >
            <RefreshCw :size="15" />
            重新运行
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>
