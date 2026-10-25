<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { createRoute, updateRoute } from '../api';
import type { PreviewRoute } from '../match-preview';
import type {
  BodyMatchMode,
  CallbackTemplateInfo,
  ConditionRow,
  ConditionSource,
  NotifyFn,
  PolyMockMode,
  Route,
  RouteRequest,
  ServiceInfo,
} from '../types';
import {
  buildCompanionRoutes,
  buildRouteRequest,
  isTemplateJsonValid,
  isValidRegex,
  parseSequenceDraft,
} from '../utils';
import {
  DEFAULT_SCENE_ID,
  backfillDraft,
  buildAuthPayload,
  buildRoutePayload,
  defaultScene,
  sceneIsJsonMode,
  type CompanionDraft,
  type SceneDraft,
} from '../route-form-draft';
import AdmissionSection from './route-form/AdmissionSection.vue';
import AdvancedSection from './route-form/AdvancedSection.vue';
import BasicsSection from './route-form/BasicsSection.vue';
import BranchesSection from './route-form/BranchesSection.vue';
import PreviewSection from './route-form/PreviewSection.vue';

const props = defineProps<{
  services: ServiceInfo[];
  editing: Route | null;
  /** 运行模式：决定服务分组下拉的后缀展示（端口模式 :端口 / 路径模式 basePath 前缀） */
  mode: PolyMockMode;
  notify: NotifyFn;
  /** 侧边栏当前全局场景集：非空时「匹配预览」按强制命中同名分支推演 */
  activeVariant?: string;
  /** 全局回调模板列表：高级选项「异步回调」引用模式的下拉数据源 */
  templates?: CallbackTemplateInfo[];
}>();

const emit = defineEmits<{
  changed: [];
  'cancel-edit': [];
}>();

/* ---------- 表单状态（各分区经 props / v-model 传入五段子组件，职责见 route-form/ 目录） ---------- */

const serviceId = ref('');
const name = ref('');
const method = ref<string>('GET');
const path = ref('');
const submitting = ref(false);

/* ---------- 请求准入（共享门槛，映射 request + requireMatch） ---------- */

const gateOn = ref(false);
/** 准入门槛区默认折叠：折叠态靠头部徽标显示开启/关闭 */
const gateOpen = ref(false);
/** 扁平条件列表：每行自带来源（Params / Headers / Body） */
const gateRows = ref<ConditionRow[]>([]);
const gateBodyMatch = ref<BodyMatchMode>('subset');
const gateBodyRaw = ref('');

/** 准入失败码：400（缺省）/ 404（隐藏接口）/ 422 */
const gateStatus = ref<400 | 404 | 422>(400);

/* ---------- 响应分支 ---------- */

const scenes = ref<SceneDraft[]>([defaultScene()]);
const activeId = ref<number>(DEFAULT_SCENE_ID);

/* ---------- 高级选项 ---------- */

const advancedOpen = ref(false);
const previewOpen = ref(false);

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

/* 请求体模板渲染开关（默认开启，随 payload.renderRequest 提交；仅关闭时携带 false） */
const renderRequestFlag = ref(true);

/* 自定义响应头总开关：关闭时不提交任何场景的响应头（编辑已有响应头时自动展开） */
const customHeadersOn = ref(false);

/* 路由级认证：none 关闭；apikey = 自定义 header 携带密钥；bearer = Authorization: Bearer <token> */
const authType = ref<'none' | 'apikey' | 'bearer'>('none');
const authValue = ref('');
const authHeader = ref('');

/* ---------- Body 子集编辑器（行编辑 ⇄ JSON 子集） ---------- */

const bodyEditorMode = ref<'rows' | 'json'>('rows');
const bodyJson = ref('');
const bodyJsonInvalid = ref(false);

/* ---------- 派生状态 ---------- */

const variantScenes = computed(() => scenes.value.filter((s) => s.localId !== DEFAULT_SCENE_ID));

/* 进度指示：基本信息 / 请求准入 / 响应分支 */
const progressSteps = computed(() => [
  { label: '1 基本信息', on: path.value.trim().startsWith('/') && (!!props.editing || name.value.trim() !== '') },
  { label: '2 请求准入', on: gateOn.value },
  { label: '3 响应分支', on: variantScenes.value.length > 0 },
]);

/** 有可提交的准入配置：至少一条启用的条件，或非 subset 且填了期望值 */
function hasGateConfig(): boolean {
  const enabledRows = gateRows.value.some((row) => row.enabled && row.key.trim());
  return enabledRows || (gateBodyMatch.value !== 'subset' && gateBodyRaw.value.trim() !== '');
}

/* ---------- 校验辅助 ---------- */

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

/** 解析高级选项数值：要求 0-max 整数，空输入按 0（未设置）处理；非法时提示并返回 null */
function parseAdvancedValue(raw: number | '', max: number, label: string): number | null {
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 0 || num > max) {
    props.notify(`${label} 必须是 0-${max} 的整数`, 'err');
    return null;
  }
  return num;
}

/** body 匹配策略校验：非 subset 必须填写合法期望值；返回错误文案或 null */
function bodyStrategyError(mode: BodyMatchMode, raw: string, label: string): string | null {
  if (mode === 'subset') return null;
  if (!raw.trim()) return `${label}选择了「${mode === 'deepEqual' ? '完整 JSON 相等' : '原文全文相等'}」，请填写期望值`;
  if (mode === 'deepEqual' && !isValidJson(raw)) return `${label}的期望值不是合法的 JSON`;
  return null;
}

/** 正则行校验：返回错误文案或 null（正则无法解析时后端永远不会命中，提前拦住） */
function regexRowError(rows: ConditionRow[], label: string): string | null {
  const bad = rows.find((row) => row.enabled && row.match === 'regex' && row.key.trim() && !isValidRegex(row.value));
  return bad ? `${label}中「${bad.key.trim()}」的正则表达式不合法` : null;
}

/** 空 key 但已启用的行：按既有语义跳过提交，仅提示 */
function warnEmptyKeys(rows: ConditionRow[], label: string) {
  if (rows.some((row) => row.enabled && row.key.trim() === '')) {
    props.notify(`${label}中存在未填写参数名的启用行，已跳过`, 'warn');
  }
}

/* ---------- 提交 ---------- */

/** 准入区的请求条件（编辑态与预览共用） */
function buildGateRequest(): RouteRequest | undefined {
  return buildRouteRequest(gateRowsOf('query'), gateRowsOf('headers'), gateRowsOf('body'), gateBodyMatch.value, gateBodyRaw.value);
}

/** 分支的匹配条件（预览用；提交组装在 route-form-draft.ts） */
function buildSceneMatch(scene: SceneDraft): RouteRequest | undefined {
  return buildRouteRequest(scene.rows.query, scene.rows.headers, scene.rows.body, scene.bodyMatch, scene.bodyRaw);
}

/** 准入行按来源取子集（buildGateRequest 用） */
function gateRowsOf(source: ConditionSource): ConditionRow[] {
  return gateRows.value.filter((row) => (row.source ?? 'query') === source);
}

/** 预览用：响应 body 文本按 JSON 解析（失败时原样展示） */
function previewBody(text: string): unknown {
  const raw = text.trim();
  if (!raw) return undefined;
  if (raw.includes('{{')) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function submit() {
  const editing = props.editing;
  const routeName = name.value.trim();
  const routePath = path.value.trim();
  const routeMethod = method.value;
  const def = scenes.value[0];

  if (!routePath.startsWith('/')) {
    props.notify('path 必须以 / 开头', 'err');
    return;
  }

  if (!editing && !routeName) {
    props.notify('请输入接口名称', 'err');
    return;
  }

  /* 请求准入校验：开启时至少要有一条可生效的条件；body 策略与正则需合法 */
  if (gateOn.value && !hasGateConfig()) {
    props.notify('请求准入已开启，请至少配置一条共享条件（存在 / 等于 / 非空 / 正则 或 body 匹配策略）', 'err');
    return;
  }
  const gateBodyError = bodyStrategyError(gateBodyMatch.value, gateBodyRaw.value, '请求准入');
  if (gateBodyError) {
    props.notify(gateBodyError, 'err');
    return;
  }
  const gateRegexError = regexRowError(gateRows.value, '请求准入');
  if (gateRegexError) {
    props.notify(gateRegexError, 'err');
    return;
  }
  warnEmptyKeys(gateRows.value, '请求准入');

  if (sceneIsJsonMode(def, customHeadersOn.value) && !ensureJson(def.bodyText, '默认响应 body', () => { def.invalid = true; })) return;

  const seenNames = new Set<string>();
  for (const scene of variantScenes.value) {
    const sceneName = scene.name.trim();
    if (!sceneName) {
      props.notify('分支名称不能为空', 'err');
      return;
    }
    if (seenNames.has(sceneName)) {
      props.notify(`分支名称「${sceneName}」重复`, 'err');
      return;
    }
    seenNames.add(sceneName);
    const strategyError = bodyStrategyError(scene.bodyMatch, scene.bodyRaw, `分支「${sceneName}」`);
    if (strategyError) {
      props.notify(strategyError, 'err');
      return;
    }
    const regexError = regexRowError([...scene.rows.query, ...scene.rows.headers, ...scene.rows.body], `分支「${sceneName}」`);
    if (regexError) {
      props.notify(regexError, 'err');
      return;
    }
    warnEmptyKeys([...scene.rows.query, ...scene.rows.headers, ...scene.rows.body], `分支「${sceneName}」`);
    if (sceneIsJsonMode(scene, customHeadersOn.value) && !ensureJson(scene.bodyText, `分支「${sceneName}」的 body`, () => { scene.invalid = true; })) return;
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
    /* 提交组装的纯函数版在 route-form-draft.ts（含新建/编辑两种携带语义，由该模块单测覆盖） */
    const payload = buildRoutePayload({
      editing: !!editing,
      serviceId: serviceId.value,
      name: routeName,
      method: routeMethod,
      path: routePath,
      gate: { on: gateOn.value, rows: gateRows.value, bodyMatch: gateBodyMatch.value, bodyRaw: gateBodyRaw.value, status: gateStatus.value },
      scenes: scenes.value,
      customHeadersOn: customHeadersOn.value,
      delayMs: delayMs.value,
      jitterMs: jitterMs.value,
      failureRate: failureRate.value,
      disabled: disabledFlag.value,
      sequence: sequencePayload,
      crud: crudFlag.value,
      renderRequest: renderRequestFlag.value,
      editingRenderRequest: editing?.renderRequest,
      auth: { type: authType.value, value: authValue.value, header: authHeader.value },
      templates: props.templates ?? [],
    });

    if (editing) {
      await updateRoute(editing.id, payload);
      props.notify(`已更新 ${routeMethod} ${routePath}`);
      emit('cancel-edit');
    } else {
      await createRoute(payload);
      /* 一键创建配套 CRUD 路由：复用现有注册端点循环提交（仅 crud:true + auth 语义随行，条件/变体不携带）；已存在（形状冲突 409）跳过并汇总 */
      const authPayload = buildAuthPayload({ type: authType.value, value: authValue.value, header: authHeader.value });
      const companions = companionRoutes.value.filter((c) => companionSelection.value[c.key] !== false);
      let created = 0;
      let skipped = 0;
      let failed = 0;
      for (const companion of companions) {
        try {
          await createRoute({
            serviceId: payload.serviceId,
            method: companion.method,
            path: companion.path,
            name: companion.name,
            response: { status: 200, body: '{}' },
            crud: true,
            ...(authPayload ? { auth: authPayload } : {}),
          });
          created += 1;
        } catch (err) {
          if (String((err as Error).message).includes('形状冲突')) skipped += 1;
          else failed += 1;
        }
      }
      const summary: string[] = [];
      if (created) summary.push(`新建配套 ${created} 条`);
      if (skipped) summary.push(`跳过已存在 ${skipped} 条`);
      if (failed) {
        props.notify(`已注册 ${routeMethod} ${routePath}；${summary.length ? summary.join('，') + '，' : ''}${failed} 条配套路由创建失败`, 'warn');
      } else {
        props.notify(summary.length ? `已注册 ${routeMethod} ${routePath}（${summary.join('，')}）` : `已注册 ${routeMethod} ${routePath}`);
      }
      resetForm();
    }
    emit('changed');
  } catch (err) {
    props.notify((err as Error).message, 'err');
  } finally {
    submitting.value = false;
  }
}

/* ---------- 一键创建配套路由（仅新建态） ---------- */

const companionSelection = ref<Record<string, boolean>>({});

/** 由当前路径/方法/名称推导同集合的其余 CRUD 操作（已排除主路由自身）；主路由为条目路径时同样成立 */
const companionRoutes = computed<CompanionDraft[]>(() => {
  if (!crudFlag.value || props.editing) return [];
  const routePath = path.value.trim();
  if (!routePath.startsWith('/')) return [];
  return buildCompanionRoutes(routePath, method.value, name.value).map((companion) => ({
    key: `${companion.method} ${companion.path}`,
    method: companion.method,
    path: companion.path,
    name: companion.name,
  }));
});

/* 新出现的配套路由默认勾选；已手动取消过的保持取消 */
watch(companionRoutes, (list) => {
  for (const companion of list) {
    if (!(companion.key in companionSelection.value)) companionSelection.value[companion.key] = true;
  }
});

/* ---------- 匹配预览（纯前端推演） ---------- */

const previewRoute = computed<PreviewRoute>(() => {
  const def = scenes.value[0];
  const parsedSequence = sequenceOn.value ? parseSequenceDraft(sequenceText.value) : undefined;
  const gateRequest = buildGateRequest();
  const routePath = path.value.trim() || '/';
  return {
    method: method.value,
    path: routePath,
    pathPattern: routePath,
    disabled: disabledFlag.value,
    auth:
      authType.value === 'none'
        ? undefined
        : { type: authType.value, value: authValue.value.trim(), ...(authHeader.value.trim() ? { header: authHeader.value.trim() } : {}) },
    request: gateRequest,
    requireMatch: gateOn.value,
    gateStatus: gateStatus.value,
    variants: variantScenes.value.map((scene) => ({
      name: scene.name.trim() || '未命名分支',
      match: buildSceneMatch(scene),
      response: { status: Number(scene.status) || 200, body: previewBody(scene.bodyText) },
    })),
    sequence: parsedSequence?.ok ? parsedSequence.value.map((step) => ({ status: step.status, body: previewBody(step.body) })) : [],
    defaultResponse: { status: Number(def.status) || 200, body: previewBody(def.bodyText) },
    activeVariant: props.activeVariant ?? '',
  };
});

/* ---------- 服务下拉与编辑态回填 ---------- */

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

/* 基本信息段的路径输入框引用：编辑回填后聚焦 */
const basicsRef = ref<InstanceType<typeof BasicsSection> | null>(null);

/* 进入/退出编辑模式：回填表单或复位（保持服务分组选择） */
watch(
  () => props.editing,
  async (route) => {
    if (route) {
      if (props.services.some((s) => s.id === route.serviceId)) {
        serviceId.value = route.serviceId;
      }
      /* 回填初值的纯函数版在 route-form-draft.ts（backfillDraft），此处仅负责写回 refs */
      const draft = backfillDraft(route);
      name.value = draft.name;
      method.value = draft.method;
      path.value = draft.path;

      gateOn.value = draft.gate.on;
      gateRows.value = draft.gate.rows;
      gateBodyMatch.value = draft.gate.bodyMatch;
      gateBodyRaw.value = draft.gate.bodyRaw;
      gateStatus.value = draft.gate.status;

      scenes.value = draft.scenes;
      activeId.value = DEFAULT_SCENE_ID;
      customHeadersOn.value = draft.customHeadersOn;

      delayMs.value = draft.advanced.delayMs;
      jitterMs.value = draft.advanced.jitterMs;
      failureRate.value = draft.advanced.failureRate;
      disabledFlag.value = draft.advanced.disabled;

      sequenceOn.value = draft.sequence.on;
      sequenceText.value = draft.sequence.text;
      sequenceInvalid.value = false;
      crudFlag.value = draft.crud;
      renderRequestFlag.value = draft.renderRequest;

      authType.value = draft.auth.type;
      authValue.value = draft.auth.value;
      authHeader.value = draft.auth.header;

      bodyEditorMode.value = 'rows';
      gateOpen.value = false;
      advancedOpen.value = false;
      previewOpen.value = false;

      /* 表单挂在抽屉里，等抽屉显示后再聚焦 */
      await nextTick();
      basicsRef.value?.focusPath();
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
  gateOn.value = false;
  gateRows.value = [];
  gateBodyMatch.value = 'subset';
  gateBodyRaw.value = '';
  gateStatus.value = 400;
  delayMs.value = '';
  jitterMs.value = '';
  failureRate.value = '';
  disabledFlag.value = false;
  sequenceOn.value = false;
  sequenceText.value = '';
  sequenceInvalid.value = false;
  crudFlag.value = false;
  renderRequestFlag.value = true;
  customHeadersOn.value = false;
  companionSelection.value = {};
  authType.value = 'none';
  authValue.value = '';
  authHeader.value = '';
  scenes.value = [defaultScene()];
  activeId.value = DEFAULT_SCENE_ID;
  bodyEditorMode.value = 'rows';
  bodyJson.value = '';
  bodyJsonInvalid.value = false;
  gateOpen.value = false;
  previewOpen.value = false;
  serviceId.value = props.services.some((s) => s.id === keepService) ? keepService : props.services[0]?.id ?? '';
}
</script>

<template>
  <aside class="panel form-panel">
    <div class="panel-head">
      <h2>{{ editing ? '编辑接口' : '新增接口' }}</h2>
      <button type="button" class="drawer-close" title="关闭（Esc）" aria-label="关闭" @click="emit('cancel-edit')">×</button>
    </div>

    <form id="route-form" autocomplete="off" @submit.prevent="submit">
      <div class="form-progress" aria-label="表单分区">
        <span v-for="step in progressSteps" :key="step.label" :class="{ on: step.on }">{{ step.label }}</span>
      </div>

      <BasicsSection
        ref="basicsRef"
        :editing="!!editing"
        :mode="mode"
        :services="services"
        v-model:service-id="serviceId"
        v-model:name="name"
        v-model:method="method"
        v-model:path="path"
      />

      <AdmissionSection
        :rows="gateRows"
        v-model:gate-on="gateOn"
        v-model:gate-open="gateOpen"
        v-model:gate-body-match="gateBodyMatch"
        v-model:gate-body-raw="gateBodyRaw"
        v-model:gate-status="gateStatus"
        @update:rows="gateRows = $event"
      />

      <BranchesSection
        :scenes="scenes"
        :custom-headers-on="customHeadersOn"
        :notify="notify"
        v-model:active-id="activeId"
        v-model:body-editor-mode="bodyEditorMode"
        v-model:body-json="bodyJson"
        v-model:body-json-invalid="bodyJsonInvalid"
      />

      <AdvancedSection
        :scenes="scenes"
        :active-id="activeId"
        :editing="!!editing"
        :companion-routes="companionRoutes"
        :companion-selection="companionSelection"
        :notify="notify"
        v-model:advanced-open="advancedOpen"
        v-model:delay-ms="delayMs"
        v-model:jitter-ms="jitterMs"
        v-model:failure-rate="failureRate"
        v-model:auth-type="authType"
        v-model:auth-value="authValue"
        v-model:auth-header="authHeader"
        v-model:render-request-flag="renderRequestFlag"
        v-model:crud-flag="crudFlag"
        v-model:disabled-flag="disabledFlag"
        v-model:sequence-on="sequenceOn"
        v-model:sequence-text="sequenceText"
        v-model:sequence-invalid="sequenceInvalid"
        v-model:custom-headers-on="customHeadersOn"
        :templates="templates ?? []"
      />

      <PreviewSection
        v-model:preview-open="previewOpen"
        :preview-route="previewRoute"
        :method="method"
        :path="path"
      />

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
/* 五段卡片的分区样式已随模板拆入 route-form/ 各段组件；本组件仅保留表单壳 */
.form-progress {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--text-faint);
}

.form-progress span {
  padding: 4px 8px;
  border-radius: 5px;
  background: var(--bg-soft);
}

.form-progress span.on {
  color: var(--accent-strong);
  background: var(--accent-dim);
  font-weight: 600;
}
</style>
