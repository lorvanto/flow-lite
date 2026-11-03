<script setup>
import { Loader2, RotateCcw, Trash2 } from '@lucide/vue';

defineProps({
  confirmation: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  locked: { type: Boolean, default: false },
});
defineEmits(['cancel', 'confirm']);
</script>

<template>
  <div
    v-if="confirmation"
    class="modal-backdrop confirmation-backdrop"
    @click.self="!locked && $emit('cancel')"
  >
    <section
      class="confirm-modal"
      role="alertdialog"
      aria-modal="true"
      :aria-label="confirmation.title"
    >
      <span class="confirm-icon" :class="{ danger: confirmation.danger }">
        <Trash2 v-if="confirmation.danger" :size="25" />
        <RotateCcw v-else :size="25" />
      </span>
      <h2>{{ confirmation.title }}</h2>
      <p>{{ confirmation.description }}</p>
      <div>
        <button class="button secondary" :disabled="busy" @click="$emit('cancel')">取消</button>
        <button
          class="button"
          :class="confirmation.danger ? 'danger' : 'primary'"
          :disabled="busy"
          @click="$emit('confirm')"
        >
          <Loader2 v-if="busy" :size="15" class="spin" />
          {{ confirmation.label }}
        </button>
      </div>
    </section>
  </div>
</template>
