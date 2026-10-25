/**
 * 接口编辑表单的草稿模型与纯函数层（自 RouteForm.vue 抽出）：
 * - 分支草稿模型（SceneDraft / SceneRows / emptyRows / newScene / defaultScene）
 * - 编辑回填（Route → 表单各分区初值，backfillDraft）
 * - 提交组装（表单状态 → RoutePayload，buildRoutePayload）
 * 均为无副作用的纯函数（newScene 的 localId 自增除外，与原实现一致）；
 * 表单校验与 notify 提示仍留在组件内。仿 match-preview.ts 的「纯函数模块 + 同目录单测」先例。
 */
import type {
  BodyMatchMode,
  CallbackTemplateInfo,
  ConditionRow,
  ConditionSource,
  ResponseHeader,
  Route,
  RouteCallback,
  RoutePayload,
} from './types';
import { buildRouteRequest, formatBody, isJsonContentType, sequenceToDraftText, splitRouteRequest } from './utils';

/* ---------- 分支草稿模型 ---------- */

export type CondTab = 'query' | 'headers' | 'body';

export type SceneRows = Record<CondTab, ConditionRow[]>;

export const DEFAULT_SCENE_ID = 0;

export function emptyRows(): SceneRows {
  return { query: [], headers: [], body: [] };
}

/** 一个响应分支 = 条件（rows + body 策略）+ 返回响应；localId 0 固定为默认响应（fallback） */
export interface SceneDraft {
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
  /** 异步回调（命中本分支并响应后发出）；on 控制是否提交 */
  callback: CallbackDraft;
}

/** 单个分支的回调草稿：引用模板 / 内联双模式；数字空串 = 未设置 */
export interface CallbackDraft {
  on: boolean;
  mode: 'template' | 'inline';
  templateId: string;
  bodyOverride: string;
  url: string;
  method: string;
  contentType: string;
  body: string;
  delayMs: number | '';
  jitterMs: number | '';
  headerRows: ResponseHeader[];
}

export function emptyCallbackDraft(): CallbackDraft {
  return { on: false, mode: 'template', templateId: '', bodyOverride: '', url: '', method: 'POST', contentType: '', body: '', delayMs: '', jitterMs: '', headerRows: [] };
}

/** 从已保存的回调配置回填草稿（编辑回填用） */
export function callbackToDraft(callback: RouteCallback | undefined): CallbackDraft {
  if (!callback) return emptyCallbackDraft();
  if ('template' in callback) {
    return { ...emptyCallbackDraft(), on: true, mode: 'template', templateId: callback.template, bodyOverride: callback.bodyOverride ?? '' };
  }
  return {
    on: true,
    mode: 'inline',
    templateId: '',
    bodyOverride: '',
    url: callback.url,
    method: callback.method ?? 'POST',
    contentType: callback.contentType ?? '',
    body: callback.body ?? '',
    delayMs: callback.delayMs ?? '',
    jitterMs: callback.jitterMs ?? '',
    headerRows: (callback.headers ?? []).map((h) => ({ ...h })),
  };
}

/** 提交形态：引用模式仅 template + bodyOverride；内联模式按字段有值裁剪；序列 / CRUD 下强制不提交（后端拒收） */
export function buildSceneCallback(
  scene: SceneDraft,
  options: { sequenceActive: boolean; crud: boolean; templates: CallbackTemplateInfo[] },
): RouteCallback | undefined {
  const draft = scene.callback;
  if (!draft.on) return undefined;
  if (options.sequenceActive || options.crud) return undefined;
  if (draft.mode === 'template') {
    const templateId = draft.templateId || options.templates[0]?.id || '';
    if (!templateId) return undefined;
    return draft.bodyOverride.trim() ? { template: templateId, bodyOverride: draft.bodyOverride } : { template: templateId };
  }
  const url = draft.url.trim();
  if (!url) return undefined;
  const headers = draft.headerRows.map((row) => ({ key: row.key.trim(), value: row.value })).filter((row) => row.key);
  const inline: Extract<RouteCallback, { url: string }> = { url };
  if (draft.method && draft.method !== 'POST') inline.method = draft.method;
  if (headers.length) inline.headers = headers;
  if (draft.contentType.trim()) inline.contentType = draft.contentType.trim();
  if (draft.body.trim()) inline.body = draft.body;
  if (draft.delayMs !== '') inline.delayMs = draft.delayMs;
  if (draft.jitterMs !== '') inline.jitterMs = draft.jitterMs;
  return inline;
}

let sceneSeq = 0;

export function newScene(name: string): SceneDraft {
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
    callback: emptyCallbackDraft(),
  };
}

export function defaultScene(): SceneDraft {
  return { ...newScene('默认响应'), localId: DEFAULT_SCENE_ID };
}

/** 一键创建配套路由的条目（key = 「METHOD path」，用于勾选状态记忆） */
export interface CompanionDraft {
  key: string;
  method: string;
  path: string;
  name: string;
}

/* ---------- 草稿的纯函数辅助 ---------- */

/** 提交用：过滤空 key 行；全空返回 undefined（payload 省略该字段） */
export function buildResponseHeaders(scene: SceneDraft): ResponseHeader[] | undefined {
  const rows = scene.headerRows.map((row) => ({ key: row.key.trim(), value: row.value })).filter((row) => row.key);
  return rows.length ? rows : undefined;
}

/** 场景是否 JSON 模式（未启用自定义响应头时按 JSON；启用后由 Content-Type 行决定） */
export function sceneIsJsonMode(scene: SceneDraft, customHeadersOn: boolean): boolean {
  if (!customHeadersOn) return true;
  const ctRow = scene.headerRows.find((h) => h.key.trim().toLowerCase() === 'content-type');
  return isJsonContentType(ctRow?.value.trim() || undefined);
}

/** 给扁平准入行补上来源字段 */
export function withSource(source: ConditionSource, rows: ConditionRow[]): ConditionRow[] {
  return rows.map((row) => ({ ...row, source }));
}

/* ---------- 编辑回填（Route → 表单初值） ---------- */

/** 准入区草稿：request 条件 + 开关 + 失败码 */
export interface GateDraft {
  on: boolean;
  rows: ConditionRow[];
  bodyMatch: BodyMatchMode;
  bodyRaw: string;
  status: 400 | 404 | 422;
}

/** 高级选项草稿：空字符串表示未设置 */
export interface AdvancedDraft {
  delayMs: number | '';
  jitterMs: number | '';
  failureRate: number | '';
  disabled: boolean;
}

/** 编辑回填的草稿快照：组件负责把各分区写回对应 refs */
export interface RouteFormDraft {
  name: string;
  method: string;
  path: string;
  gate: GateDraft;
  /** [默认响应, ...分支] */
  scenes: SceneDraft[];
  /** 任一场景配置过响应头时自动展开「自定义响应头」总开关 */
  customHeadersOn: boolean;
  advanced: AdvancedDraft;
  sequence: { on: boolean; text: string };
  crud: boolean;
  renderRequest: boolean;
  auth: { type: 'none' | 'apikey' | 'bearer'; value: string; header: string };
}

export function backfillDraft(route: Route): RouteFormDraft {
  /* 准入回填：request 条件全部进入「请求准入」区，开关即 requireMatch（语义无损：
   * requireMatch=false 的旧接口条件原本不参与匹配，这里只是搬到准入区并保持关闭） */
  const gateSplit = splitRouteRequest(route.request);
  const gateRows = [
    ...withSource('query', gateSplit.query),
    ...withSource('headers', gateSplit.headers),
    ...withSource('body', gateSplit.body),
  ];

  /* 默认响应（条件已归入准入区，不再重复展示）；WS 路由不走本表单，response 缺省时按空响应回填 */
  const def = defaultScene();
  def.status = route.response?.status ?? 200;
  def.headerRows = (route.response?.headers ?? []).map((h) => ({ ...h }));
  def.bodyText = formatBody(route.response?.body ?? null);
  def.callback = callbackToDraft(route.response?.callback);

  const variants = (route.variants ?? []).map((v) => {
    const scene = newScene(v.name);
    scene.status = v.response.status;
    scene.headerRows = (v.response.headers ?? []).map((h) => ({ ...h }));
    scene.bodyText = formatBody(v.response.body);
    scene.callback = callbackToDraft(v.response.callback);
    const matchSplit = splitRouteRequest(v.match);
    scene.rows = { query: matchSplit.query, headers: matchSplit.headers, body: matchSplit.body };
    scene.bodyMatch = matchSplit.bodyMatch;
    scene.bodyRaw = matchSplit.bodyRaw;
    return scene;
  });

  return {
    name: route.name ?? '',
    method: route.method,
    path: route.path,
    gate: {
      on: route.requireMatch === true,
      rows: gateRows,
      bodyMatch: gateSplit.bodyMatch,
      bodyRaw: gateSplit.bodyRaw,
      status: route.gateStatus ?? 400,
    },
    scenes: [def, ...variants],
    customHeadersOn: [def, ...variants].some((scene) => scene.headerRows.some((h) => h.key.trim() !== '')),
    advanced: {
      delayMs: route.delayMs ?? '',
      jitterMs: route.jitterMs ?? '',
      failureRate: route.failureRate ?? '',
      disabled: route.disabled === true,
    },
    sequence: { on: (route.sequence?.length ?? 0) > 0, text: sequenceToDraftText(route.sequence) },
    crud: route.crud === true,
    renderRequest: route.renderRequest !== false,
    auth: {
      type: route.auth?.type ?? 'none',
      value: route.auth?.value ?? '',
      header: route.auth?.header ?? '',
    },
  };
}

/* ---------- 提交组装（表单状态 → RoutePayload） ---------- */

/** 认证提交形态：none → null（清除语义）；apikey 可带自定义 header 名（值与 header 名 trim 后提交） */
export function buildAuthPayload(auth: { type: 'none' | 'apikey' | 'bearer'; value: string; header: string }): RoutePayload['auth'] {
  return auth.type === 'none'
    ? null
    : {
        type: auth.type,
        value: auth.value.trim(),
        ...(auth.type === 'apikey' && auth.header.trim() ? { header: auth.header.trim() } : {}),
      };
}

/** 提交输入：name / path 由组件 trim 后传入；sequence 传入已解析的数组（开关关闭或解析失败时为 undefined） */
export interface RouteFormSubmitInput {
  editing: boolean;
  serviceId: string;
  name: string;
  method: string;
  path: string;
  gate: GateDraft;
  scenes: SceneDraft[];
  customHeadersOn: boolean;
  delayMs: number | '';
  jitterMs: number | '';
  failureRate: number | '';
  disabled: boolean;
  sequence?: Array<{ status: number; body: string }>;
  crud: boolean;
  renderRequest: boolean;
  /** 编辑目标的 renderRequest 原值（新建态缺省 undefined）：恢复默认开启时需补写 true 覆盖显式 false */
  editingRenderRequest?: boolean;
  auth: { type: 'none' | 'apikey' | 'bearer'; value: string; header: string };
  /** 全局回调模板列表（引用模式下拉与缺省模板兜底）；缺省视为空列表 */
  templates?: CallbackTemplateInfo[];
}

export function buildRoutePayload(input: RouteFormSubmitInput): RoutePayload {
  const editing = input.editing;
  const def = input.scenes[0];
  const variantScenes = input.scenes.filter((scene) => scene.localId !== DEFAULT_SCENE_ID);
  const gateRowsOf = (source: ConditionSource) => input.gate.rows.filter((row) => (row.source ?? 'query') === source);
  const gateRequest = buildRouteRequest(gateRowsOf('query'), gateRowsOf('headers'), gateRowsOf('body'), input.gate.bodyMatch, input.gate.bodyRaw);

  /* 序列 / CRUD 与回调互斥：开启时不提交回调配置（后端同样拒收，前端先行避免 400） */
  const sequenceActive = (input.sequence?.length ?? 0) > 0;
  const callbackOptions = { sequenceActive, crud: input.crud, templates: input.templates ?? [] };
  const defCallback = buildSceneCallback(def, callbackOptions);
  const defHeaders = input.customHeadersOn ? buildResponseHeaders(def) : undefined;
  const variants = variantScenes.map((scene) => {
    const sceneHeaders = input.customHeadersOn ? buildResponseHeaders(scene) : undefined;
    const sceneCallback = buildSceneCallback(scene, callbackOptions);
    return {
      name: scene.name.trim(),
      match: buildRouteRequest(scene.rows.query, scene.rows.headers, scene.rows.body, scene.bodyMatch, scene.bodyRaw),
      response: {
        status: Number(scene.status) || 200,
        ...(sceneHeaders ? { headers: sceneHeaders } : {}),
        ...(sceneCallback ? { callback: sceneCallback } : {}),
        body: scene.bodyText.trim(),
      },
    };
  });

  /* 编辑态始终携带 request / requireMatch / gateStatus 以便清除或复位；新建态仅在有意义时携带。
   * 高级选项空串语义 = 未设置（组件侧 parseAdvancedValue 校验后按 0 提交），此处归一为数值。 */
  const payload: RoutePayload = {
    serviceId: input.serviceId,
    method: input.method,
    path: input.path,
    response: {
      status: Number(def.status) || 200,
      ...(defHeaders ? { headers: defHeaders } : {}),
      ...(defCallback ? { callback: defCallback } : {}),
      body: def.bodyText.trim(),
    },
    request: editing ? (gateRequest ?? {}) : gateRequest,
    requireMatch: input.gate.on,
    gateStatus: input.gate.status,
    variants,
    delayMs: input.delayMs === '' ? 0 : input.delayMs,
    jitterMs: input.jitterMs === '' ? 0 : input.jitterMs,
    failureRate: input.failureRate === '' ? 0 : input.failureRate,
    disabled: input.disabled,
  };
  if (!editing) {
    if (!payload.request) delete payload.request;
    if (!payload.requireMatch) delete payload.requireMatch;
    /* 400 为缺省失败码，新建态不写入配置 */
    if (payload.gateStatus === 400) delete payload.gateStatus;
    if (!variants.length) delete payload.variants;
    /* 新建态：高级选项仅在有值时携带；disabled 仅编辑态可携带 */
    if (input.delayMs === '') delete payload.delayMs;
    if (input.jitterMs === '') delete payload.jitterMs;
    if (input.failureRate === '') delete payload.failureRate;
    delete payload.disabled;
  }
  /* 序列/CRUD：编辑态始终携带（序列为数组或 []）以便清除；新建态仅在有值时携带。
   * 请求体模板相反 —— 默认开启，所以只在关闭时写进配置；编辑态若原先显式关闭过、现在要恢复默认，补一个 true 覆盖。 */
  if (editing) {
    payload.sequence = input.sequence ?? [];
    payload.crud = input.crud;
    if (!input.renderRequest) payload.renderRequest = false;
    else if (input.editingRenderRequest === false) payload.renderRequest = true;
  } else {
    if (input.sequence) payload.sequence = input.sequence;
    if (input.crud) payload.crud = true;
    if (!input.renderRequest) payload.renderRequest = false;
  }
  /* 认证：编辑态始终携带（null 表示清除）；新建态仅在开启时携带 */
  const authPayload = buildAuthPayload(input.auth);
  if (editing) {
    payload.auth = authPayload;
  } else if (authPayload) {
    payload.auth = authPayload;
  }
  if (!editing || input.name) payload.name = input.name;
  return payload;
}
