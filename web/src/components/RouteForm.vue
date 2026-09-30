<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { createRoute, updateRoute } from '../api';
import type { PreviewRoute } from '../match-preview';
import type {
  BodyMatchMode,
  ConditionRow,
  ConditionSource,
  NotifyFn,
  PolyMockMode,
  ResponseHeader,
  Route,
  RouteAuth,
  RoutePayload,
  RouteRequest,
  ServiceInfo,
} from '../types';
import {
  BODY_MATCH_LABELS,
  buildCompanionRoutes,
  buildRouteRequest,
  bodyRowsToJsonValue,
  formatBody,
  isJsonContentType,
  isTemplateJsonValid,
  isValidRegex,
  jsonValueToBodyRows,
  methodColor,
  parseSequenceDraft,
  sequenceToDraftText,
  serviceDisplaySuffix,
  splitRouteRequest,
} from '../utils';
import ConditionTable from './ConditionTable.vue';
import MatchPreview from './MatchPreview.vue';

const props = defineProps<{
  services: ServiceInfo[];
  editing: Route | null;
  /** 运行模式：决定服务分组下拉的后缀展示（端口模式 :端口 / 路径模式 basePath 前缀） */
  mode: PolyMockMode;
  notify: NotifyFn;
  /** 侧边栏当前全局场景集：非空时「匹配预览」按强制命中同名分支推演 */
  activeVariant?: string;
}>();

const emit = defineEmits<{
  changed: [];
  'cancel-edit': [];
}>();

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const DEFAULT_SCENE_ID = 0;

type CondTab = 'query' | 'headers' | 'body';

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

/* 完整 JSON / 原文期望值占位示例 */
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

/* 路径参数提示（含 {{ }} 字面量，同上须经常量绑定渲染） */
const PATH_PARAM_HINT = '支持 :参数 段，如 /api/users/:id，响应模板可用 {{params.id}}';

/* 请求体模板渲染说明（含 {{ }} 字面量，须经 :title 绑定常量，避免被模板插值解析） */
const RENDER_REQUEST_HINT_TITLE =
  '请求体字符串支持：{{query.参数名}} {{header.头名}} {{params.参数名}} {{body.同请求体其他字段}} {{$id}} 自增 {{$now}} 当前时间 {{$int(1,99)}} 随机整数 及 {{$name}} 等假数据；渲染结果参与条件匹配，也会被响应模板的 {{body.*}} 取到。取不到值的占位符原样保留；{{$id}} 与响应共用同一路由自增计数；不含占位符的请求体不受影响。关闭后请求体按客户端原文参与匹配。';

/* 序列响应编辑器的占位示例（JSON 数组，每步 status + body） */
const SEQUENCE_PLACEHOLDER = `[
  { "status": 200, "body": { "mode": "first" } },
  { "status": 500, "body": { "error": "boom" } }
]`;

type SceneRows = Record<CondTab, ConditionRow[]>;

function emptyRows(): SceneRows {
  return { query: [], headers: [], body: [] };
}

/** 一个响应分支 = 条件（rows + body 策略）+ 返回响应；localId 0 固定为默认响应（fallback） */
interface SceneDraft {
  localId: number;
  name: string;
  tab: CondTab;
  rows: SceneRows;
  /** body 匹配策略（subset 逐条子集 / deepEqual 完整 JSON / textEqual 原文全文） */
  bodyMatch: BodyMatchMode;
  /** 非 subset 策略下的期望完整 JSON 或原文 */
  bodyRaw: string;
  status: number | null;
  /** 自定义响应头（key/value 行编辑；由「启用自定义响应头」总开关控制是否提交） */
  headerRows: ResponseHeader[];
  bodyText: string;
  invalid: boolean;
}

let sceneSeq = 0;

function newScene(name: string): SceneDraft {
  sceneSeq += 1;
  return {
    localId: sceneSeq,
    name,
    tab: 'query',
    rows: emptyRows(),
    bodyMatch: 'subset',
    bodyRaw: '',
    status: 200,
    headerRows: [],
    bodyText: '',
    invalid: false,
  };
}

function defaultScene(): SceneDraft {
  return { ...newScene('默认响应'), localId: DEFAULT_SCENE_ID };
}

/* ---------- 基本信息 ---------- */

const serviceId = ref('');
const name = ref('');
const method = ref<string>('GET');
const path = ref('');
const pathInput = ref<HTMLInputElement | null>(null);
const submitting = ref(false);

/* ---------- 请求准入（共享门槛，映射 request + requireMatch） ---------- */

const gateOn = ref(false);
/** 扁平条件列表：每行自带来源（Params / Headers / Body） */
const gateRows = ref<ConditionRow[]>([]);
const gateBodyMatch = ref<BodyMatchMode>('subset');
const gateBodyRaw = ref('');

/** 准入失败码：400（缺省）/ 404（隐藏接口）/ 422 */
const gateStatuses = [400, 404, 422] as const;
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

const activeIndex = computed(() => {
  const idx = scenes.value.findIndex((s) => s.localId === activeId.value);
  return idx === -1 ? 0 : idx;
});

const activeScene = computed(() => scenes.value[activeIndex.value]);

const activeIsDefault = computed(() => activeId.value === DEFAULT_SCENE_ID);

const variantScenes = computed(() => scenes.value.filter((s) => s.localId !== DEFAULT_SCENE_ID));

const activeBranchLabel = computed(() => (activeIsDefault.value ? '默认响应' : activeScene.value.name.trim() || '未命名分支'));

/* 进度指示：基本信息 / 请求准入 / 响应分支 */
const progressSteps = computed(() => [
  { label: '1 基本信息', on: path.value.trim().startsWith('/') && (!!props.editing || name.value.trim() !== '') },
  { label: '2 请求准入', on: gateOn.value },
  { label: '3 响应分支', on: variantScenes.value.length > 0 },
]);

/* 准入区：来源计数与 body 策略可见性 */
const gateBodyRowCount = computed(() => gateRows.value.filter((row) => (row.source ?? 'query') === 'body').length);
const gateShowsStrategy = computed(() => gateBodyRowCount.value > 0 || gateBodyMatch.value !== 'subset');
const gateVisibleRows = computed(() =>
  gateBodyMatch.value === 'subset' ? gateRows.value : gateRows.value.filter((row) => (row.source ?? 'query') !== 'body'),
);

const gateBodyHint = computed(() => BODY_MATCH_LABELS.find((m) => m.value === gateBodyMatch.value)?.hint ?? '');

function gateRowsOf(source: ConditionSource): ConditionRow[] {
  return gateRows.value.filter((row) => (row.source ?? 'query') === source);
}

/** 准入区行列表被编辑：非 subset 策略下 body 行不在列表中，需保留原值合并回去 */
function setGateVisibleRows(rows: ConditionRow[]) {
  if (gateBodyMatch.value === 'subset') {
    gateRows.value = rows;
    return;
  }
  const bodyRows = gateRows.value.filter((row) => (row.source ?? 'query') === 'body');
  gateRows.value = [...rows, ...bodyRows];
}

/** 有可提交的准入配置：至少一条启用的条件，或非 subset 且填了期望值 */
function hasGateConfig(): boolean {
  const enabledRows = gateRows.value.some((row) => row.enabled && row.key.trim());
  return enabledRows || (gateBodyMatch.value !== 'subset' && gateBodyRaw.value.trim() !== '');
}

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
  const list = [...scenes.value];
  const [moved] = list.splice(fromIdx, 1);
  list.splice(toIdx, 0, moved);
  scenes.value = list;
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

/* ---------- 生效 Content-Type：自定义响应头中的 Content-Type 行决定 JSON/文本模式 ---------- */

/** 场景是否 JSON 模式（未启用自定义响应头时按 JSON；启用后由 Content-Type 行决定） */
function sceneIsJsonMode(scene: SceneDraft): boolean {
  if (!customHeadersOn.value) return true;
  const ctRow = scene.headerRows.find((h) => h.key.trim().toLowerCase() === 'content-type');
  return isJsonContentType(ctRow?.value.trim() || undefined);
}

/** 当前编辑分支是否文本模式（body 编辑器据此切换校验与提示） */
const activeSceneTextMode = computed(() => !sceneIsJsonMode(activeScene.value));

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

/* ---------- 自定义响应头 ---------- */

function addResponseHeader() {
  activeScene.value.headerRows.push({ key: '', value: '' });
}

function removeResponseHeader(index: number) {
  activeScene.value.headerRows.splice(index, 1);
}

/** 提交用：过滤空 key 行；全空返回 undefined（payload 省略该字段） */
function buildResponseHeaders(scene: SceneDraft): ResponseHeader[] | undefined {
  const rows = scene.headerRows.map((row) => ({ key: row.key.trim(), value: row.value })).filter((row) => row.key);
  return rows.length ? rows : undefined;
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

/** body 失焦时即时校验，非法标红；文本模式（响应头声明非 JSON Content-Type）不做 JSON 校验 */
function validateBodyText(scene: SceneDraft) {
  const raw = scene.bodyText.trim();
  scene.invalid = raw && sceneIsJsonMode(scene) ? !isTemplateJsonValid(raw) : false;
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

/** 格式化当前分支的 body 文本；非法时报错并标红；文本模式不做 JSON 格式化 */
function formatBodyText() {
  const scene = activeScene.value;
  if (!sceneIsJsonMode(scene)) {
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

/** 分支的匹配条件 */
function buildSceneMatch(scene: SceneDraft): RouteRequest | undefined {
  return buildRouteRequest(scene.rows.query, scene.rows.headers, scene.rows.body, scene.bodyMatch, scene.bodyRaw);
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

  if (sceneIsJsonMode(def) && !ensureJson(def.bodyText, '默认响应 body', () => { def.invalid = true; })) return;

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
    if (sceneIsJsonMode(scene) && !ensureJson(scene.bodyText, `分支「${sceneName}」的 body`, () => { scene.invalid = true; })) return;
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
    /* 编辑态始终携带 request / requireMatch / gateStatus 以便清除或复位；新建态仅在有意义时携带 */
    const gateRequest = buildGateRequest();
    const defHeaders = customHeadersOn.value ? buildResponseHeaders(def) : undefined;
    const variants = variantScenes.value.map((scene) => {
      const sceneHeaders = customHeadersOn.value ? buildResponseHeaders(scene) : undefined;
      return {
        name: scene.name.trim(),
        match: buildSceneMatch(scene),
        response: { status: Number(scene.status) || 200, ...(sceneHeaders ? { headers: sceneHeaders } : {}), body: scene.bodyText.trim() },
      };
    });
    const payload: RoutePayload = {
      serviceId: serviceId.value,
      method: routeMethod,
      path: routePath,
      response: { status: Number(def.status) || 200, ...(defHeaders ? { headers: defHeaders } : {}), body: def.bodyText.trim() },
      request: editing ? (gateRequest ?? {}) : gateRequest,
      requireMatch: gateOn.value,
      gateStatus: gateStatus.value,
      variants,
      delayMs: delayVal,
      jitterMs: jitterVal,
      failureRate: failureVal,
      disabled: disabledFlag.value,
    };
    if (!editing) {
      if (!payload.request) delete payload.request;
      if (!payload.requireMatch) delete payload.requireMatch;
      /* 400 为缺省失败码，新建态不写入配置 */
      if (payload.gateStatus === 400) delete payload.gateStatus;
      if (!variants.length) delete payload.variants;
      /* 新建态：高级选项仅在有值时携带；disabled 仅编辑态可携带 */
      if (delayMs.value === '') delete payload.delayMs;
      if (jitterMs.value === '') delete payload.jitterMs;
      if (failureRate.value === '') delete payload.failureRate;
      delete payload.disabled;
    }
    /* 序列/CRUD：编辑态始终携带（序列为数组或 []）以便清除；新建态仅在有值时携带。
     * 请求体模板相反 —— 默认开启，所以只在关闭时写进配置；编辑态若原先显式关闭过、现在要恢复默认，补一个 true 覆盖。 */
    if (editing) {
      payload.sequence = sequencePayload ?? [];
      payload.crud = crudFlag.value;
      if (!renderRequestFlag.value) payload.renderRequest = false;
      else if (editing.renderRequest === false) payload.renderRequest = true;
    } else {
      if (sequencePayload) payload.sequence = sequencePayload;
      if (crudFlag.value) payload.crud = true;
      if (!renderRequestFlag.value) payload.renderRequest = false;
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
      /* 一键创建配套 CRUD 路由：复用现有注册端点循环提交（仅 crud:true + auth 语义随行，条件/变体不携带）；已存在（形状冲突 409）跳过并汇总 */
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

interface CompanionDraft {
  key: string;
  method: string;
  path: string;
  name: string;
}

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

/** 给扁平准入行补上来源字段 */
function withSource(source: ConditionSource, rows: ConditionRow[]): ConditionRow[] {
  return rows.map((row) => ({ ...row, source }));
}

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

      /* 准入回填：request 条件全部进入「请求准入」区，开关即 requireMatch（语义无损：
       * requireMatch=false 的旧接口条件原本不参与匹配，这里只是搬到准入区并保持关闭） */
      const gateSplit = splitRouteRequest(route.request);
      gateRows.value = [
        ...withSource('query', gateSplit.query),
        ...withSource('headers', gateSplit.headers),
        ...withSource('body', gateSplit.body),
      ];
      gateBodyMatch.value = gateSplit.bodyMatch;
      gateBodyRaw.value = gateSplit.bodyRaw;
      gateOn.value = route.requireMatch === true;
      gateStatus.value = route.gateStatus ?? 400;

      /* 默认响应（条件已归入准入区，不再重复展示） */
      const def = defaultScene();
      def.status = route.response.status;
      def.headerRows = (route.response.headers ?? []).map((h) => ({ ...h }));
      def.bodyText = formatBody(route.response.body);

      const variants = (route.variants ?? []).map((v) => {
        const scene = newScene(v.name);
        scene.status = v.response.status;
        scene.headerRows = (v.response.headers ?? []).map((h) => ({ ...h }));
        scene.bodyText = formatBody(v.response.body);
        const matchSplit = splitRouteRequest(v.match);
        scene.rows = { query: matchSplit.query, headers: matchSplit.headers, body: matchSplit.body };
        scene.bodyMatch = matchSplit.bodyMatch;
        scene.bodyRaw = matchSplit.bodyRaw;
        return scene;
      });

      scenes.value = [def, ...variants];
      activeId.value = DEFAULT_SCENE_ID;
      customHeadersOn.value = [def, ...variants].some((scene) => scene.headerRows.some((h) => h.key.trim() !== ''));

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
      renderRequestFlag.value = route.renderRequest !== false;

      /* 路由级认证回填 */
      authType.value = route.auth?.type ?? 'none';
      authValue.value = route.auth?.value ?? '';
      authHeader.value = route.auth?.header ?? '';

      bodyEditorMode.value = 'rows';
      advancedOpen.value = false;
      previewOpen.value = false;

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

      <!-- ========== 基本信息 ========== -->
      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title">基本信息</div>
            <div class="card-note">先确定接口身份，路径参数只负责路由定位。</div>
          </div>
          <span class="card-chip">{{ editing ? '编辑中' : '草稿' }}</span>
        </div>
        <div class="card-body">
          <div class="field-grid">
            <div class="field">
              <label for="f-service">服务分组</label>
              <select id="f-service" v-model="serviceId">
                <option v-for="s in services" :key="s.id" :value="s.id">{{ s.name }} {{ serviceDisplaySuffix(s, props.mode) }}</option>
              </select>
            </div>
            <div class="field">
              <label for="f-name">接口名称</label>
              <input id="f-name" v-model="name" name="name" type="text" placeholder="如：查询订单" spellcheck="false">
            </div>
          </div>

          <div class="field method-field">
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
        </div>
      </section>

      <!-- ========== 请求准入 ========== -->
      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title">请求准入</div>
            <div class="card-note">共享条件只配置一次，所有响应分支都会先经过这里。</div>
          </div>
          <span class="card-chip" :class="{ off: !gateOn }">{{ gateOn ? '已开启' : '已关闭' }}</span>
        </div>
        <div class="card-body">
          <label class="switch-row" for="f-gate">
            <span class="switch-text">
              <span class="switch-title">启用请求准入</span>
              <span class="hint">不满足时不进入响应分支，并按下方「准入失败码」返回</span>
            </span>
            <input id="f-gate" v-model="gateOn" type="checkbox" class="switch-input">
            <span class="switch-ui" aria-hidden="true"></span>
          </label>

          <div class="gate-body" :class="{ off: !gateOn }">
            <div v-if="gateShowsStrategy" class="strategy-row">
              <label class="body-strategy">
                Body 匹配策略
                <select v-model="gateBodyMatch">
                  <option v-for="m in BODY_MATCH_LABELS" :key="m.value" :value="m.value">{{ m.label }}</option>
                </select>
              </label>
              <span class="hint">{{ gateBodyHint }}</span>
            </div>

            <ConditionTable
              v-if="gateBodyMatch === 'subset'"
              :rows="gateVisibleRows"
              show-source
              add-text="＋ 添加共享条件"
              @update:rows="setGateVisibleRows"
            />

            <template v-else>
              <textarea
                v-model="gateBodyRaw"
                class="body-raw-editor"
                rows="5"
                :placeholder="BODY_RAW_PLACEHOLDER"
                spellcheck="false"
                aria-label="请求准入的完整 JSON / 原文期望值"
              ></textarea>
              <ConditionTable :rows="gateVisibleRows" show-source add-text="＋ 添加共享条件" @update:rows="setGateVisibleRows" />
            </template>

            <div class="gate-footer">
              <p class="hint">推荐：权限 / 租户 / 版本等「所有分支都需要」的条件放这里。<strong>分支只描述差异。</strong></p>
              <label class="status-select">
                准入失败码
                <select v-model.number="gateStatus">
                  <option v-for="code in gateStatuses" :key="code" :value="code">{{ code }}</option>
                </select>
              </label>
            </div>
          </div>
        </div>
      </section>

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
              v-if="!activeIsDefault"
              type="button"
              class="branch-delete"
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

      <!-- ========== 匹配预览 ========== -->
      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title">匹配预览</div>
            <div class="card-note">本地推演「路径 → 认证 → 请求准入 → 分支 → 响应」，不发送真实请求。</div>
          </div>
          <button type="button" class="mini-btn" :aria-expanded="previewOpen" @click="previewOpen = !previewOpen">
            {{ previewOpen ? '收起预览 ▴' : '展开预览 ▾' }}
          </button>
        </div>
        <div v-show="previewOpen" class="card-body">
          <MatchPreview :route="previewRoute" :form-method="method" :form-path="path" />
        </div>
      </section>

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
/* ---------- 卡片骨架 ---------- */
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

.card {
  margin-bottom: 12px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--bg);
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
}

.card-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}

.card-note {
  margin-top: 2px;
  color: var(--text-dim);
  font-size: 12px;
}

.card-chip {
  flex: none;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.card-chip.off {
  background: var(--bg-soft);
  color: var(--text-faint);
}

.card-body {
  display: grid;
  gap: 12px;
  padding: 14px;
}

/* ---------- 基本信息 ---------- */
.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.method-field {
  margin-top: 12px;
}

.path-hint {
  margin-top: 6px;
}

/* ---------- 请求准入 ---------- */
.gate-body {
  display: grid;
  gap: 10px;
  transition: opacity 0.15s;
}

.gate-body.off {
  opacity: 0.55;
}

.strategy-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.body-strategy {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-dim);
  font-size: 12px;
  white-space: nowrap;
}

.body-strategy select {
  width: 158px;
  padding: 6px 8px;
  font-family: var(--mono);
  font-size: 12px;
}

.gate-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
}

.gate-footer p {
  margin: 0;
  max-width: 60%;
}

.gate-footer strong {
  color: var(--text);
}

.status-select {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-dim);
  font-size: 12px;
  white-space: nowrap;
}

.status-select select {
  width: 92px;
  padding: 6px 8px;
  font-family: var(--mono);
  font-size: 12px;
}

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
  .field-grid,
  .branch-editor,
  .advanced-grid,
  .auth-fields {
    grid-template-columns: 1fr;
  }
}
</style>
