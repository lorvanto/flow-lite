<script setup>
import { CheckCircle2, X, XCircle } from '@lucide/vue';

defineProps({ notification: { type: Object, default: null } });
defineEmits(['dismiss']);
</script>

<template>
  <Transition name="fade">
    <div v-if="notification" class="toast" :class="notification.type" role="status">
      <component :is="notification.type === 'error' ? XCircle : CheckCircle2" :size="18" />
      <span>{{ notification.message }}</span>
      <button class="icon-button" aria-label="关闭提示" @click="$emit('dismiss')">
        <X :size="15" />
      </button>
    </div>
  </Transition>
</template>
