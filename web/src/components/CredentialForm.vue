<script setup>
import { computed } from 'vue';
import { Loader2, ShieldCheck, XCircle } from '@lucide/vue';
import { changeCredentialKind, credentialKind } from '../lib/credentials.js';

const credentialForm = defineModel({ type: Object, required: true });
defineProps({
  busy: { type: String, default: '' },
  formError: { type: String, default: '' },
});
defineEmits(['submit', 'cancel']);

const kind = computed({
  get: () => credentialKind(credentialForm.value),
  set: (value) => changeCredentialKind(credentialForm.value, value),
});
</script>

<template>
  <form class="modal-form" @submit.prevent="$emit('submit')">
    <div class="modal-body">
      <div v-if="formError" class="error-message" role="alert">
        <XCircle :size="16" />
        {{ formError }}
      </div>
      <label class="field">
        <span>
          凭据名称
          <b>*</b>
        </span>
        <input
          v-model="credentialForm.name"
          required
          maxlength="100"
          :placeholder="
            credentialForm.type === 'git-https'
              ? '例如：代码仓库访问凭据'
              : '例如：生产服务器登录凭据'
          "
        />
      </label>
      <label class="field">
        认证方式
        <select v-model="kind">
          <option value="ssh-key">SSH 私钥</option>
          <option value="ssh-password">SSH 密码</option>
          <option value="git-https">Git HTTPS 账号密码</option>
        </select>
      </label>
      <label v-if="credentialForm.type === 'git-https'" class="field">
        <span>仓库账号 <b>*</b></span>
        <input
          v-model.trim="credentialForm.username"
          required
          maxlength="255"
          autocomplete="off"
          placeholder="输入 Git 仓库登录账号"
        />
        <small>账号与密码会加密保存，保存后不会再次展示。</small>
      </label>
      <label v-if="kind === 'ssh-key'" class="field">
        <span>
          SSH 私钥
          <b>*</b>
        </span>
        <textarea
          v-model="credentialForm.privateKey"
          required
          class="mono private-key"
          rows="7"
          spellcheck="false"
          autocomplete="off"
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
        ></textarea>
        <small>粘贴完整私钥。保存后只能使用，无法再次查看。</small>
      </label>
      <label v-else class="field">
        <span>
          {{ credentialForm.type === 'git-https' ? '仓库密码 / 访问令牌' : 'SSH 密码' }}
          <b>*</b>
        </span>
        <input
          v-model="credentialForm.password"
          type="password"
          autocomplete="new-password"
          required
          :maxlength="credentialForm.type === 'git-https' ? 4096 : 1024"
          :placeholder="
            credentialForm.type === 'git-https' ? '输入密码或访问令牌' : '输入 SSH 登录密码'
          "
        />
        <small v-if="credentialForm.type === 'git-https'"
          >GitHub 等平台需要使用访问令牌代替账号密码，请按仓库要求填写。</small
        >
        <small v-else>密码会加密保存，保存后不会再次展示。</small>
      </label>
      <label v-if="credentialForm.type !== 'git-https'" class="field">
        可信主机（known_hosts）
        <textarea
          v-model="credentialForm.knownHosts"
          class="mono"
          rows="4"
          spellcheck="false"
          placeholder="填写已核实的仓库或服务器主机公钥"
        ></textarea>
        <small>留空时使用服务器已有的 known_hosts。首次连接前，请核实目标主机指纹。</small>
      </label>
    </div>
    <footer class="modal-footer">
      <span>
        <ShieldCheck :size="14" />
        凭据加密保存
      </span>
      <div>
        <button type="button" class="button secondary" :disabled="!!busy" @click="$emit('cancel')">
          取消
        </button>
        <button class="button primary" :disabled="busy === 'save-credential'">
          <Loader2 v-if="busy === 'save-credential'" :size="16" class="spin" />
          保存凭据
        </button>
      </div>
    </footer>
  </form>
</template>
