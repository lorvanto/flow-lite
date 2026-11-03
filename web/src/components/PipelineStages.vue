<script setup>
import { computed } from 'vue';
import { Check, Circle, Loader2, X } from '@lucide/vue';
import { miniStages, runStages, stageLabels, stageState } from '../lib/pipeline.js';

const props = defineProps({
  run: { type: Object, default: null },
  projectType: { type: String, default: 'node' },
  compact: { type: Boolean, default: false },
});

const steps = computed(() =>
  props.compact ? miniStages({ type: props.projectType }) : runStages(props.run),
);
</script>

<template>
  <div v-if="compact" class="mini-pipeline">
    <template v-for="(stage, index) in steps" :key="stage">
      <span v-if="index" class="mini-line"></span>
      <span class="mini-step" :class="stageState(stage, run)" :title="stageLabels[stage]">
        <Check v-if="stageState(stage, run) === 'completed'" :size="10" />
        <Loader2 v-else-if="stageState(stage, run) === 'active'" :size="10" class="spin" />
        <X v-else-if="stageState(stage, run) === 'failed'" :size="10" />
        <Circle v-else :size="5" />
      </span>
    </template>
  </div>

  <div v-else class="stage-track">
    <template v-for="(stage, index) in steps" :key="stage">
      <span
        v-if="index"
        class="stage-connector"
        :class="{ completed: stageState(stage, run) === 'completed' }"
      ></span>
      <div class="stage-item" :class="stageState(stage, run)">
        <span class="stage-circle">
          <Check v-if="stageState(stage, run) === 'completed'" :size="15" />
          <Loader2 v-else-if="stageState(stage, run) === 'active'" :size="15" class="spin" />
          <X v-else-if="stageState(stage, run) === 'failed'" :size="15" />
          <span v-else>{{ index + 1 }}</span>
        </span>
        <span>{{ stageLabels[stage] }}</span>
      </div>
    </template>
  </div>
</template>
