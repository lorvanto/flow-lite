<script setup>
import { computed } from 'vue';
import { CheckCircle2, Circle, Clock3, Loader2, Square, XCircle } from '@lucide/vue';
import { statusLabels } from '../lib/pipeline.js';

const props = defineProps({
  status: { type: String, required: true },
  size: { type: Number, default: 13 },
});

const icon = computed(
  () =>
    ({
      success: CheckCircle2,
      failed: XCircle,
      running: Loader2,
      queued: Clock3,
      cancelled: Square,
    })[props.status] || Circle,
);
</script>

<template>
  <span class="status-badge" :class="status">
    <component :is="icon" :size="size" :class="{ spin: status === 'running' }" />
    {{ statusLabels[status] }}
  </span>
</template>
