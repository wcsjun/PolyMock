<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { createRoute, updateRoute } from '../api';
import type { ConditionRow, NotifyFn, Route, RoutePayload, ServiceInfo } from '../types';
import { buildRouteRequest, formatBody, splitRouteRequest } from '../utils';
import ConditionTable from './ConditionTable.vue';

const props = defineProps<{
  services: ServiceInfo[];
  editing: Route | null;
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

const activeIndex = computed(() => {
  const idx = scenes.value.findIndex((s) => s.localId === activeId.value);
  return idx === -1 ? 0 : idx;
});

const activeScene = computed(() => scenes.value[activeIndex.value]);

const activeIsDefault = computed(() => activeId.value === DEFAULT_SCENE_ID);

const variantScenes = computed(() => scenes.value.filter((s) => s.localId !== DEFAULT_SCENE_ID));

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
  (route) => {
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

/** 校验一段 body 文本，非法时标红并提示；返回是否合法 */
function ensureJson(text: string, label: string, markInvalid: () => void): boolean {
  const raw = text.trim();
  if (!raw) return true;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    markInvalid();
    props.notify(`${label} 不是合法的 JSON`, 'err');
    return false;
  }
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
    };
    if (!editing) {
      if (!payload.request) delete payload.request;
      if (!payload.requireMatch) delete payload.requireMatch;
      if (!variants.length) delete payload.variants;
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
    pathInput.value?.focus();
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
    </div>

    <form id="route-form" autocomplete="off" @submit.prevent="submit">
      <div class="field-grid">
        <div class="field">
          <label for="f-service">服务分组</label>
          <select id="f-service" v-model="serviceId">
            <option v-for="s in services" :key="s.id" :value="s.id">{{ s.name }} :{{ s.port }}</option>
          </select>
        </div>

        <div class="field">
          <label for="f-name">接口名称</label>
          <input id="f-name" v-model="name" name="name" type="text" placeholder="如 查询用户信息" spellcheck="false">
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

          <p class="hint scene-side-hint">按顺序匹配：命中第一个条件全部通过的场景；都不命中走默认响应</p>
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

          <p class="hint block-hint">
            {{ activeIsDefault
              ? '准入条件：开启「必须匹配」后，不满足条件的请求将返回 400'
              : '命中条件：请求满足所有启用行时命中本场景' }}
          </p>

          <ConditionTable
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
              <span v-if="activeIsDefault" class="hint">无场景命中时返回</span>
            </div>
            <input v-model.number="activeScene.status" aria-label="响应状态码" type="number" min="100" max="599">
            <textarea
              v-model="activeScene.bodyText"
              rows="8"
              :placeholder="BODY_PLACEHOLDER"
              spellcheck="false"
              :class="{ invalid: activeScene.invalid }"
            ></textarea>
            <p v-show="activeScene.invalid" class="field-error">body 不是合法的 JSON</p>
          </div>
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
  grid-template-columns: 132px minmax(0, 1fr);
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
</style>
