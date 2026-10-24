<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from 'vue';
import type { ConditionRow, NotifyFn } from '../../types';
import { BODY_MATCH_LABELS, bodyRowsToJsonValue, isTemplateJsonValid, jsonValueToBodyRows } from '../../utils';
import { DEFAULT_SCENE_ID, newScene, sceneIsJsonMode, type CondTab, type SceneDraft } from '../../route-form-draft';
import ConditionTable from '../ConditionTable.vue';

const props = defineProps<{
  /** 全部分支草稿（父组件持有；本组件就地修改其中的场景对象与数组顺序） */
  scenes: SceneDraft[];
  /** 「启用自定义响应头」总开关：决定当前分支是否文本模式 */
  customHeadersOn: boolean;
  notify: NotifyFn;
}>();

const activeId = defineModel<number>('activeId', { required: true });
const bodyEditorMode = defineModel<'rows' | 'json'>('bodyEditorMode', { required: true });
const bodyJson = defineModel<string>('bodyJson', { required: true });
const bodyJsonInvalid = defineModel<boolean>('bodyJsonInvalid', { required: true });

/* 场景数组经 prop 传入，toRef 保持与原实现一致的 scenes.value 读写形态 */
const scenes = toRef(props, 'scenes');

const COND_TABS: Array<{ key: CondTab; label: string; keyPh: string; valuePh: string }> = [
  { key: 'query', label: 'Params', keyPh: '参数名，如 tenantId', valuePh: '参数值，如 acme' },
  { key: 'body', label: 'Body', keyPh: 'JSON 路径，如 user.id', valuePh: '字段值，如 1001' },
  { key: 'headers', label: 'Headers', keyPh: '头名称，如 X-Token', valuePh: '头的值，如 abc' },
];

const BODY_PLACEHOLDER = `{
  "code": 0,
  "data": {
    "id": 1001,
    "name": "PolyMock"
  }
}`;

/* Body 页签 JSON 子集模式的占位示例（Postman 式期望子集） */
const BODY_COND_PLACEHOLDER = `{
  "user": {
    "id": 1001
  }
}`;

/* 完整 JSON / 原文期望值占位示例（与 AdmissionSection 的准入编辑器同一份文案） */
const BODY_RAW_PLACEHOLDER = `{
  "status": "PAID",
  "orderId": "1001"
}`;

/* 原文全文相等策略的占位示例（须经常量绑定，避免模板属性里的引号冲突） */
const BODY_TEXT_PLACEHOLDER = '{"status":"PAID","orderId":"1001"}';

/* 响应 body 模板说明（含 {{ }} 字面量，须经 :title 绑定常量，避免被模板插值解析） */
const TEMPLATE_HINT_TITLE =
  'body 字符串支持：{{query.参数名}} {{header.头名}} {{body.点路径}} {{params.参数名}} {{$id}} 自增 {{$now}} 当前时间 {{$int(1,99)}} 随机整数；占位符可直接作为 JSON 值使用（按渲染结果类型注入）';

/* 文本模式（非 JSON Content-Type）下 body 编辑器的占位提示 */
const TEXT_BODY_PLACEHOLDER = '任意文本，如 <h1>hello {{params.name}}</h1>——原样发送，支持模板占位符，无需合法 JSON';

const activeIndex = computed(() => {
  const idx = scenes.value.findIndex((s) => s.localId === activeId.value);
  return idx === -1 ? 0 : idx;
});

const activeScene = computed(() => scenes.value[activeIndex.value]);

const activeIsDefault = computed(() => activeId.value === DEFAULT_SCENE_ID);

const variantScenes = computed(() => scenes.value.filter((s) => s.localId !== DEFAULT_SCENE_ID));

const activeBranchLabel = computed(() => (activeIsDefault.value ? '默认响应' : activeScene.value.name.trim() || '未命名分支'));

/* ---------- 分支条件与响应 ---------- */

function addScene() {
  const scene = newScene(`分支 ${variantScenes.value.length + 1}`);
  scenes.value.push(scene);
  activeId.value = scene.localId;
}

function removeScene(localId: number) {
  const idx = scenes.value.findIndex((s) => s.localId === localId);
  if (idx <= 0) return;
  scenes.value.splice(idx, 1);
  if (activeId.value === localId) activeId.value = DEFAULT_SCENE_ID;
}

function moveScene(localId: number, delta: -1 | 1) {
  const idx = scenes.value.findIndex((s) => s.localId === localId);
  const target = idx + delta;
  if (idx <= 0 || target < 1 || target >= scenes.value.length) return;
  const list = scenes.value;
  [list[idx], list[target]] = [list[target], list[idx]];
}

/** 拖动排序：把 fromLocalId 移到 toLocalId 的位置（默认响应固定在第 0 位，不参与拖动） */
function moveSceneTo(fromLocalId: number, toLocalId: number) {
  const fromIdx = scenes.value.findIndex((s) => s.localId === fromLocalId);
  const toIdx = scenes.value.findIndex((s) => s.localId === toLocalId);
  if (fromIdx <= 0 || toIdx <= 0 || fromIdx === toIdx) return;
  const [moved] = scenes.value.splice(fromIdx, 1);
  scenes.value.splice(toIdx, 0, moved);
}

/* 分支标签拖拽状态（HTML5 拖放；键盘可用 ←/→ 移动，见 moveSceneByKey） */
const dragLocalId = ref<number | null>(null);
const dragOverLocalId = ref<number | null>(null);

/* 标签元素引用：键盘移动后把焦点还给被移动的标签，保证可以连续按 */
const tabEls = new Map<number, HTMLButtonElement>();

function setTabRef(localId: number, el: Element | unknown) {
  if (el instanceof HTMLButtonElement) tabEls.set(localId, el);
  else tabEls.delete(localId);
}

/** 键盘调整顺序：← 前移一位、→ 后移一位；移动后重新聚焦同一标签，支持连续按键 */
async function moveSceneByKey(localId: number, delta: -1 | 1) {
  const idx = scenes.value.findIndex((s) => s.localId === localId);
  const target = idx + delta;
  if (idx <= 0 || target < 1 || target >= scenes.value.length) return;
  moveScene(localId, delta);
  await nextTick();
  tabEls.get(localId)?.focus();
}

function onTabDragStart(localId: number, event: DragEvent) {
  dragLocalId.value = localId;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    /* Firefox 需要写入数据才会真正开始拖拽 */
    event.dataTransfer.setData('text/plain', String(localId));
  }
}

function onTabDragOver(localId: number, event: DragEvent) {
  if (dragLocalId.value === null || dragLocalId.value === localId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dragOverLocalId.value = localId;
}

function onTabDragLeave(localId: number) {
  if (dragOverLocalId.value === localId) dragOverLocalId.value = null;
}

function onTabDrop(localId: number, event: DragEvent) {
  event.preventDefault();
  const from = dragLocalId.value;
  dragLocalId.value = null;
  dragOverLocalId.value = null;
  if (from !== null) moveSceneTo(from, localId);
}

function onTabDragEnd() {
  dragLocalId.value = null;
  dragOverLocalId.value = null;
}

function sceneRows(tab: CondTab): ConditionRow[] {
  return activeScene.value.rows[tab];
}

function setSceneRows(tab: CondTab, rows: ConditionRow[]) {
  activeScene.value.rows[tab] = rows;
}

const blockHint = computed(() => {
  if (activeIsDefault.value) return '默认响应：所有分支都未命中时返回，条件请在「请求准入」区配置';
  if (activeScene.value.tab === 'body') {
    if (activeScene.value.bodyMatch !== 'subset') {
      return activeScene.value.bodyMatch === 'deepEqual'
        ? '命中条件：请求体与期望的完整 JSON 深度相等（Params / Headers 条件照常参与）'
        : '命中条件：请求体原文与期望文本逐字符相等（Params / Headers 条件照常参与）';
    }
    if (bodyEditorMode.value === 'json') return '命中条件：请求体需包含以下 JSON 字段（叶子字段按点路径子集匹配）';
  }
  return '命中条件：请求满足所有启用行时命中本分支（多个分支按顺序匹配，第一个命中生效）';
});

/** 当前编辑分支是否文本模式（body 编辑器据此切换校验与提示） */
const activeSceneTextMode = computed(() => !sceneIsJsonMode(activeScene.value, props.customHeadersOn));

/* ---------- Body 子集编辑器互转 ---------- */

/** 当前分支的 body 条件行是否都能用 JSON 子集表达（只有「等于」行可以） */
const activeBodyJsonApplicable = computed(() => activeScene.value.rows.body.every((row) => row.match === 'equals'));

/** 把当前分支的 body 条件行序列化为 JSON 文本 */
function syncBodyJson() {
  const value = bodyRowsToJsonValue(activeScene.value.rows.body);
  bodyJson.value = Object.keys(value as Record<string, unknown>).length ? JSON.stringify(value, null, 2) : '';
  bodyJsonInvalid.value = false;
}

function setBodyMode(mode: 'rows' | 'json') {
  if (mode === 'json') {
    if (!activeBodyJsonApplicable.value) {
      props.notify('含「存在 / 非空 / 正则」条件时无法用 JSON 子集表达，请继续使用行编辑', 'warn');
      return;
    }
    syncBodyJson();
  }
  bodyEditorMode.value = mode;
}

/** JSON 编辑时实时解析回条件行；非法只标红，行保持最近一次合法结果 */
function onBodyJsonInput() {
  const raw = bodyJson.value.trim();
  if (!raw) {
    activeScene.value.rows.body = [];
    bodyJsonInvalid.value = false;
    return;
  }
  try {
    activeScene.value.rows.body = jsonValueToBodyRows(JSON.parse(raw));
    bodyJsonInvalid.value = false;
  } catch {
    bodyJsonInvalid.value = true;
  }
}

/* 切换分支 / 页签 / 编辑器模式进入 body JSON 视图时，从条件行重新序列化 */
watch(
  () => [activeScene.value.localId, activeScene.value.tab, bodyEditorMode.value] as const,
  ([, tab, mode]) => {
    if (tab === 'body' && mode === 'json' && activeBodyJsonApplicable.value) syncBodyJson();
  },
);

/* ---------- body 文本校验与格式化 ---------- */

/** body 失焦时即时校验，非法标红；文本模式（响应头声明非 JSON Content-Type）不做 JSON 校验 */
function validateBodyText(scene: SceneDraft) {
  const raw = scene.bodyText.trim();
  scene.invalid = raw && sceneIsJsonMode(scene, props.customHeadersOn) ? !isTemplateJsonValid(raw) : false;
}

/** body 输入过程中仅在标红状态下复检，便于即时消除错误 */
function onBodyInput(scene: SceneDraft) {
  if (scene.invalid) validateBodyText(scene);
}

/** 格式化当前分支的 body 文本；非法时报错并标红；文本模式不做 JSON 格式化 */
function formatBodyText() {
  const scene = activeScene.value;
  if (!sceneIsJsonMode(scene, props.customHeadersOn)) {
    props.notify('当前分支为文本 body（响应头声明了非 JSON Content-Type），不做 JSON 格式化', 'warn');
    return;
  }
  const raw = scene.bodyText.trim();
  if (!raw) return;
  if (raw.includes('{{')) {
    scene.invalid = !isTemplateJsonValid(raw);
    props.notify('含模板占位符的 body 不做格式化，占位符会原样保留', 'warn');
    return;
  }
  try {
    scene.bodyText = JSON.stringify(JSON.parse(raw), null, 2);
    scene.invalid = false;
  } catch {
    scene.invalid = true;
    props.notify('body 不是合法的 JSON，无法格式化', 'err');
  }
}
</script>

<template>
  <!-- ========== 响应分支 ========== -->
  <section class="card">
    <div class="card-head">
      <div>
        <div class="card-title">响应分支</div>
        <div class="card-note">按顺序匹配，第一个命中的分支生效；都未命中时走默认响应。</div>
      </div>
      <button type="button" class="mini-btn" @click="addScene">＋ 新增分支</button>
    </div>
    <div class="card-body">
      <div class="branch-tabs">
        <button
          type="button"
          class="branch-tab fallback"
          :class="{ active: activeIsDefault }"
          title="默认响应：所有分支都未命中时返回（固定最后兜底，不参与排序）"
          @click="activeId = DEFAULT_SCENE_ID"
        >
          默认响应<em>fallback</em>
        </button>
        <button
          v-for="(s, i) in variantScenes"
          :key="s.localId"
          :ref="(el) => setTabRef(s.localId, el)"
          type="button"
          class="branch-tab"
          :class="{ active: activeId === s.localId, dragging: dragLocalId === s.localId, 'drop-target': dragOverLocalId === s.localId }"
          draggable="true"
          :title="`分支 #${i + 1}：${s.name.trim() || '未命名'}（拖动可调整匹配顺序，聚焦后 ← / → 也可移动）`"
          @click="activeId = s.localId"
          @dragstart="onTabDragStart(s.localId, $event)"
          @dragover="onTabDragOver(s.localId, $event)"
          @dragleave="onTabDragLeave(s.localId)"
          @drop="onTabDrop(s.localId, $event)"
          @dragend="onTabDragEnd"
          @keydown.left.prevent="moveSceneByKey(s.localId, -1)"
          @keydown.right.prevent="moveSceneByKey(s.localId, 1)"
        >
          <span class="branch-grip" aria-hidden="true">⠿</span>
          {{ s.name.trim() || '未命名分支' }}<em>HTTP {{ Number(s.status) || 200 }}</em>
        </button>
      </div>

      <div class="branch-editor-head">
        <span class="hint">分支按标签顺序匹配，第一个命中的生效；拖动标签可调整顺序（聚焦标签后 ← / → 亦可）</span>
        <button
          type="button"
          class="branch-delete"
          :class="{ invisible: activeIsDefault }"
          :disabled="activeIsDefault"
          :aria-hidden="activeIsDefault"
          :title="`删除分支「${activeBranchLabel}」`"
          @click="removeScene(activeId)"
        >
          × 删除分支
        </button>
      </div>

      <div class="branch-editor">
        <!-- 分支条件 -->
        <div class="subpanel">
          <h3>分支条件 · {{ activeIsDefault ? '无' : '可选' }}</h3>

          <template v-if="activeIsDefault">
            <p class="subpanel-note">
              默认响应不写条件：它是所有分支都未命中时的兜底。需要「所有请求都必须满足」的条件，请写在「请求准入」区。
            </p>
          </template>

          <template v-else>
            <div class="field branch-name-field">
              <label for="f-scene-name">分支名称</label>
              <input id="f-scene-name" v-model="activeScene.name" type="text" placeholder="如 已付款" spellcheck="false">
            </div>

            <div class="kv-tabs">
              <button
                v-for="t in COND_TABS"
                :key="t.key"
                type="button"
                :class="{ active: activeScene.tab === t.key }"
                @click="activeScene.tab = t.key"
              >
                {{ t.label }}<span v-if="sceneRows(t.key).length" class="tab-count">{{ sceneRows(t.key).length }}</span>
              </button>
            </div>

            <p class="hint block-hint">{{ blockHint }}</p>

            <template v-if="activeScene.tab === 'body'">
              <div class="strategy-row">
                <label class="body-strategy">
                  Body 匹配策略
                  <select v-model="activeScene.bodyMatch">
                    <option v-for="m in BODY_MATCH_LABELS" :key="m.value" :value="m.value">{{ m.label }}</option>
                  </select>
                </label>
              </div>
              <p class="hint">{{ BODY_MATCH_LABELS.find((m) => m.value === activeScene.bodyMatch)?.hint }}</p>

              <template v-if="activeScene.bodyMatch === 'subset'">
                <div class="kv-tabs mode-tabs">
                  <button type="button" :class="{ active: bodyEditorMode === 'rows' }" @click="setBodyMode('rows')">行编辑</button>
                  <button type="button" :class="{ active: bodyEditorMode === 'json' }" @click="setBodyMode('json')">JSON 子集</button>
                  <span class="hint mode-hint">
                    {{ bodyEditorMode === 'rows' ? '逐行配置点路径条件，可调操作符与类型' : '写期望的 JSON 子集，叶子字段即等值条件' }}
                  </span>
                </div>
                <template v-if="bodyEditorMode === 'json'">
                  <textarea
                    v-model="bodyJson"
                    class="body-json-editor"
                    rows="6"
                    :placeholder="BODY_COND_PLACEHOLDER"
                    spellcheck="false"
                    :class="{ invalid: bodyJsonInvalid }"
                    @input="onBodyJsonInput"
                  ></textarea>
                  <p v-show="bodyJsonInvalid" class="field-error">body 条件不是合法的 JSON</p>
                </template>
                <ConditionTable
                  v-else
                  :rows="sceneRows('body')"
                  :key-placeholder="COND_TABS.find((t) => t.key === 'body')?.keyPh"
                  :value-placeholder="COND_TABS.find((t) => t.key === 'body')?.valuePh"
                  @update:rows="(rows) => setSceneRows('body', rows)"
                />
              </template>

              <textarea
                v-else
                v-model="activeScene.bodyRaw"
                class="body-raw-editor"
                rows="6"
                :placeholder="activeScene.bodyMatch === 'deepEqual' ? BODY_RAW_PLACEHOLDER : BODY_TEXT_PLACEHOLDER"
                spellcheck="false"
                :aria-label="activeScene.bodyMatch === 'deepEqual' ? '期望的完整 JSON' : '期望的原文'"
              ></textarea>
            </template>
            <ConditionTable
              v-else
              :rows="sceneRows(activeScene.tab)"
              :key-placeholder="COND_TABS.find((t) => t.key === activeScene.tab)?.keyPh"
              :value-placeholder="COND_TABS.find((t) => t.key === activeScene.tab)?.valuePh"
              @update:rows="(rows) => setSceneRows(activeScene.tab, rows)"
            />
          </template>
        </div>

        <!-- 返回响应 -->
        <div class="subpanel">
          <h3>返回响应</h3>
          <div class="label-row">
            <span class="resp-title">
              <label for="f-resp-status">状态码</label>
              <input
                id="f-resp-status"
                v-model.number="activeScene.status"
                class="status-input"
                title="响应状态码（100–599）"
                aria-label="响应状态码"
                type="number"
                min="100"
                max="599"
              >
            </span>
            <span class="label-row-ops">
              <span v-if="activeIsDefault" class="hint">无分支命中时返回</span>
              <span class="hint" :title="TEMPLATE_HINT_TITLE">模板可用</span>
              <button type="button" class="mini-btn" title="格式化 JSON" @click="formatBodyText">格式化</button>
              <span v-if="activeSceneTextMode" class="text-mode-badge" title="响应头声明了非 JSON Content-Type：body 按原样文本发送，不做 JSON 校验">文本模式</span>
            </span>
          </div>

          <p class="hint">响应 body{{ activeIsDefault ? '（默认响应）' : `（分支「${activeBranchLabel}」）` }}</p>
          <textarea
            id="f-resp-body"
            v-model="activeScene.bodyText"
            rows="10"
            :placeholder="activeSceneTextMode ? TEXT_BODY_PLACEHOLDER : BODY_PLACEHOLDER"
            spellcheck="false"
            :class="{ invalid: activeScene.invalid }"
            @blur="validateBodyText(activeScene)"
            @input="onBodyInput(activeScene)"
          ></textarea>
          <p v-show="activeScene.invalid" class="field-error">body 不是合法的 JSON</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped src="./section-card.css"></style>

<style scoped>
/* ---------- 响应分支 ---------- */
.branch-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.branch-tab {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 7px 11px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--bg);
  color: var(--text-dim);
  font-family: var(--sans);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.branch-tab:not(.fallback) {
  cursor: grab;
}

.branch-tab:not(.fallback):active {
  cursor: grabbing;
}

.branch-tab:hover {
  border-color: var(--line-strong);
  color: var(--text);
}

.branch-tab.active {
  border-color: rgba(14, 159, 93, 0.45);
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-weight: 600;
}

/* 拖动排序反馈：拖起的标签淡化，悬停目标高亮 */
.branch-tab.dragging {
  opacity: 0.45;
}

.branch-tab.drop-target {
  border-color: var(--accent);
  border-style: dashed;
  background: var(--accent-dim);
}

.branch-grip {
  color: var(--text-faint);
  font-size: 11px;
  letter-spacing: -1px;
}

.branch-tab.active .branch-grip {
  color: var(--accent-strong);
}

.branch-tab em {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
  font-style: normal;
}

.branch-tab.active em {
  color: var(--accent-strong);
}

/* 分支框体右上角：顺序提示 + 删除当前分支 */
.branch-editor-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.branch-delete {
  flex: none;
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: none;
  color: var(--text-dim);
  font-family: var(--sans);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

/* 默认响应不可删除：保留按钮占位，避免切换分支时框体高度跳动 */
.branch-delete.invisible {
  visibility: hidden;
}

.branch-delete:hover {
  color: var(--danger);
  border-color: var(--danger);
  background: rgba(207, 34, 46, 0.06);
}

.branch-editor {
  display: grid;
  /* 条件行控件多，给「分支条件」更多横向空间，减少换行 */
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: 12px;
  /* 两栏等高：内容少的一侧不再留下难看的空档（内容仍顶部对齐） */
  align-items: stretch;
}

.subpanel {
  display: grid;
  gap: 9px;
  align-content: start;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--bg-soft);
}

.subpanel h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
}

.subpanel-note {
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.6;
}

.branch-name-field input {
  padding: 7px 10px !important;
  font-size: 12px !important;
}

.tab-count {
  margin-left: 5px;
  padding: 0 5px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--bg-soft);
  color: var(--text-dim);
  font-size: 12px;
}

.body-json-editor,
.body-raw-editor {
  width: 100%;
  min-height: 110px;
  padding: 9px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: #fff;
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  resize: vertical;
}

.body-json-editor.invalid,
.body-raw-editor.invalid {
  border-color: var(--danger);
}

.subpanel textarea:not(.body-json-editor):not(.body-raw-editor) {
  width: 100%;
  min-height: 160px;
  padding: 9px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: #fff;
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  resize: vertical;
}

.subpanel textarea.invalid {
  border-color: var(--danger);
}

/* 状态码与「状态码」标签同行，避免独占一行留出空洞 */
.resp-title {
  display: inline-flex;
  flex: none;
  align-items: baseline;
  gap: 8px;
}

/* 窄列（响应列 1fr）时整块换行，避免提示文字被挤成两行 */
.subpanel .label-row {
  flex-wrap: wrap;
  row-gap: 4px;
}

.subpanel .label-row .hint,
.subpanel .label-row-ops {
  white-space: nowrap;
}

.label-row-ops {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.resp-title label {
  margin-bottom: 0;
}

.resp-title .status-input {
  width: 92px;
  padding: 4px 8px;
  font-size: 13px;
  text-align: center;
}

/* 文本模式徽标：响应头声明非 JSON Content-Type 时的 body 编辑提示 */
.text-mode-badge {
  padding: 2px 8px;
  border: 1px solid var(--warn);
  border-radius: 999px;
  color: var(--warn);
  font-size: 12px;
  white-space: nowrap;
}

@media (max-width: 900px) {
  .branch-editor {
    grid-template-columns: 1fr;
  }
}
</style>
