<script setup lang="ts">
import { computed, toRef } from 'vue';
import type { SceneDraft } from '../../route-form-draft';
import type { NotifyFn } from '../../types';
import { methodColor, parseSequenceDraft } from '../../utils';

const props = defineProps<{
  /** 全部分支草稿（父组件持有；「自定义响应头」块就地修改当前激活场景的 headerRows） */
  scenes: SceneDraft[];
  /** 当前激活场景的 localId（由 BranchesSection 维护，本组件只读） */
  activeId: number;
  editing: boolean;
  /** 一键创建配套路由（仅新建态且开启 CRUD 时非空） */
  companionRoutes: Array<{ key: string; method: string; path: string; name: string }>;
  /** 配套路由勾选状态（父组件持有；本组件就地修改） */
  companionSelection: Record<string, boolean>;
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
