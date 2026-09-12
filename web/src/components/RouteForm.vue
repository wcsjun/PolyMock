<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { createRoute, updateRoute } from '../api';
import type { ConditionRow, NotifyFn, PolyMockMode, Route, RouteAuth, RoutePayload, ServiceInfo } from '../types';
import {
  buildRouteRequest,
  bodyRowsToJsonValue,
  formatBody,
  isTemplateJsonValid,
  jsonValueToBodyRows,
  parseSequenceDraft,
  sequenceToDraftText,
  serviceDisplaySuffix,
  splitRouteRequest,
} from '../utils';
import ConditionTable from './ConditionTable.vue';

const props = defineProps<{
  services: ServiceInfo[];
  editing: Route | null;
  /** 运行模式：决定服务分组下拉的后缀展示（端口模式 :端口 / 路径模式 basePath 前缀） */
  mode: PolyMockMode;
  notify: NotifyFn;
}>();

const emit = defineEmits<{
  changed: [];
  'cancel-edit': [];
}>();

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const DEFAULT_SCENE_ID = 0;

type CondTab = 'query' | 'headers' | 'body';

const COND_TABS: Array<{ key: CondTab; label: string; keyPh: string; valuePh: string }> = [
  { key: 'query', label: 'Params', keyPh: '参数名，如 id', valuePh: '参数值（可选）' },
  { key: 'body', label: 'Body', keyPh: 'JSON 路径，如 user.id', valuePh: '参数值（可选）' },
  { key: 'headers', label: 'Headers', keyPh: '头名称，如 X-Token', valuePh: '参数值（可选）' },
];

const BODY_PLACEHOLDER = `{
  "code": 0,
  "data": {
    "id": 1001,
    "name": "PolyMock"
  }
}`;

/* Body 页签 JSON 模式的占位示例（Postman 式期望子集） */
const BODY_COND_PLACEHOLDER = `{
  "user": {
    "id": 1001
  }
}`;

/* 响应 body 模板说明（含 {{ }} 字面量，须经 :title 绑定常量，避免被模板插值解析） */
const TEMPLATE_HINT_TITLE =
  'body 字符串支持：{{query.参数名}} {{header.头名}} {{body.点路径}} {{params.参数名}} {{$id}} 自增 {{$now}} 当前时间 {{$int(1,99)}} 随机整数；占位符可直接作为 JSON 值使用（按渲染结果类型注入）';

/* 路径参数提示（含 {{ }} 字面量，同上须经常量绑定渲染） */
const PATH_PARAM_HINT = '支持 :参数 段，如 /api/users/:id，响应模板可用 {{params.id}}';

/* 序列响应编辑器的占位示例（JSON 数组，每步 status + body） */
const SEQUENCE_PLACEHOLDER = `[
  { "status": 200, "body": { "mode": "first" } },
  { "status": 500, "body": { "error": "boom" } }
]`;

type SceneRows = Record<CondTab, ConditionRow[]>;

function emptyRows(): SceneRows {
  return { query: [], headers: [], body: [] };
}

/** 一个响应场景 = 匹配条件（rows）+ 返回响应（status/bodyText）；localId 0 固定为默认响应 */
interface SceneDraft {
  localId: number;
  name: string;
  tab: CondTab;
  rows: SceneRows;
  status: number | null;
  bodyText: string;
  invalid: boolean;
}

let sceneSeq = 0;

function newScene(name: string): SceneDraft {
  sceneSeq += 1;
  return { localId: sceneSeq, name, tab: 'query', rows: emptyRows(), status: 200, bodyText: '', invalid: false };
}

function defaultScene(): SceneDraft {
  return { localId: DEFAULT_SCENE_ID, name: '默认响应', tab: 'query', rows: emptyRows(), status: 200, bodyText: '', invalid: false };
}

const serviceId = ref('');
const name = ref('');
const method = ref<string>('GET');
const path = ref('');
const pathInput = ref<HTMLInputElement | null>(null);
const submitting = ref(false);

/* 场景列表：首项固定为默认响应，其余为变体（顺序即匹配优先级） */
const scenes = ref<SceneDraft[]>([defaultScene()]);
const activeId = ref<number>(DEFAULT_SCENE_ID);
/* 默认响应的准入开关：开启后所有请求需满足默认场景条件，否则返回 400 */
const requireMatch = ref(false);

/* ---------- 高级选项：延迟 / 抖动 / 故障注入 / 停用 ---------- */

const advancedOpen = ref(false);
/* 空字符串表示未设置（模式同 ServicePanel 的 sPort） */
const delayMs = ref<number | ''>('');
const jitterMs = ref<number | ''>('');
const failureRate = ref<number | ''>('');
/* 停用开关仅编辑态展示，随 payload.disabled 提交 */
const disabledFlag = ref(false);

/* 序列响应：开关 + 草稿文本（JSON 数组），非法时标红；提交时解析为 [{status, body-string}] */
const sequenceOn = ref(false);
const sequenceText = ref('');
const sequenceInvalid = ref(false);

/* 有状态 CRUD 开关，随 payload.crud 提交 */
const crudFlag = ref(false);

/* 路由级认证：none 关闭；apikey = 自定义 header 携带密钥；bearer = Authorization: Bearer <token> */
const authType = ref<'none' | 'apikey' | 'bearer'>('none');
const authValue = ref('');
const authHeader = ref('');

const activeIndex = computed(() => {
  const idx = scenes.value.findIndex((s) => s.localId === activeId.value);
  return idx === -1 ? 0 : idx;
});

const activeScene = computed(() => scenes.value[activeIndex.value]);

const activeIsDefault = computed(() => activeId.value === DEFAULT_SCENE_ID);

const variantScenes = computed(() => scenes.value.filter((s) => s.localId !== DEFAULT_SCENE_ID));

/* ---------- Body 页签编辑器（Postman 式 JSON ⇄ 表格） ---------- */

const bodyEditorMode = ref<'json' | 'table'>('json');
const bodyJson = ref('');
const bodyJsonInvalid = ref(false);

/** 把当前场景的 body 条件行序列化为 JSON 文本 */
function syncBodyJson() {
  const value = bodyRowsToJsonValue(activeScene.value.rows.body);
  bodyJson.value = Object.keys(value as Record<string, unknown>).length
    ? JSON.stringify(value, null, 2)
    : '';
  bodyJsonInvalid.value = false;
}

function setBodyMode(mode: 'json' | 'table') {
  if (mode === 'json') syncBodyJson();
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

/* 切换场景 / 页签 / 编辑器模式进入 body JSON 视图时，从条件行重新序列化 */
watch(
  () => [activeScene.value.localId, activeScene.value.tab, bodyEditorMode.value] as const,
  ([, tab, mode]) => {
    if (tab === 'body' && mode === 'json') syncBodyJson();
  },
);

const blockHint = computed(() => {
  if (activeIsDefault.value) return '准入条件：开启「必须匹配」后，不满足条件的请求将返回 400';
  if (activeScene.value.tab === 'body' && bodyEditorMode.value === 'json') {
    return '命中条件：请求 body 需包含以下 JSON 字段（叶子字段按点路径子集匹配）';
  }
  return '命中条件：请求满足所有启用行时命中本场景';
});

/* 服务下拉：选中项跨渲染保持；列表变化后若选中项不存在则回落到第一项 */
watch(
  () => props.services,
  (list) => {
    if (!list.some((s) => s.id === serviceId.value)) {
      serviceId.value = list[0]?.id ?? '';
    }
  },
  { immediate: true },
);

/* 进入/退出编辑模式：回填表单或复位（保持服务分组选择） */
watch(
  () => props.editing,
  async (route) => {
    if (route) {
      if (props.services.some((s) => s.id === route.serviceId)) {
        serviceId.value = route.serviceId;
      }
      name.value = route.name ?? '';
      method.value = route.method;
      path.value = route.path;

      const def = defaultScene();
      def.status = route.response.status;
      def.bodyText = formatBody(route.response.body);
      ({ query: def.rows.query, headers: def.rows.headers, body: def.rows.body } = splitRouteRequest(route.request));
      requireMatch.value = route.requireMatch === true;

      /* 高级选项回填（disabled/延迟/抖动/故障率） */
      delayMs.value = route.delayMs ?? '';
      jitterMs.value = route.jitterMs ?? '';
      failureRate.value = route.failureRate ?? '';
      disabledFlag.value = route.disabled === true;

      /* 序列响应 / CRUD 回填：sequence 的 body 统一转为展示友好的 JSON 形态 */
      sequenceOn.value = (route.sequence?.length ?? 0) > 0;
      sequenceText.value = sequenceToDraftText(route.sequence);
      sequenceInvalid.value = false;
      crudFlag.value = route.crud === true;

      /* 路由级认证回填 */
      authType.value = route.auth?.type ?? 'none';
      authValue.value = route.auth?.value ?? '';
      authHeader.value = route.auth?.header ?? '';

      scenes.value = [
        def,
        ...(route.variants ?? []).map((v) => {
          const scene = newScene(v.name);
          scene.status = v.response.status;
          scene.bodyText = formatBody(v.response.body);
          scene.rows = splitRouteRequest(v.match);
          return scene;
        }),
      ];
      activeId.value = DEFAULT_SCENE_ID;
      /* 表单挂在抽屉里，等抽屉显示后再聚焦 */
      await nextTick();
      pathInput.value?.focus();
    } else {
      resetForm();
    }
  },
);

function resetForm() {
  const keepService = serviceId.value;
  name.value = '';
  method.value = 'GET';
  path.value = '';
  requireMatch.value = false;
  delayMs.value = '';
  jitterMs.value = '';
  failureRate.value = '';
  disabledFlag.value = false;
  sequenceOn.value = false;
  sequenceText.value = '';
  sequenceInvalid.value = false;
  crudFlag.value = false;
  authType.value = 'none';
  authValue.value = '';
  authHeader.value = '';
  scenes.value = [defaultScene()];
  activeId.value = DEFAULT_SCENE_ID;
  serviceId.value = props.services.some((s) => s.id === keepService)
    ? keepService
    : props.services[0]?.id ?? '';
}

/* ---------- 场景管理 ---------- */

function addScene() {
  const scene = newScene(`场景 ${variantScenes.value.length + 1}`);
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

function sceneRows(tab: CondTab): ConditionRow[] {
  return activeScene.value.rows[tab];
}

function setSceneRows(tab: CondTab, rows: ConditionRow[]) {
  activeScene.value.rows[tab] = rows;
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** 校验一段 body 文本，非法时标红并提示；返回是否合法 */
function ensureJson(text: string, label: string, markInvalid: () => void): boolean {
  const raw = text.trim();
  if (!raw) return true;
  if (isTemplateJsonValid(raw)) return true;
  markInvalid();
  props.notify(`${label} 不是合法的 JSON${raw.includes('{{') ? '（含占位符时需为合法 JSON 结构，如 {"code": {{params.code}}}）' : ''}`, 'err');
  return false;
}

/** body 失焦时即时校验，非法标红 */
function validateBodyText(scene: SceneDraft) {
  const raw = scene.bodyText.trim();
  scene.invalid = raw ? !isTemplateJsonValid(raw) : false;
}

/** body 输入过程中仅在标红状态下复检，便于即时消除错误 */
function onBodyInput(scene: SceneDraft) {
  if (scene.invalid) validateBodyText(scene);
}

/** 序列草稿失焦即时校验：空文本视为未填写不标红；非法只标红（提交时才提示具体错误） */
function validateSequenceText() {
  sequenceInvalid.value = sequenceText.value.trim() ? !parseSequenceDraft(sequenceText.value).ok : false;
}

/** 序列输入过程中仅在标红状态下复检，便于即时消除错误 */
function onSequenceInput() {
  if (sequenceInvalid.value) validateSequenceText();
}

/** 格式化当前场景的 body 文本；非法时报错并标红 */
function formatBodyText() {
  const scene = activeScene.value;
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

/** 解析高级选项数值：要求 0-max 整数，空输入按 0（未设置）处理；非法时提示并返回 null */
function parseAdvancedValue(raw: number | '', max: number, label: string): number | null {
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 0 || num > max) {
    props.notify(`${label} 必须是 0-${max} 的整数`, 'err');
    return null;
  }
  return num;
}

async function submit() {
  const editing = props.editing;
  const routeName = name.value.trim();
  const routePath = path.value.trim();
  const routeMethod = method.value;
  const [def, ...variantDrafts] = scenes.value;

  if (!routePath.startsWith('/')) {
    props.notify('path 必须以 / 开头', 'err');
    return;
  }

  if (!editing && !routeName) {
    props.notify('请输入接口名称', 'err');
    return;
  }

  if (!ensureJson(def.bodyText, '默认响应 body', () => { def.invalid = true; })) return;

  const seenNames = new Set<string>();
  for (const scene of variantDrafts) {
    const sceneName = scene.name.trim();
    if (!sceneName) {
      props.notify('场景名称不能为空', 'err');
      return;
    }
    if (seenNames.has(sceneName)) {
      props.notify(`场景名称「${sceneName}」重复`, 'err');
      return;
    }
    seenNames.add(sceneName);
    if (!ensureJson(scene.bodyText, `场景「${sceneName}」的 body`, () => { scene.invalid = true; })) return;
  }

  /* 高级选项数值校验：延迟/抖动 0-60000，故障率 0-100 */
  const delayVal = parseAdvancedValue(delayMs.value, 60000, '延迟 ms');
  const jitterVal = parseAdvancedValue(jitterMs.value, 60000, '抖动 ms');
  const failureVal = parseAdvancedValue(failureRate.value, 100, '故障率 %');
  if (delayVal === null || jitterVal === null || failureVal === null) return;

  /* 认证校验：开启时密钥 / 令牌值必填 */
  if (authType.value !== 'none' && !authValue.value.trim()) {
    props.notify('认证密钥 / 令牌值不能为空', 'err');
    return;
  }

  /* 序列响应：开启时必须解析为合法数组（body 字符串原样提交，由后端解析） */
  let sequencePayload: Array<{ status: number; body: string }> | undefined;
  if (sequenceOn.value) {
    const parsed = parseSequenceDraft(sequenceText.value);
    if (!parsed.ok) {
      sequenceInvalid.value = true;
      props.notify(parsed.error, 'err');
      return;
    }
    sequenceInvalid.value = false;
    sequencePayload = parsed.value;
  }

  submitting.value = true;
  try {
    /* 编辑态始终携带三个字段以便清除；新建态仅在有意义时携带 */
    const request = buildRouteRequest(def.rows.query, def.rows.headers, def.rows.body);
    const variants = variantDrafts.map((scene) => ({
      name: scene.name.trim(),
      match: buildRouteRequest(scene.rows.query, scene.rows.headers, scene.rows.body),
      response: { status: Number(scene.status) || 200, body: scene.bodyText.trim() },
    }));
    const payload: RoutePayload = {
      serviceId: serviceId.value,
      method: routeMethod,
      path: routePath,
      response: { status: Number(def.status) || 200, body: def.bodyText.trim() },
      request: editing ? (request ?? {}) : request,
      requireMatch: requireMatch.value,
      variants,
      delayMs: delayVal,
      jitterMs: jitterVal,
      failureRate: failureVal,
      disabled: disabledFlag.value,
    };
    if (!editing) {
      if (!payload.request) delete payload.request;
      if (!payload.requireMatch) delete payload.requireMatch;
      if (!variants.length) delete payload.variants;
      /* 新建态：高级选项仅在有值时携带；disabled 仅编辑态可携带 */
      if (delayMs.value === '') delete payload.delayMs;
      if (jitterMs.value === '') delete payload.jitterMs;
      if (failureRate.value === '') delete payload.failureRate;
      delete payload.disabled;
    }
    /* 序列/CRUD：编辑态始终携带（序列为数组或 []）以便清除；新建态仅在有值时携带 */
    if (editing) {
      payload.sequence = sequencePayload ?? [];
      payload.crud = crudFlag.value;
    } else {
      if (sequencePayload) payload.sequence = sequencePayload;
      if (crudFlag.value) payload.crud = true;
    }
    /* 认证：编辑态始终携带（null 表示清除）；新建态仅在开启时携带 */
    const authPayload: RouteAuth | null =
      authType.value === 'none'
        ? null
        : {
            type: authType.value,
            value: authValue.value.trim(),
            ...(authType.value === 'apikey' && authHeader.value.trim() ? { header: authHeader.value.trim() } : {}),
          };
    if (editing) {
      payload.auth = authPayload;
    } else if (authPayload) {
      payload.auth = authPayload;
    }
    if (!editing || routeName) payload.name = routeName;

    if (editing) {
      await updateRoute(editing.id, payload);
      props.notify(`已更新 ${routeMethod} ${routePath}`);
      emit('cancel-edit');
    } else {
      await createRoute(payload);
      props.notify(`已注册 ${routeMethod} ${routePath}`);
      resetForm();
    }
    emit('changed');
  } catch (err) {
    props.notify((err as Error).message, 'err');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <aside class="panel form-panel">
    <div class="panel-head">
      <h2>{{ editing ? '编辑接口' : '新增接口' }}</h2>
      <button type="button" class="drawer-close" title="关闭（Esc）" aria-label="关闭" @click="emit('cancel-edit')">×</button>
    </div>

    <form id="route-form" autocomplete="off" @submit.prevent="submit">
      <div class="field-grid">
        <div class="field">
          <label for="f-service">服务分组</label>
          <select id="f-service" v-model="serviceId">
            <option v-for="s in services" :key="s.id" :value="s.id">{{ s.name }} {{ serviceDisplaySuffix(s, props.mode) }}</option>
          </select>
        </div>

        <div class="field">
          <label for="f-name">接口名称</label>
          <input id="f-name" v-model="name" name="name" type="text" placeholder="显示在卡片上，如 查询用户信息" spellcheck="false">
        </div>
      </div>

      <div class="field">
        <label for="f-method">请求方法与路径</label>
        <div class="method-row">
          <select id="f-method" v-model="method">
            <option v-for="m in METHODS" :key="m" :value="m">{{ m }}</option>
          </select>
          <input
            id="f-path"
            ref="pathInput"
            v-model="path"
            name="path"
            type="text"
            placeholder="/api/user/info"
            spellcheck="false"
            autofocus
          >
        </div>
        <p class="hint path-hint" v-text="PATH_PARAM_HINT"></p>
      </div>

      <div class="scene-editor">
        <div class="scene-side">
          <p class="scene-side-title">响应场景</p>

          <button
            type="button"
            class="scene-item"
            :class="{ active: activeIsDefault }"
            title="默认响应：无场景命中时返回"
            @click="activeId = DEFAULT_SCENE_ID"
          >
            <span class="scene-item-index">◈</span>
            <span class="scene-item-name">默认响应</span>
          </button>

          <div v-for="(s, i) in variantScenes" :key="s.localId" class="scene-item-row">
            <button
              type="button"
              class="scene-item"
              :class="{ active: activeId === s.localId }"
              :title="`场景 #${i + 1}：${s.name.trim() || '未命名'}`"
              @click="activeId = s.localId"
            >
              <span class="scene-item-index">{{ i + 1 }}</span>
              <span class="scene-item-name">{{ s.name.trim() || '未命名场景' }}</span>
            </button>
            <div class="scene-ops" :class="{ show: activeId === s.localId }">
              <button type="button" class="scene-op" title="上移（优先级更高）" :disabled="i === 0" @click="moveScene(s.localId, -1)">↑</button>
              <button type="button" class="scene-op" title="下移" :disabled="i === variantScenes.length - 1" @click="moveScene(s.localId, 1)">↓</button>
              <button type="button" class="scene-op danger" title="删除场景" @click="removeScene(s.localId)">×</button>
            </div>
          </div>

          <button type="button" class="scene-add" @click="addScene">＋ 新增场景</button>

          <p class="hint scene-side-hint" title="按顺序匹配：命中第一个条件全部通过的场景；都不命中走默认响应">按顺序匹配，都未命中走默认响应</p>
        </div>

        <div class="scene-main">
          <div v-if="!activeIsDefault" class="field scene-name-field">
            <label for="f-scene-name">场景名称</label>
            <input id="f-scene-name" v-model="activeScene.name" type="text" placeholder="如 管理员视角" spellcheck="false">
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
            <div class="kv-tabs mode-tabs">
              <button type="button" :class="{ active: bodyEditorMode === 'json' }" @click="setBodyMode('json')">JSON</button>
              <button type="button" :class="{ active: bodyEditorMode === 'table' }" @click="setBodyMode('table')">表格</button>
              <span class="hint mode-hint">
                {{ bodyEditorMode === 'json' ? '写期望的 JSON 子集，叶子字段即匹配条件' : '逐行配置点路径条件，可调类型与必填' }}
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
          <ConditionTable
            v-else
            :rows="sceneRows(activeScene.tab)"
            :key-placeholder="COND_TABS.find((t) => t.key === activeScene.tab)?.keyPh"
            :value-placeholder="COND_TABS.find((t) => t.key === activeScene.tab)?.valuePh"
            @update:rows="(rows) => setSceneRows(activeScene.tab, rows)"
          />

          <label v-if="activeIsDefault" class="switch-row switch-field" for="f-require-match">
            <span class="switch-text">
              <span class="switch-title">必须匹配请求条件</span>
              <span class="hint">开启后：所有请求需满足上方条件才能访问该接口，否则返回 400（优先于场景）</span>
            </span>
            <input id="f-require-match" v-model="requireMatch" type="checkbox" class="switch-input">
            <span class="switch-ui" aria-hidden="true"></span>
          </label>

          <div class="field resp-field">
            <div class="label-row">
              <label>返回响应</label>
              <span class="label-row-ops">
                <span v-if="activeIsDefault" class="hint">无场景命中时返回</span>
                <span class="hint" :title="TEMPLATE_HINT_TITLE">模板可用</span>
                <button type="button" class="mini-btn" title="格式化 JSON" @click="formatBodyText">格式化</button>
              </span>
            </div>
            <input v-model.number="activeScene.status" aria-label="响应状态码" type="number" min="100" max="599">
            <textarea
              v-model="activeScene.bodyText"
              rows="8"
              :placeholder="BODY_PLACEHOLDER"
              spellcheck="false"
              :class="{ invalid: activeScene.invalid }"
              @blur="validateBodyText(activeScene)"
              @input="onBodyInput(activeScene)"
            ></textarea>
            <p v-show="activeScene.invalid" class="field-error">body 不是合法的 JSON</p>
          </div>
        </div>
      </div>

      <!-- 高级选项：延迟 / 抖动 / 故障注入 / 停用（编辑态） -->
      <button
        type="button"
        class="advanced-toggle"
        :aria-expanded="advancedOpen"
        @click="advancedOpen = !advancedOpen"
      >
        ⚙ 高级选项 {{ advancedOpen ? '▾' : '▸' }}
      </button>
      <div v-if="advancedOpen" class="advanced-grid">
        <div class="field">
          <label for="f-delay-ms">延迟 ms</label>
          <input id="f-delay-ms" v-model.number="delayMs" type="number" min="0" max="60000" placeholder="0">
          <p class="hint">固定延迟</p>
        </div>
        <div class="field">
          <label for="f-jitter-ms">抖动 ms</label>
          <input id="f-jitter-ms" v-model.number="jitterMs" type="number" min="0" max="60000" placeholder="0">
          <p class="hint">随机抖动上限</p>
        </div>
        <div class="field">
          <label for="f-failure-rate">故障率 %</label>
          <input id="f-failure-rate" v-model.number="failureRate" type="number" min="0" max="100" step="1" placeholder="0">
          <p class="hint">按概率返回 500</p>
        </div>
        <label v-if="editing" class="switch-row" for="f-disabled">
          <span class="switch-text">
            <span class="switch-title">停用此接口（返回 404）</span>
          </span>
          <input id="f-disabled" v-model="disabledFlag" type="checkbox" class="switch-input">
          <span class="switch-ui" aria-hidden="true"></span>
        </label>

        <!-- 序列响应：按命中次序循环返回（独占一行） -->
        <div class="advanced-sequence">
          <label class="switch-row" for="f-sequence">
            <span class="switch-text">
              <span class="switch-title">序列响应</span>
              <span class="hint">按命中次序依次返回并循环，优先于场景变体与默认响应</span>
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

        <!-- 有状态 CRUD：同一集合需分别注册集合/条目路由 -->
        <label class="switch-row" for="f-crud">
          <span class="switch-text">
            <span class="switch-title">有状态 CRUD</span>
            <span class="hint">集合路由（无参数段）：GET=列表、POST=创建；条目路由（含 :id）：GET/PUT/DELETE 存取。需为同一集合分别注册路由</span>
          </span>
          <input id="f-crud" v-model="crudFlag" type="checkbox" class="switch-input">
          <span class="switch-ui" aria-hidden="true"></span>
        </label>

        <!-- 路由级认证：模拟后端鉴权，未携带正确凭证返回 401 -->
        <div class="field">
          <label for="f-auth-type">认证方式</label>
          <select id="f-auth-type" v-model="authType">
            <option value="none">无认证</option>
            <option value="apikey">API Key</option>
            <option value="bearer">Bearer Token</option>
          </select>
        </div>
        <div v-if="authType !== 'none'" class="field">
          <label for="f-auth-value">密钥 / 令牌值</label>
          <input id="f-auth-value" v-model="authValue" type="text" placeholder="如 my-secret-key" spellcheck="false">
          <p class="hint">未携带或错误返回 401</p>
        </div>
        <div v-if="authType === 'apikey'" class="field">
          <label for="f-auth-header">Header 名</label>
          <input id="f-auth-header" v-model="authHeader" type="text" placeholder="缺省 X-API-Key" spellcheck="false">
        </div>
      </div>

      <div class="form-actions">
        <button type="submit" class="submit-btn" :disabled="submitting">
          <span class="submit-plus">{{ editing ? '✓' : '＋' }}</span> {{ editing ? '保存修改' : '注册接口' }}
        </button>
        <button v-show="editing" type="button" class="cancel-btn" @click="emit('cancel-edit')">取消编辑</button>
      </div>
    </form>
  </aside>
</template>

<style scoped>
.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

/* ---------- 场景编辑器：左侧场景列表 + 右侧同构编辑区 ---------- */
.scene-editor {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.scene-side {
  display: grid;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-soft);
}

.scene-side-title {
  font-size: 11px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 2px;
}

.scene-item-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.scene-item {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.scene-item:hover { background: rgba(28, 39, 51, 0.05); color: var(--text); }

.scene-item.active {
  background: var(--accent-dim);
  border-color: rgba(14, 159, 93, 0.35);
  color: var(--accent-strong);
  font-weight: 600;
}

.scene-item-index {
  flex: none;
  font-size: 10px;
  color: var(--text-faint);
  min-width: 12px;
}

.scene-item.active .scene-item-index { color: var(--accent-strong); }

.scene-item-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scene-ops {
  flex: none;
  display: none;
  gap: 2px;
}

.scene-ops.show { display: flex; }

.scene-item-row:hover .scene-ops { display: flex; }

.scene-op {
  flex: none;
  width: 18px;
  height: 18px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text-faint);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s;
}

.scene-op:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--line-strong);
}

.scene-op:disabled { opacity: 0.35; cursor: default; }

.scene-op.danger:hover {
  color: var(--danger);
  border-color: var(--danger);
  background: rgba(207, 34, 46, 0.06);
}

.scene-add {
  justify-self: start;
  margin-top: 2px;
  padding: 4px 10px;
  border: 1px dashed rgba(14, 159, 93, 0.4);
  border-radius: 6px;
  background: none;
  color: var(--accent-strong);
  font-family: var(--mono);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.scene-add:hover { background: var(--accent-dim); }

.scene-side-hint { line-height: 1.6; }

/* ---------- 右侧编辑区 ---------- */
.scene-main {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.scene-name-field { margin-bottom: -2px; }

.scene-name-field input { padding: 7px 10px !important; font-size: 12px !important; }

.tab-count {
  margin-left: 5px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--bg-soft);
  border: 1px solid var(--line);
  color: var(--text-dim);
  font-size: 10px;
}

.body-json-editor {
  min-height: 120px;
  font-size: 12px;
  line-height: 1.55;
}

.resp-field {
  display: grid;
  gap: 8px;
  border-top: 1px dashed var(--line);
  padding-top: 12px;
}

.resp-field input[type='number'] {
  width: 110px;
}

.switch-field { margin-top: 2px; }

/* ---------- 高级选项扩展：路径参数提示 / 序列响应 ---------- */

.path-hint {
  margin-top: 6px;
}

/* 序列响应块独占一行：开关 + 草稿编辑器 */
.advanced-sequence {
  grid-column: 1 / -1;
  display: grid;
  gap: 8px;
}

.sequence-editor {
  min-height: 96px;
  font-size: 12px;
  line-height: 1.55;
}
</style>
