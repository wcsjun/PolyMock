<script setup lang="ts">
import { ref, watch } from 'vue';
import { createRoute, updateRoute } from '../api';
import type { NotifyFn, RequestCondition, Route, RoutePayload, ServiceInfo } from '../types';
import { buildRouteRequest, formatBody, splitRouteRequest } from '../utils';
import KvEditor from './KvEditor.vue';

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

type CondTab = 'query' | 'headers' | 'body';

const COND_TABS: Array<{ key: CondTab; label: string; keyPh: string; valuePh: string }> = [
  { key: 'query', label: 'Query', keyPh: '参数名，如 id', valuePh: '期望值，如 1001' },
  { key: 'headers', label: 'Headers', keyPh: '头名称，如 X-Token', valuePh: '期望值，如 abc123' },
  { key: 'body', label: 'Body', keyPh: 'JSON 路径，如 user.id', valuePh: '期望值，如 1001' },
];

const BODY_PLACEHOLDER = `{
  "code": 0,
  "data": {
    "id": 1001,
    "name": "PolyMock"
  }
}`;

interface VariantDraft {
  localId: number;
  name: string;
  tab: CondTab;
  query: RequestCondition[];
  headers: RequestCondition[];
  body: RequestCondition[];
  status: number | null;
  bodyText: string;
}

const serviceId = ref('');
const name = ref('');
const method = ref<string>('GET');
const path = ref('');
const status = ref<number | null>(200);
const body = ref('');
const bodyInvalid = ref(false);
const submitting = ref(false);
const pathInput = ref<HTMLInputElement | null>(null);

/* 默认响应的校验条件与开关 */
const condTab = ref<CondTab>('query');
const condQuery = ref<RequestCondition[]>([]);
const condHeaders = ref<RequestCondition[]>([]);
const condBody = ref<RequestCondition[]>([]);
const requireMatch = ref(false);

/* 响应变体（顺序即匹配优先级） */
let variantSeq = 0;
const variants = ref<VariantDraft[]>([]);

function newVariant(): VariantDraft {
  variantSeq += 1;
  return { localId: variantSeq, name: '', tab: 'headers', query: [], headers: [{ key: '', value: '' }], body: [], status: 200, bodyText: '' };
}

function addVariant() {
  variants.value.push(newVariant());
}

function removeVariant(index: number) {
  variants.value.splice(index, 1);
}

function moveVariant(index: number, delta: -1 | 1) {
  const target = index + delta;
  if (target < 0 || target >= variants.value.length) return;
  const list = variants.value;
  [list[index], list[target]] = [list[target], list[index]];
}

function setCondRows(tab: CondTab, rows: RequestCondition[]) {
  if (tab === 'query') condQuery.value = rows;
  else if (tab === 'headers') condHeaders.value = rows;
  else condBody.value = rows;
}

function condRows(tab: CondTab): RequestCondition[] {
  return tab === 'query' ? condQuery.value : tab === 'headers' ? condHeaders.value : condBody.value;
}

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
      status.value = route.response.status;
      body.value = formatBody(route.response.body);
      bodyInvalid.value = false;

      ({ query: condQuery.value, headers: condHeaders.value, body: condBody.value } = splitRouteRequest(route.request));
      requireMatch.value = route.requireMatch === true;
      variants.value = (route.variants ?? []).map((v) => ({
        ...newVariant(),
        name: v.name,
        ...splitRouteRequest(v.match),
        status: v.response.status,
        bodyText: formatBody(v.response.body),
        tab: 'headers',
      }));
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
  status.value = 200;
  body.value = '';
  bodyInvalid.value = false;
  condQuery.value = [];
  condHeaders.value = [];
  condBody.value = [];
  condTab.value = 'query';
  requireMatch.value = false;
  variants.value = [];
  serviceId.value = props.services.some((s) => s.id === keepService)
    ? keepService
    : props.services[0]?.id ?? '';
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
  const routeStatus = Number(status.value) || 200;

  if (!routePath.startsWith('/')) {
    props.notify('path 必须以 / 开头', 'err');
    return;
  }

  if (!editing && !routeName) {
    props.notify('请输入接口名称', 'err');
    return;
  }

  if (!ensureJson(body.value, 'body', () => { bodyInvalid.value = true; })) return;
  for (const v of variants.value) {
    if (!v.name.trim()) {
      props.notify('变体名称不能为空', 'err');
      return;
    }
    if (!ensureJson(v.bodyText, `变体「${v.name.trim()}」的 body`, () => {})) return;
  }

  submitting.value = true;
  try {
    /* 编辑态始终携带三个字段以便清除；新建态仅在有意义时携带 */
    const request = buildRouteRequest(condQuery.value, condHeaders.value, condBody.value);
    const draftVariants = variants.value.map((v) => ({
      name: v.name.trim(),
      match: buildRouteRequest(v.query, v.headers, v.body),
      response: { status: Number(v.status) || 200, body: v.bodyText.trim() },
    }));
    const payload: RoutePayload = {
      serviceId: serviceId.value,
      method: routeMethod,
      path: routePath,
      response: { status: routeStatus, body: body.value.trim() },
      request: editing ? (request ?? {}) : request,
      requireMatch: requireMatch.value,
      variants: draftVariants,
    };
    if (!editing) {
      if (!payload.request) delete payload.request;
      if (!payload.requireMatch) delete payload.requireMatch;
      if (!draftVariants.length) delete payload.variants;
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
      <h2>新增接口</h2>
    </div>

    <form id="route-form" autocomplete="off" @submit.prevent="submit">
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

      <div class="field">
        <label for="f-method">请求方法</label>
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

      <div class="field">
        <div class="label-row">
          <label>默认响应</label>
          <span class="hint">无变体命中时返回</span>
        </div>
        <div class="default-resp-row">
          <input v-model.number="status" aria-label="响应状态码" type="number" min="100" max="599">
          <textarea
            v-model="body"
            rows="6"
            :placeholder="BODY_PLACEHOLDER"
            spellcheck="false"
            :class="{ invalid: bodyInvalid }"
          ></textarea>
          <p v-show="bodyInvalid" class="field-error">body 不是合法的 JSON</p>
        </div>
      </div>

      <div class="field">
        <div class="kv-tabs">
          <button
            v-for="t in COND_TABS"
            :key="t.key"
            type="button"
            :class="{ active: condTab === t.key }"
            @click="condTab = t.key"
          >
            {{ t.label }}
          </button>
        </div>
        <KvEditor
          class="cond-editor"
          :rows="condRows(condTab)"
          :key-placeholder="COND_TABS.find((t) => t.key === condTab)?.keyPh"
          :value-placeholder="COND_TABS.find((t) => t.key === condTab)?.valuePh"
          @update:rows="(rows) => setCondRows(condTab, rows)"
        />
      </div>

      <div class="field switch-field">
        <label class="switch-row" for="f-require-match">
          <span class="switch-text">
            <span class="switch-title">必须匹配请求条件</span>
            <span class="hint">开启后：所有请求需满足上方条件才能访问该接口，否则返回 400（优先于变体）</span>
          </span>
          <input id="f-require-match" v-model="requireMatch" type="checkbox" class="switch-input">
          <span class="switch-ui" aria-hidden="true"></span>
        </label>
      </div>

      <div class="field">
        <div class="label-row">
          <label>响应变体（{{ variants.length }}）</label>
          <button type="button" class="variant-add" @click="addVariant">＋ 添加变体</button>
        </div>
        <p class="hint block-hint">按顺序匹配：第一个条件全部通过的变体生效；都不命中走默认响应</p>

        <div v-for="(v, i) in variants" :key="v.localId" class="variant-card">
          <div class="variant-head">
            <input v-model="v.name" type="text" class="variant-name" placeholder="场景名，如 管理员视角" spellcheck="false">
            <button type="button" class="variant-btn" title="上移（优先级更高）" :disabled="i === 0" @click="moveVariant(i, -1)">↑</button>
            <button type="button" class="variant-btn" title="下移" :disabled="i === variants.length - 1" @click="moveVariant(i, 1)">↓</button>
            <button type="button" class="variant-btn danger" title="删除变体" @click="removeVariant(i)">×</button>
          </div>

          <div class="kv-tabs mini">
            <button
              v-for="t in COND_TABS"
              :key="t.key"
              type="button"
              :class="{ active: v.tab === t.key }"
              @click="v.tab = t.key"
            >
              {{ t.label }}
            </button>
          </div>
          <KvEditor
            :rows="v.tab === 'query' ? v.query : v.tab === 'headers' ? v.headers : v.body"
            :key-placeholder="COND_TABS.find((t) => t.key === v.tab)?.keyPh"
            :value-placeholder="COND_TABS.find((t) => t.key === v.tab)?.valuePh"
            @update:rows="(rows) => { if (v.tab === 'query') v.query = rows; else if (v.tab === 'headers') v.headers = rows; else v.body = rows; }"
          />

          <div class="variant-resp">
            <input v-model.number="v.status" aria-label="变体状态码" type="number" min="100" max="599">
            <textarea v-model="v.bodyText" rows="3" placeholder="变体响应 Body（JSON）" spellcheck="false"></textarea>
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
.default-resp-row {
  display: grid;
  gap: 8px;
}

.default-resp-row input[type='number'] {
  width: 110px;
}
</style>
