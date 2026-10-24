<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { createWsRoute, updateWsRoute } from '../api';
import type { NotifyFn, PolyMockMode, Route, RouteAuth, ServiceInfo, WsBehavior } from '../types';
import { serviceDisplaySuffix, wsUrl } from '../utils';

const props = defineProps<{
  services: ServiceInfo[];
  editing: Route | null;
  mode: PolyMockMode;
  /** 主端口：路径模式 / 默认服务的地址预览用它拼接 */
  mainPort: number;
  notify: NotifyFn;
}>();

const emit = defineEmits<{
  /** 保存成功后触发（App 层负责刷新与关抽屉） */
  changed: [];
  'cancel-edit': [];
}>();

/** 文本草稿 → 消息体：合法 JSON 解析为值（发送时深度渲染），否则原样字符串（发送时文本渲染）。
 *  与后端语义一致：任意非空文本都是合法消息体，不做 JSON 强校验 */
function parseBodyText(text: string): unknown {
  const raw = text.trim();
  if (!raw) return '';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/* ---------- 基本信息草稿 ---------- */

const serviceId = ref('');
const name = ref('');
const path = ref('/ws/');

/* ---------- 握手与准入草稿 ---------- */

const authType = ref<'none' | 'apikey' | 'bearer'>('none');
const authValue = ref('');
const authHeader = ref('');

/* ---------- onOpen 草稿 ---------- */

interface OnOpenDraft {
  delayMs: number | '';
  body: string;
}

const onOpenDrafts = ref<OnOpenDraft[]>([]);
const loopOnOpen = ref(false);

function addOnOpenRow() {
  onOpenDrafts.value.push({ delayMs: onOpenDrafts.value.length > 0 ? 500 : 0, body: '{"type":"custom"}' });
}

function removeOnOpenRow(index: number) {
  onOpenDrafts.value.splice(index, 1);
}

/** onOpen 延迟毫秒草稿校验：留空按 0 处理，填写时须为 0-60000 整数 */
function delayMsValid(value: number | ''): boolean {
  if (value === '') return true;
  return Number.isInteger(value) && value >= 0 && value <= 60000;
}

/* ---------- onMessage 草稿 ---------- */

const replyMode = ref<'echo' | 'fixed' | 'sequence' | 'none'>('echo');
/** fixed / sequence 的回包内容：每行一条（JSON 或纯文本） */
const repliesDraft = ref('');

/* ---------- interval 草稿 ---------- */

const intervalEnabled = ref(false);
const intervalEveryMs = ref<number | ''>(5000);
const intervalBody = ref('{"type":"tick","ts":"{{$now}}"}');

/* ---------- 通用 ---------- */

const disabled = ref(false);
const saving = ref(false);

/** 地址预览：端口模式用服务端口（默认服务即主端口），路径模式统一主端口 + basePath 前缀 */
const urlPreview = computed(() => {
  const svc = props.services.find((s) => s.id === serviceId.value);
  const prefix = props.mode === 'path' && svc && !svc.isDefault ? `/${svc.basePath ?? ''}` : '';
  const port = props.mode === 'path' || svc?.isDefault ? props.mainPort : svc?.port ?? props.mainPort;
  return wsUrl(port, `${prefix}${path.value || '/'}`);
});

const repliesInvalid = computed(() => {
  if (replyMode.value !== 'fixed' && replyMode.value !== 'sequence') return false;
  const lines = repliesDraft.value.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length === 0;
});

const formInvalid = computed(() => {
  if (!name.value.trim() || !path.value.startsWith('/')) return true;
  if (authType.value !== 'none' && !authValue.value.trim()) return true;
  if (onOpenDrafts.value.some((row) => !delayMsValid(row.delayMs))) return true;
  if ((replyMode.value === 'fixed' || replyMode.value === 'sequence') && repliesInvalid.value) return true;
  if (intervalEnabled.value) {
    const every = Number(intervalEveryMs.value);
    if (!Number.isInteger(every) || every < 100 || every > 60000) return true;
  }
  return false;
});

/* ---------- 编辑回填 ---------- */

watch(
  () => props.editing,
  (route) => {
    if (route) {
      serviceId.value = route.serviceId;
      name.value = route.name ?? '';
      path.value = route.path;
      authType.value = route.auth?.type ?? 'none';
      authValue.value = route.auth?.value ?? '';
      authHeader.value = route.auth?.header ?? '';
      onOpenDrafts.value = (route.ws?.onOpen ?? []).map((message) => ({
        delayMs: message.delayMs ?? 0,
        body: typeof message.body === 'string' ? message.body : JSON.stringify(message.body, null, 2),
      }));
      loopOnOpen.value = route.ws?.loopOnOpen === true;
      replyMode.value = route.ws?.onMessage?.mode ?? 'none';
      const replies = route.ws?.onMessage?.replies ?? [];
      repliesDraft.value = replies.map((reply) => (typeof reply === 'string' ? reply : JSON.stringify(reply))).join('\n');
      intervalEnabled.value = route.ws?.interval !== undefined;
      intervalEveryMs.value = route.ws?.interval?.everyMs ?? 5000;
      intervalBody.value = route.ws?.interval
        ? (typeof route.ws.interval.body === 'string' ? route.ws.interval.body : JSON.stringify(route.ws.interval.body, null, 2))
        : '{"type":"tick","ts":"{{$now}}"}';
      disabled.value = route.disabled === true;
    } else {
      serviceId.value = props.services[0]?.id ?? '';
      name.value = '';
      path.value = '/ws/';
      authType.value = 'none';
      authValue.value = '';
      authHeader.value = '';
      onOpenDrafts.value = [{ delayMs: 0, body: '{"type":"welcome","ts":"{{$now}}"}' }];
      loopOnOpen.value = false;
      replyMode.value = 'echo';
      repliesDraft.value = '{"type":"ack","ts":"{{$now}}"}';
      intervalEnabled.value = false;
      intervalEveryMs.value = 5000;
      intervalBody.value = '{"type":"tick","ts":"{{$now}}"}';
      disabled.value = false;
    }
  },
  { immediate: true },
);

/* ---------- 提交 ---------- */

function buildAuthPayload(): RouteAuth | null {
  if (authType.value === 'none' || !authValue.value.trim()) return null;
  return {
    type: authType.value,
    value: authValue.value.trim(),
    ...(authType.value === 'apikey' && authHeader.value.trim() ? { header: authHeader.value.trim() } : {}),
  };
}

function buildWsPayload(): WsBehavior {
  const behavior: WsBehavior = {};
  const onOpen = onOpenDrafts.value
    .filter((row) => row.body.trim() !== '')
    .map((row) => {
      const delayMs = Number(row.delayMs) || 0;
      return { body: parseBodyText(row.body), ...(delayMs > 0 ? { delayMs } : {}) };
    });
  if (onOpen.length > 0) {
    behavior.onOpen = onOpen;
    if (loopOnOpen.value) behavior.loopOnOpen = true;
  }
  if (replyMode.value === 'fixed' || replyMode.value === 'sequence') {
    const replies = repliesDraft.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseBodyText(line));
    if (replies.length > 0) behavior.onMessage = { mode: replyMode.value, replies };
  } else if (replyMode.value === 'echo') {
    behavior.onMessage = { mode: 'echo' };
  } else if (replyMode.value === 'none') {
    behavior.onMessage = { mode: 'none' };
  }
  if (intervalEnabled.value) {
    const everyMs = Number(intervalEveryMs.value);
    if (Number.isInteger(everyMs) && everyMs >= 100) {
      behavior.interval = { everyMs, body: parseBodyText(intervalBody.value) };
    }
  }
  return behavior;
}

async function submit() {
  if (formInvalid.value) {
    props.notify('请检查表单：名称 / 路径 / 认证令牌 / 回包内容 / 定时间隔均有格式要求', 'err');
    return;
  }
  saving.value = true;
  try {
    const auth = buildAuthPayload();
    if (props.editing) {
      await updateWsRoute(props.editing.id, {
        serviceId: serviceId.value,
        name: name.value.trim(),
        path: path.value.trim(),
        auth,
        disabled: disabled.value,
        ws: buildWsPayload(),
      });
      props.notify(`已保存 WS 接口 ${name.value.trim()}`);
    } else {
      const payload = {
        protocol: 'ws' as const,
        serviceId: serviceId.value,
        name: name.value.trim(),
        path: path.value.trim(),
        disabled: disabled.value,
        ws: buildWsPayload(),
      };
      await createWsRoute(auth ? { ...payload, auth } : payload);
      props.notify(`已新增 WS 接口 ${name.value.trim()}`);
    }
    emit('changed');
  } catch (err) {
    props.notify((err as Error).message, 'err');
  } finally {
    saving.value = false;
  }
}

/* 服务展示（下拉项）：端口模式带端口，路径模式带前缀 */
function serviceLabel(svc: ServiceInfo): string {
  return `${svc.name}（${serviceDisplaySuffix(svc, props.mode)}）`;
}
</script>

<template>
  <section class="form-panel">
    <div class="panel-head">
      <h2 class="drawer-title">{{ editing ? '编辑 WS 接口' : '新增 WS 接口' }}</h2>
      <button type="button" class="drawer-close" title="关闭" aria-label="关闭 WS 接口表单" @click="emit('cancel-edit')">×</button>
    </div>
    <form id="ws-form" autocomplete="off" @submit.prevent="submit">
      <div class="grid-2">
        <div class="field">
          <label for="f-ws-service">所属服务</label>
          <select id="f-ws-service" v-model="serviceId">
            <option v-for="svc in services" :key="svc.id" :value="svc.id">{{ serviceLabel(svc) }}</option>
          </select>
        </div>
        <div class="field">
          <label for="f-ws-name">名称</label>
          <input id="f-ws-name" v-model="name" type="text" placeholder="如 订单状态推送" spellcheck="false">
        </div>
      </div>
      <div class="field">
        <label for="f-ws-path">连接路径</label>
        <input id="f-ws-path" v-model="path" type="text" placeholder="/ws/orders" spellcheck="false">
        <div class="hint">支持 <code>:param</code> 路径段；query 与路径参数都可用于消息模板。method 固定为 WS，可与同路径的 HTTP 接口共存。</div>
      </div>
      <div class="url-preview">{{ urlPreview }}</div>

      <div class="form-section">
        <div class="label-row"><label>握手与准入</label></div>
        <div class="grid-2">
          <div class="field">
            <label for="f-ws-auth-type">认证方式</label>
            <select id="f-ws-auth-type" v-model="authType">
              <option value="none">不校验</option>
              <option value="bearer">Bearer</option>
              <option value="apikey">APIKey</option>
            </select>
          </div>
          <div v-if="authType !== 'none'" class="field">
            <label for="f-ws-auth-value">{{ authType === 'apikey' ? '期望的 Key 值' : '期望令牌' }}</label>
            <input id="f-ws-auth-value" v-model="authValue" type="text" placeholder="如 dev-token" spellcheck="false">
          </div>
        </div>
        <div v-if="authType === 'apikey'" class="field">
          <label for="f-ws-auth-header">请求头名称</label>
          <input id="f-ws-auth-header" v-model="authHeader" type="text" placeholder="缺省 X-API-Key" spellcheck="false">
        </div>
        <div class="hint">认证失败 → 401 并关闭；路径未注册 / 已停用 → 404 并关闭。两者都不会落到 Express 的 HTTP Mock 分发。</div>
      </div>

      <div class="form-section">
        <div class="label-row">
          <label>① 连接后推送（onOpen）</label>
          <button type="button" class="mini-btn" @click="addOnOpenRow">＋ 添加一条</button>
        </div>
        <div class="onopen-list">
          <div v-for="(row, i) in onOpenDrafts" :key="`step-${i}`" class="onopen-row">
            <input
              v-model.number="row.delayMs"
              type="number"
              min="0"
              max="60000"
              :title="`连接成功后延迟毫秒（第 ${i + 1} 条，0-60000）`"
              aria-label="延迟毫秒"
            >
            <textarea
              v-model="row.body"
              rows="2"
              spellcheck="false"
              :aria-label="`第 ${i + 1} 条推送内容`"
            ></textarea>
            <button type="button" class="route-remove" :title="`删除第 ${i + 1} 条`" :aria-label="`删除第 ${i + 1} 条推送`" @click="removeOnOpenRow(i)">×</button>
          </div>
          <p v-if="onOpenDrafts.length === 0" class="hint">暂无推送步骤，连接建立后不会有任何消息。</p>
        </div>
        <div class="hint">内容可以是 JSON 或任意文本（纯文本原样发送，JSON 解析后深度渲染），支持与响应模板同一套占位符。</div>
        <label class="switch-row switch-row-plain">
          <span class="switch-title">循环播放整个开场序列</span>
          <input v-model="loopOnOpen" type="checkbox" class="switch-input">
          <span class="switch-ui" aria-hidden="true"></span>
        </label>
      </div>

      <div class="form-section">
        <div class="label-row"><label>② 收到消息时（onMessage）</label></div>
        <div class="field">
          <label for="f-ws-reply-mode">回包策略</label>
          <select id="f-ws-reply-mode" v-model="replyMode">
            <option value="echo">原样回显（echo）</option>
            <option value="fixed">固定回包</option>
            <option value="sequence">按序循环回包</option>
            <option value="none">不回包</option>
          </select>
        </div>
        <div v-if="replyMode === 'fixed' || replyMode === 'sequence'" class="field">
          <label for="f-ws-replies">固定 / 循环回包内容（每行一条）</label>
          <textarea
            id="f-ws-replies"
            v-model="repliesDraft"
            rows="3"
            spellcheck="false"
            :class="{ invalid: repliesInvalid }"
          ></textarea>
          <div v-if="repliesInvalid" class="field-error">固定 / 按序回包至少需要一行内容</div>
        </div>
        <div class="hint">第一版不做「按消息内容条件匹配」：那会引入第二套匹配引擎，且无法复用现有 query / header / body 条件语义。</div>
      </div>

      <div class="form-section">
        <div class="label-row">
          <label>③ 定时推送（interval）</label>
          <label class="switch-row switch-row-plain">
            <span class="switch-title">启用</span>
            <input v-model="intervalEnabled" type="checkbox" class="switch-input">
            <span class="switch-ui" aria-hidden="true"></span>
          </label>
        </div>
        <template v-if="intervalEnabled">
          <div class="grid-2">
            <div class="field">
              <label for="f-ws-interval">间隔毫秒（100-60000）</label>
              <input id="f-ws-interval" v-model.number="intervalEveryMs" type="number" min="100" max="60000" step="100">
            </div>
            <div class="field">
              <label for="f-ws-tick">推送内容</label>
              <input id="f-ws-tick" v-model="intervalBody" type="text" spellcheck="false">
            </div>
          </div>
        </template>
        <div class="hint">连接关闭或路由被编辑 / 删除 / 停用时，定时器一并销毁。</div>
      </div>

      <div class="form-section">
        <label class="switch-row switch-row-plain">
          <span class="switch-title">停用此 WS 接口</span>
          <input v-model="disabled" type="checkbox" class="switch-input">
          <span class="switch-ui" aria-hidden="true"></span>
        </label>
        <div class="inline-note">保存后：该路径的现有连接将以 close code 1012（Service Restart）关闭，由客户端重连拿到新剧本；新握手立即使用新配置。</div>
      </div>

      <div class="form-actions">
        <button type="submit" class="submit-btn" :disabled="saving || formInvalid">
          {{ saving ? '保存中…' : editing ? '保存修改' : '创建 WS 接口' }}
        </button>
        <button type="button" class="cancel-btn" @click="emit('cancel-edit')">取消</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
/* WS 表单：五区块布局（基本 / 握手准入 / onOpen / onMessage / interval / 通用） */
#ws-form {
  padding: 18px;
  display: grid;
  gap: 16px;
}

.form-section {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px;
  display: grid;
  gap: 12px;
  background: var(--bg-soft);
}

.form-section > .label-row label {
  margin-bottom: 0;
  color: var(--text);
  letter-spacing: 1px;
  font-weight: 600;
}

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.onopen-list {
  display: grid;
  gap: 8px;
}

.onopen-row {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr) 28px;
  gap: 8px;
  align-items: start;
}

.onopen-row textarea {
  min-height: 0;
  font-size: 12px;
}

.onopen-row .route-remove {
  margin-top: 2px;
}

/* 区块内的开关行：不使用全局 switch-field 的负边距 */
.switch-row-plain {
  margin-left: 0;
  cursor: pointer;
}

.switch-row-plain .switch-title {
  font-weight: 400;
}

.url-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid rgba(130, 80, 223, 0.35);
  border-radius: 8px;
  background: rgba(130, 80, 223, 0.06);
  font-family: var(--mono);
  font-size: 13px;
  color: #8250df;
  word-break: break-all;
}

.inline-note {
  font-size: 12px;
  color: var(--warn);
}

@media (max-width: 720px) {
  .grid-2 {
    grid-template-columns: 1fr;
  }

  .onopen-row {
    grid-template-columns: 90px minmax(0, 1fr) 28px;
  }
}
</style>
