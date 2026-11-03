<script setup>
import { X } from '@lucide/vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, required: true },
  label: { type: String, default: '' },
  icon: { type: [Object, Function], default: null },
  variant: { type: String, default: 'project' },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(['close']);

function close() {
  if (!props.busy) emit('close');
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="close">
    <section
      class="modal"
      :class="`${variant}-modal`"
      role="dialog"
      aria-modal="true"
      :aria-label="label || title"
    >
      <header class="modal-header">
        <div>
          <span v-if="icon" class="modal-header-icon">
            <component :is="icon" :size="21" />
          </span>
          <h2>{{ title }}</h2>
          <slot name="badge"></slot>
        </div>
        <button class="icon-button" :disabled="busy" aria-label="关闭对话框" @click="close">
          <X :size="20" />
        </button>
      </header>
      <slot></slot>
    </section>
  </div>
</template>
