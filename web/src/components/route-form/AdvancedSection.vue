<script setup lang="ts">
import { computed, toRef } from 'vue';
import type { SceneDraft } from '../../route-form-draft';
import type { CallbackTemplateInfo, NotifyFn } from '../../types';
import { CALLBACK_METHODS } from '../../types';
import { methodColor, parseSequenceDraft } from '../../utils';

const props = defineProps<{
  /** 全部分支草稿（父组件持有；「自定义响应头」「异步回调」块就地修改当前激活场景） */
  scenes: SceneDraft[];
  /** 当前激活场景的 localId（由 BranchesSection 维护，本组件只读） */
  activeId: number;
  editing: boolean;
  /** 一键创建配套路由（仅新建态且开启 CRUD 时非空） */
  companionRoutes: Array<{ key: string; method: string; path: string; name: string }>;
  /** 配套路由勾选状态（父组件持有；本组件就地修改） */
  companionSelection: Record<string, boolean>;
  /** 全局回调模板列表（引用模式下拉；可在「回调管理」视图维护） */
  templates: CallbackTemplateInfo[];
  notify: NotifyFn;
}>();

const advancedOpen = defineModel<boolean>('advancedOpen', { required: true });
const delayMs = defineModel<number | ''>('delayMs', { required: true });
const jitterMs = defineModel<number | ''>('jitterMs', { required: true });
const failureRate = defineModel<number | ''>('failureRate', { required: true });
const authType = defineModel<'none' | 'apikey' | 'bearer'>('authType', { required: true });
const authValue = defineModel<string>('authValue', { required: true });
const authHeader = defineModel<string>('authHeader', { required: true });
const renderRequestFlag = defineModel<boolean>('renderRequestFlag', { required: true });
const crudFlag = defineModel<boolean>('crudFlag', { required: true });
const disabledFlag = defineModel<boolean>('disabledFlag', { required: true });
const sequenceOn = defineModel<boolean>('sequenceOn', { required: true });
const sequenceText = defineModel<string>('sequenceText', { required: true });
const sequenceInvalid = defineModel<boolean>('sequenceInvalid', { required: true });
const customHeadersOn = defineModel<boolean>('customHeadersOn', { required: true });

const scenes = toRef(props, 'scenes');
const activeId = toRef(props, 'activeId');

/* 请求体模板渲染说明（含 {{ }} 字面量，须经 :title 绑定常量，避免被模板插值解析） */
const RENDER_REQUEST_HINT_TITLE =
  '请求体字符串支持：{{query.参数名}} {{header.头名}} {{params.参数名}} {{body.同请求体其他字段}} {{$id}} 自增 {{$now}} 当前时间 {{$int(1,99)}} 随机整数 及 {{$name}} 等假数据；渲染结果参与条件匹配，也会被响应模板的 {{body.*}} 取到。取不到值的占位符原样保留；{{$id}} 与响应共用同一路由自增计数；不含占位符的请求体不受影响。关闭后请求体按客户端原文参与匹配。';

/* 序列响应编辑器的占位示例（JSON 数组，每步 status + body） */
const SEQUENCE_PLACEHOLDER = `[
  { "status": 200, "body": { "mode": "first" } },
  { "status": 500, "body": { "error": "boom" } }
]`;

const activeIndex = computed(() => {
  const idx = scenes.value.findIndex((s) => s.localId === activeId.value);
  return idx === -1 ? 0 : idx;
});

const activeScene = computed(() => scenes.value[activeIndex.value]);

const activeBranchLabel = computed(() => (activeScene.value.localId === 0 ? '默认响应' : activeScene.value.name.trim() || '未命名分支'));

/* ---------- 异步回调 ---------- */

/** 序列 / CRUD 与回调互斥：开启时回调配置不提交（后端同样拒收），此处直接禁用交互并提示 */
const callbackBlocked = computed(() => sequenceOn.value || crudFlag.value);

const callbackDraft = computed(() => activeScene.value.callback);

const callbackMode = computed(() => callbackDraft.value.mode);

const templateOptions = computed(() =>
  props.templates.map((t) => ({
    id: t.id,
    label: `${t.name} · ${t.method ?? 'POST'} ${t.url} · 延迟 ${t.delayMs ?? 1000}ms`,
  })),
);

/** 引用模式未选模板时的兜底：首个模板 */
function onCallbackModeChange(mode: 'template' | 'inline') {
  callbackDraft.value.mode = mode;
  if (mode === 'template' && !callbackDraft.value.templateId && templateOptions.value.length > 0) {
    callbackDraft.value.templateId = templateOptions.value[0].id;
  }
}

function addCallbackHeader() {
  callbackDraft.value.headerRows.push({ key: '', value: '' });
}

function removeCallbackHeader(index: number) {
  callbackDraft.value.headerRows.splice(index, 1);
}

const CALLBACK_HINT_TITLE =
  '回调 URL / 请求头 / 载荷支持与响应模板同一套占位符（上下文为触发命中的原始请求，命中时快照）：{{query.*}} {{header.*}} {{params.*}} {{body.*}} {{$now}} 等。出站受 POLYMOCK_PROXY_ALLOW 白名单约束；10s 超时、不跟随重定向、失败只记日志不重试；出站携带深度头防自环。';

/* ---------- 自定义响应头 ---------- */

function addResponseHeader() {
  activeScene.value.headerRows.push({ key: '', value: '' });
}

function removeResponseHeader(index: number) {
  activeScene.value.headerRows.splice(index, 1);
}

/* ---------- 序列响应草稿校验 ---------- */

/** 序列草稿失焦即时校验：空文本视为未填写不标红；非法只标红（提交时才提示具体错误） */
function validateSequenceText() {
  sequenceInvalid.value = sequenceText.value.trim() ? !parseSequenceDraft(sequenceText.value).ok : false;
}

/** 序列输入过程中仅在标红状态下复检，便于即时消除错误 */
function onSequenceInput() {
  if (sequenceInvalid.value) validateSequenceText();
}
</script>

<template>
  <!-- ========== 高级选项 ========== -->
  <section class="card">
    <div class="card-head">
      <div>
        <div class="card-title">高级选项</div>
        <div class="card-note">故障注入、认证与接口行为控制；默认收起，不干扰主匹配流程。</div>
      </div>
      <button type="button" class="mini-btn" :aria-expanded="advancedOpen" @click="advancedOpen = !advancedOpen">
        {{ advancedOpen ? '收起高级选项 ▴' : '展开高级选项 ▾' }}
      </button>
    </div>

    <div v-show="advancedOpen" class="card-body">
      <div class="advanced-grid">
        <div class="field">
          <label for="f-delay-ms">固定延迟（ms）</label>
          <input id="f-delay-ms" v-model.number="delayMs" type="number" min="0" max="60000" placeholder="留空 = 不延迟">
          <p class="hint">0–60000</p>
        </div>
        <div class="field">
          <label for="f-jitter-ms">随机抖动上限（ms）</label>
          <input id="f-jitter-ms" v-model.number="jitterMs" type="number" min="0" max="60000" placeholder="留空 = 不抖动">
          <p class="hint">实际延迟 = 固定延迟 + 随机值</p>
        </div>
        <div class="field">
          <label for="f-failure-rate">故障注入概率（%）</label>
          <input id="f-failure-rate" v-model.number="failureRate" type="number" min="0" max="100" step="1" placeholder="留空 = 0">
          <p class="hint">命中时返回 HTTP 500</p>
        </div>
        <div class="field">
          <label for="f-auth-type">认证方式</label>
          <select id="f-auth-type" v-model="authType">
            <option value="none">不启用</option>
            <option value="apikey">API Key</option>
            <option value="bearer">Bearer Token</option>
          </select>
          <p class="hint">认证失败独立返回 401</p>
        </div>
      </div>

      <div v-if="authType !== 'none'" class="auth-config">
        <div class="auth-config-head">
          <span class="auth-config-title">{{ authType === 'apikey' ? 'API Key 配置' : 'Bearer Token 配置' }}</span>
          <span class="hint">认证属于接口级前置校验，不随响应分支变化</span>
        </div>
        <div class="auth-fields">
          <div v-if="authType === 'apikey'" class="field">
            <label for="f-auth-header">请求头名称</label>
            <input id="f-auth-header" v-model="authHeader" type="text" placeholder="缺省 X-API-Key" spellcheck="false">
          </div>
          <div class="field">
            <label for="f-auth-value">{{ authType === 'apikey' ? '期望的 Key 值' : 'Token 值' }}</label>
            <input id="f-auth-value" v-model="authValue" type="text" placeholder="如 my-secret-key" spellcheck="false">
            <p class="hint">未携带或错误返回 401</p>
          </div>
          <div v-if="authType === 'bearer'" class="field">
            <label>实际校验方式</label>
            <input type="text" value="Authorization: Bearer <Token>" readonly>
            <p class="hint">请求头名称与 Bearer 前缀固定，避免误填</p>
          </div>
        </div>
      </div>

      <label class="switch-row" for="f-render-request">
        <span class="switch-text">
          <span class="switch-title">渲染请求体模板</span>
          <span class="hint" :title="RENDER_REQUEST_HINT_TITLE">默认开启：请求体里的占位符先展开，展开结果参与条件匹配与响应渲染；不含占位符的请求体不受影响</span>
        </span>
        <input id="f-render-request" v-model="renderRequestFlag" type="checkbox" class="switch-input">
        <span class="switch-ui" aria-hidden="true"></span>
      </label>

      <label class="switch-row" for="f-crud">
        <span class="switch-text">
          <span class="switch-title">有状态 CRUD</span>
          <span class="hint">集合路由（无参数段）：GET=列表、POST=创建；条目路由（含 :id）：GET/PUT/DELETE 存取。开启后响应配置将被忽略，改由内存集合数据响应</span>
        </span>
        <input id="f-crud" v-model="crudFlag" type="checkbox" class="switch-input">
        <span class="switch-ui" aria-hidden="true"></span>
      </label>

      <div v-if="crudFlag && !editing" class="field crud-companions">
        <p class="crud-companions-title">一键创建配套路由</p>
        <p class="hint">以当前路径为 CRUD 集合自动注册其余操作（已排除当前接口），共享同一份数据；更新固定为 PUT（浅合并）</p>
        <label v-for="c in companionRoutes" :key="c.key" class="companion-row">
          <input v-model="companionSelection[c.key]" type="checkbox" class="companion-check">
          <span class="companion-method" :style="{ color: methodColor(c.method) }">{{ c.method }}</span>
          <span class="companion-path">{{ c.path }}</span>
          <span class="companion-name">{{ c.name }}</span>
        </label>
        <p v-if="!companionRoutes.length" class="hint">填写以 / 开头的路径后，这里会列出可一并创建的配套路由</p>
      </div>

      <label v-if="editing" class="switch-row" for="f-disabled">
        <span class="switch-text">
          <span class="switch-title">停用此接口</span>
          <span class="hint">停用后按未注册处理，请求返回 404</span>
        </span>
        <input id="f-disabled" v-model="disabledFlag" type="checkbox" class="switch-input">
        <span class="switch-ui" aria-hidden="true"></span>
      </label>

      <div class="advanced-block">
        <label class="switch-row" for="f-sequence">
          <span class="switch-text">
            <span class="switch-title">序列响应</span>
            <span class="hint">按命中次序依次返回并循环，优先于全局场景集、分支与默认响应</span>
          </span>
          <input id="f-sequence" v-model="sequenceOn" type="checkbox" class="switch-input">
          <span class="switch-ui" aria-hidden="true"></span>
        </label>
        <template v-if="sequenceOn">
          <textarea
            v-model="sequenceText"
            class="sequence-editor"
            rows="5"
            :placeholder="SEQUENCE_PLACEHOLDER"
            spellcheck="false"
            :class="{ invalid: sequenceInvalid }"
            @blur="validateSequenceText"
            @input="onSequenceInput"
          ></textarea>
          <p v-show="sequenceInvalid" class="field-error">序列响应不是合法的 JSON 数组（每步需含数字 status 与 body）</p>
        </template>
      </div>

      <div class="advanced-block">
        <label class="switch-row" for="f-custom-headers">
          <span class="switch-text">
            <span class="switch-title">启用自定义响应头</span>
            <span class="hint">当前分支「{{ activeBranchLabel }}」的响应头；同名多条按多值头返回，值支持模板</span>
          </span>
          <input id="f-custom-headers" v-model="customHeadersOn" type="checkbox" class="switch-input">
          <span class="switch-ui" aria-hidden="true"></span>
        </label>
        <div v-if="customHeadersOn" class="resp-headers">
          <div class="label-row">
            <label>响应头</label>
            <button type="button" class="mini-btn" @click="addResponseHeader">＋ 添加响应头</button>
          </div>
          <div v-for="(row, i) in activeScene.headerRows" :key="i" class="resp-header-row">
            <input v-model="row.key" type="text" placeholder="头名称，如 X-Request-Id" spellcheck="false" :aria-label="`响应头名称 ${i + 1}`">
            <input v-model="row.value" type="text" placeholder="值，如 {{$id}}" spellcheck="false" :aria-label="`响应头值 ${i + 1}`">
            <button type="button" class="rh-del" title="删除该响应头" :aria-label="`删除响应头 ${i + 1}`" @click="removeResponseHeader(i)">×</button>
          </div>
          <p v-if="!activeScene.headerRows.length" class="hint">暂无响应头，点击上方按钮添加</p>
        </div>
      </div>

      <!-- ========== 异步回调（当前分支） ========== -->
      <div class="advanced-block callback-block">
        <label class="switch-row" for="f-callback">
          <span class="switch-text">
            <span class="switch-title">异步回调</span>
            <span class="hint">当前分支「{{ activeBranchLabel }}」命中并响应后，按延迟异步发出一次 HTTP 回调（fire-and-forget，不阻塞响应）</span>
          </span>
          <input id="f-callback" v-model="callbackDraft.on" type="checkbox" class="switch-input">
          <span class="switch-ui" aria-hidden="true"></span>
        </label>

        <div v-if="callbackDraft.on" class="callback-config">
          <p v-if="callbackBlocked" class="field-error">序列响应 / CRUD 与回调互斥：请先关闭上方对应开关，否则回调配置不会提交</p>
          <fieldset class="callback-mode" :disabled="callbackBlocked">
            <div class="callback-mode-row" role="tablist" aria-label="回调配置模式">
              <button
                type="button"
                class="mode-btn"
                :class="{ on: callbackMode === 'template' }"
                @click="onCallbackModeChange('template')"
              >引用模板</button>
              <button
                type="button"
                class="mode-btn"
                :class="{ on: callbackMode === 'inline' }"
                @click="onCallbackModeChange('inline')"
              >内联配置</button>
            </div>

            <template v-if="callbackMode === 'template'">
              <div class="field">
                <label for="f-cb-template">回调模板</label>
                <select v-if="templateOptions.length" id="f-cb-template" v-model="callbackDraft.templateId">
                  <option v-for="t in templateOptions" :key="t.id" :value="t.id">{{ t.label }}</option>
                </select>
                <p v-else class="hint">尚无模板：可先切换「内联配置」，或在「回调管理」视图创建模板</p>
                <p class="hint">信封（URL / 方法 / 头 / 延迟 / 抖动）由模板统一管理，编辑模板将影响所有引用接口；此处仅可覆盖载荷</p>
              </div>
              <div class="field">
                <label for="f-cb-override">载荷覆盖 bodyOverride（可选）</label>
                <textarea
                  id="f-cb-override"
                  v-model="callbackDraft.bodyOverride"
                  rows="5"
                  class="cb-editor"
                  placeholder='留空使用模板默认载荷，如 {"orderNo": "{{body.orderNo}}"}'
                  spellcheck="false"
                ></textarea>
              </div>
            </template>

            <template v-else>
              <div class="field">
                <label for="f-cb-url">回调 URL</label>
                <div class="cb-method-row">
                  <select id="f-cb-method" v-model="callbackDraft.method" aria-label="回调方法">
                    <option v-for="m in CALLBACK_METHODS" :key="m" :value="m">{{ m }}</option>
                  </select>
                  <input
                    id="f-cb-url"
                    v-model="callbackDraft.url"
                    type="text"
                    placeholder="http://127.0.0.1:8080/pay/notify"
                    spellcheck="false"
                  >
                </div>
                <p class="hint">URL 支持模板占位符（写法与响应模板相同，如把 body 里的订单号回填进回调地址）；目标受白名单约束</p>
              </div>
              <div class="cb-grid">
                <div class="field">
                  <label for="f-cb-delay">延迟 ms（0–60000）</label>
                  <input id="f-cb-delay" v-model.number="callbackDraft.delayMs" type="number" min="0" max="60000" placeholder="缺省 1000">
                </div>
                <div class="field">
                  <label for="f-cb-jitter">抖动 ms（0–30000）</label>
                  <input id="f-cb-jitter" v-model.number="callbackDraft.jitterMs" type="number" min="0" max="30000" placeholder="缺省 0">
                </div>
                <div class="field">
                  <label for="f-cb-ct">Content-Type</label>
                  <input id="f-cb-ct" v-model="callbackDraft.contentType" type="text" placeholder="缺省 application/json" spellcheck="false">
                </div>
              </div>
              <div class="field">
                <label for="f-cb-body">回调请求体（模板渲染）</label>
                <textarea
                  id="f-cb-body"
                  v-model="callbackDraft.body"
                  rows="5"
                  class="cb-editor"
                  placeholder='{ "orderNo": "{{body.orderNo}}", "status": "PAID" }'
                  spellcheck="false"
                ></textarea>
              </div>
              <div class="cb-headers">
                <div class="label-row">
                  <label>自定义请求头</label>
                  <button type="button" class="mini-btn" @click="addCallbackHeader">＋ 添加请求头</button>
                </div>
                <div v-for="(row, i) in callbackDraft.headerRows" :key="i" class="resp-header-row">
                  <input v-model="row.key" type="text" placeholder="头名称，如 X-Signature" spellcheck="false" :aria-label="`回调请求头名称 ${i + 1}`">
                  <input v-model="row.value" type="text" placeholder="值，如 {{$uuid}}" spellcheck="false" :aria-label="`回调请求头值 ${i + 1}`">
                  <button type="button" class="rh-del" title="删除该请求头" :aria-label="`删除回调请求头 ${i + 1}`" @click="removeCallbackHeader(i)">×</button>
                </div>
                <p v-if="!callbackDraft.headerRows.length" class="hint">暂无请求头；Content-Type 由上方字段管理</p>
              </div>
            </template>

            <p class="hint" :title="CALLBACK_HINT_TITLE">上下文为触发命中的原始请求（命中时快照）；出站受白名单约束、10s 超时、失败只记日志不重试，携带深度头防自环</p>
          </fieldset>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped src="./section-card.css"></style>

<style scoped>
/* ---------- 高级选项 ---------- */
.advanced-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.advanced-block {
  display: grid;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
}

.auth-config {
  display: grid;
  gap: 9px;
  padding: 12px;
  border: 1px solid rgba(40, 104, 178, 0.25);
  border-radius: 8px;
  background: rgba(40, 104, 178, 0.08);
}

.auth-config-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.auth-config-title {
  color: #2868b2;
  font-size: 12px;
  font-weight: 700;
}

.auth-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.sequence-editor {
  min-height: 96px;
  font-size: 12px;
  line-height: 1.55;
}

/* ---------- 自定义响应头 ---------- */
.resp-headers {
  display: grid;
  gap: 6px;
}

.resp-header-row {
  display: flex;
  gap: 6px;
}

.resp-header-row input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  font-size: 12px;
}

.resp-header-row input:first-child {
  flex: 0 0 38%;
}

.rh-del {
  flex: none;
  width: 30px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: none;
  color: var(--text-faint);
  font-size: 14px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.rh-del:hover {
  color: var(--danger);
  border-color: var(--danger);
}

/* ---------- 一键创建配套路由 ---------- */
.crud-companions {
  border: 1px dashed var(--line-strong);
  border-radius: 10px;
  padding: 10px 12px;
}

/* ---------- 异步回调 ---------- */
.callback-block .callback-config {
  display: grid;
  gap: 10px;
}

.callback-mode {
  display: grid;
  gap: 10px;
  border: 1px solid rgba(8, 145, 178, 0.3);
  border-radius: 10px;
  background: rgba(8, 145, 178, 0.05);
  padding: 12px;
  margin: 0;
  min-width: 0;
}

.callback-mode:disabled {
  opacity: 0.6;
}

.callback-mode-row {
  display: inline-flex;
  width: max-content;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  overflow: hidden;
}

.mode-btn {
  padding: 5px 14px;
  border: none;
  background: none;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
}

.mode-btn + .mode-btn {
  border-left: 1px solid var(--line-strong);
}

.mode-btn.on {
  background: rgba(8, 145, 178, 0.12);
  color: #0e7490;
  font-weight: 700;
}

.cb-method-row {
  display: flex;
  gap: 8px;
}

.cb-method-row select {
  flex: none;
  width: 104px;
  cursor: pointer;
}

.cb-method-row input {
  flex: 1;
  min-width: 0;
}

.cb-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.cb-editor {
  min-height: 88px;
  font-size: 12px;
  line-height: 1.55;
}

.cb-headers {
  display: grid;
  gap: 6px;
}

@media (max-width: 900px) {
  .cb-grid {
    grid-template-columns: 1fr;
  }
}

.crud-companions-title {
  margin-bottom: 2px;
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
}

.companion-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 2px;
  border-bottom: 1px dashed var(--line);
  cursor: pointer;
}

.companion-row:last-of-type {
  border-bottom: none;
}

.companion-check {
  flex: none;
  accent-color: var(--accent);
}

.companion-method {
  flex: none;
  width: 46px;
  font-size: 12px;
  font-weight: 700;
}

.companion-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.companion-name {
  flex: none;
  color: var(--text-dim);
  font-size: 12px;
}

@media (max-width: 900px) {
  .advanced-grid,
  .auth-fields {
    grid-template-columns: 1fr;
  }
}
</style>
