<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  createCallbackTemplate,
  deleteCallbackTemplate,
  updateCallbackTemplate,
  type CallbackTemplateInput,
} from '../api';
import type { CallbackTemplateInfo } from '../types';
import type { NotifyFn } from '../types';
import { useDrawerResize } from '../composables/useDrawerResize';

/**
 * 回调管理视图（出站通知中心）：全局回调模板的列表 / 新建 / 编辑 / 删除。
 * 模板 = 跨服务复用的「往哪发、怎么发」信封；接口在编辑抽屉「高级选项 · 异步回调」引用。
 */
const props = defineProps<{
  active: boolean;
  notify: NotifyFn;
  /** 父组件持有并刷新（usage 引用位置依赖路由列表，变更后由父组件重拉） */
  templates: CallbackTemplateInfo[];
}>();

const emit = defineEmits<{ changed: [] }>();

/* ---------- 抽屉（新建 / 编辑共用，同一套宽度拖拽记忆） ---------- */
const drawerOpen = ref(false);
const editingId = ref<string | null>(null);
const panelEl = ref<HTMLElement | null>(null);
const rzEl = ref<HTMLElement | null>(null);
const { width, reset, onDown, onKeydown, apply } = useDrawerResize(panelEl, rzEl);

const name = ref('');
const method = ref('POST');
const url = ref('');
const delayMs = ref<number | ''>('');
const jitterMs = ref<number | ''>('');
const contentType = ref('');
const body = ref('');
const headerRows = ref<Array<{ key: string; value: string }>>([]);
const submitting = ref(false);

const editing = computed(() => editingId.value !== null);
const currentUsage = computed(() =>
  editing.value ? (props.templates.find((t) => t.id === editingId.value)?.usage.length ?? 0) : 0,
);

function openCreate() {
  editingId.value = null;
  name.value = '';
  method.value = 'POST';
  url.value = '';
  delayMs.value = '';
  jitterMs.value = '';
  contentType.value = '';
  body.value = '';
  headerRows.value = [];
  drawerOpen.value = true;
  watchActiveOnce();
}

function openEdit(template: CallbackTemplateInfo) {
  editingId.value = template.id;
  name.value = template.name;
  method.value = template.method ?? 'POST';
  url.value = template.url;
  delayMs.value = template.delayMs ?? '';
  jitterMs.value = template.jitterMs ?? '';
  contentType.value = template.contentType ?? '';
  body.value = template.body ?? '';
  headerRows.value = (template.headers ?? []).map((h) => ({ ...h }));
  drawerOpen.value = true;
  watchActiveOnce();
}

function closeDrawer() {
  drawerOpen.value = false;
}

/* 打开抽屉后再套用记忆宽度（首挂载时面板可能尚未渲染） */
let appliedOnce = false;
function watchActiveOnce() {
  if (appliedOnce) return;
  appliedOnce = true;
  requestAnimationFrame(apply);
}

function addHeader() {
  headerRows.value.push({ key: '', value: '' });
}

function removeHeader(index: number) {
  headerRows.value.splice(index, 1);
}

function buildInput(): CallbackTemplateInput {
  const headers = headerRows.value.map((row) => ({ key: row.key.trim(), value: row.value })).filter((row) => row.key);
  return {
    name: name.value.trim(),
    url: url.value.trim(),
    ...(method.value !== 'POST' ? { method: method.value } : {}),
    ...(headers.length ? { headers } : {}),
    ...(contentType.value.trim() ? { contentType: contentType.value.trim() } : {}),
    ...(body.value ? { body: body.value } : {}),
    ...(delayMs.value !== '' ? { delayMs: delayMs.value } : {}),
    ...(jitterMs.value !== '' ? { jitterMs: jitterMs.value } : {}),
  };
}

async function save() {
  if (!name.value.trim()) {
    props.notify('模板名称不能为空', 'err');
    return;
  }
  if (!url.value.trim()) {
    props.notify('回调 URL 不能为空', 'err');
    return;
  }
  submitting.value = true;
  try {
    if (editing.value && editingId.value) {
      const result = await updateCallbackTemplate(editingId.value, buildInput());
      props.notify(`模板「${result.template.name}」已保存 · 影响 ${result.affected} 个分支`);
    } else {
      const result = await createCallbackTemplate(buildInput());
      props.notify(`模板「${result.template.name}」已创建（未被引用）`);
    }
    drawerOpen.value = false;
    emit('changed');
  } catch (err) {
    props.notify((err as Error).message, 'err');
  } finally {
    submitting.value = false;
  }
}

async function remove(template: CallbackTemplateInfo) {
  if (template.usage.length > 0) {
    props.notify(`409 冲突：模板「${template.name}」被 ${template.usage.length} 个分支引用，无法删除`, 'err');
    return;
  }
  if (!window.confirm(`删除回调模板「${template.name}」？`)) return;
  try {
    await deleteCallbackTemplate(template.id);
    props.notify(`模板「${template.name}」已删除`);
    emit('changed');
  } catch (err) {
    props.notify((err as Error).message, 'err');
  }
}

/* ---------- 列表展示辅助 ---------- */

function methodColorOf(method: string | undefined): string {
  switch (method ?? 'POST') {
    case 'GET': return '#0e9f5d';
    case 'POST': return '#1f6feb';
    case 'PUT': return '#b7791f';
    case 'PATCH': return '#8250df';
    case 'DELETE': return '#cf222e';
    default: return '#5b6b7c';
  }
}

function delayLabel(template: CallbackTemplateInfo): string {
  const delay = template.delayMs ?? 1000;
  const delayText = delay >= 1000 ? `${Math.round(delay / 100) / 10}s` : `${delay}ms`;
  if (!template.jitterMs) return delayText;
  const jitter = template.jitterMs >= 1000 ? `${Math.round(template.jitterMs / 100) / 10}s` : `${template.jitterMs}ms`;
  return `${delayText} · 抖动 ${jitter}`;
}

function statsLabel(template: CallbackTemplateInfo): string {
  const { ok, fail } = template.stats;
  if (ok + fail === 0) return '暂无出站记录';
  return `出站 ${ok + fail} 次：${ok} 成功${fail ? ` · ${fail} 失败` : ''}`;
}

function usageLabel(template: CallbackTemplateInfo): string {
  return template.usage.length ? `被 ${template.usage.length} 个分支引用` : '未被引用';
}

/** 引用位置展开：分支名（默认响应 / 变体名） */
function branchLabel(branch: string | null): string {
  return branch ?? '默认响应';
}

const expanded = ref(new Set<string>());
function toggleExpand(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id);
  else expanded.value.add(id);
  expanded.value = new Set(expanded.value);
}

/* 非激活视图挂起轮询/渲染无意义，激活时刷新一次宽度兜底 */
watch(
  () => props.active,
  (active) => {
    if (active) apply();
  },
);
</script>

<template>
  <div class="callbacks-view">
    <div class="view-toolbar">
      <button type="button" class="add-btn" @click="openCreate"><span class="plus">＋</span> 新建回调模板</button>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>回调模板</h2>
        <span class="count-chip">{{ templates.length }} 个模板 · 跨服务复用</span>
      </div>

      <div v-if="templates.length" class="tpl-list">
        <div v-for="tpl in templates" :key="tpl.id" class="tpl-card" :class="{ open: expanded.has(tpl.id) }">
          <div class="tpl-head">
            <b class="tpl-name" :title="tpl.name">{{ tpl.name }}</b>
            <span class="method-badge" :style="{ '--method-color': methodColorOf(tpl.method) }">{{ tpl.method ?? 'POST' }}</span>
            <span class="tpl-url" :title="tpl.url">{{ tpl.url }}</span>
            <div class="tpl-actions">
              <button type="button" class="icon-btn" title="编辑模板（保存前提示受影响分支数）" @click="openEdit(tpl)">✎</button>
              <button
                type="button"
                class="icon-btn"
                :class="{ danger: tpl.usage.length > 0 }"
                :title="tpl.usage.length ? '被引用中，删除将被 409 拒绝并列出引用位置' : '未被引用，可删除'"
                @click="remove(tpl)"
              >×</button>
            </div>
          </div>
          <div class="tpl-meta">
            <span class="tpl-chip" :class="{ referenced: tpl.usage.length > 0 }">{{ usageLabel(tpl) }}</span>
            <span class="tpl-chip">延迟 {{ delayLabel(tpl) }}</span>
            <span class="tpl-chip">{{ tpl.contentType ?? 'application/json' }}</span>
            <span class="meta-sep">·</span>
            <span class="tpl-chip" :class="{ warn: tpl.stats.fail > 0 }">{{ statsLabel(tpl) }}</span>
          </div>
          <button type="button" class="tpl-fold" @click="toggleExpand(tpl.id)">
            {{ expanded.has(tpl.id) ? '▾' : '▸' }} 引用详情
          </button>
          <div v-if="expanded.has(tpl.id)" class="tpl-usage">
            <p v-if="!tpl.usage.length" class="hint">尚无接口引用此模板：在接口编辑抽屉「高级选项 · 异步回调」选择「引用模板」即可绑定</p>
            <div v-for="(u, i) in tpl.usage" :key="i" class="usage-row">
              <span class="usage-method" :style="{ color: methodColorOf(u.method) }">{{ u.method }}</span>
              <span class="usage-path">{{ u.path }}</span>
              <span class="usage-branch">{{ branchLabel(u.branch) }}</span>
            </div>
            <p v-if="tpl.usage.length" class="hint">编辑此模板将影响以上 {{ tpl.usage.length }} 个分支（保存后对后续命中立即生效）</p>
          </div>
        </div>
      </div>

      <div v-else class="tpl-empty">
        <div class="empty-glyph">↗</div>
        <p class="empty-title">暂无回调模板</p>
        <p class="hint">模板统一管理「往哪发、怎么发」的信封（URL / 方法 / 头 / 延迟 / 默认载荷），多个接口引用同一模板，改一处全部生效</p>
      </div>

      <div class="tpl-foot">
        <p>· 编辑模板前会提示受影响分支数：<b>改一处，所有引用接口同步生效</b>——复用的价值与风险都来自这里，所以做成明功能</p>
        <p>· 被引用的模板删除返回 409 并列出引用位置；接口侧也可用「内联配置」不依赖模板</p>
        <p>· 统计来自请求日志环形缓冲（500 条）的出站条目聚合，不额外持久化</p>
      </div>
    </div>

    <!-- 模板编辑抽屉（与接口编辑抽屉同一形态：左缘拖拽宽度 + 记忆） -->
    <div v-show="drawerOpen">
      <div class="drawer-mask" @click="closeDrawer"></div>
      <aside
        ref="panelEl"
        class="drawer-panel"
        :style="width === null ? undefined : { width: `${width}px` }"
        role="dialog"
        aria-modal="true"
        aria-label="回调模板编辑表单"
      >
        <div
          ref="rzEl"
          class="drawer-rz"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整抽屉宽度，双击恢复默认"
          title="拖拽调整宽度，双击恢复默认"
          tabindex="0"
          @pointerdown="onDown"
          @dblclick="reset"
          @keydown="onKeydown"
        ></div>

        <div class="drawer-head">
          <h2 class="drawer-title">{{ editing ? `编辑模板 · ${name}` : '新建回调模板' }}</h2>
          <button type="button" class="drawer-close" @click="closeDrawer">×</button>
        </div>

        <div class="drawer-body">
          <section class="card">
            <div class="card-head">
              <div>
                <div class="card-title">基本信息</div>
                <div class="card-note">模板只定义「往哪发、怎么发」；载荷上下文来自每次命中的请求快照</div>
              </div>
              <span class="card-chip">{{ editing ? `被 ${currentUsage} 个分支引用` : '新模板' }}</span>
            </div>
            <div class="card-body">
              <div class="field">
                <label for="ft-name">模板名称</label>
                <input id="ft-name" v-model="name" type="text" placeholder="如：支付通知" spellcheck="false">
              </div>
              <div class="field">
                <label for="ft-url">回调 URL</label>
                <div class="cb-method-row">
                  <select id="ft-method" v-model="method" aria-label="回调方法">
                    <option>POST</option><option>GET</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
                  </select>
                  <input id="ft-url" v-model="url" type="text" placeholder="http://127.0.0.1:8080/…" spellcheck="false">
                </div>
                <p class="hint">URL 支持模板占位符（写法与响应模板相同）；目标受 POLYMOCK_PROXY_ALLOW 白名单约束</p>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-head">
              <div>
                <div class="card-title">发送时序</div>
                <div class="card-note">实际延迟 = 固定延迟 + 随机抖动</div>
              </div>
            </div>
            <div class="card-body">
              <div class="tpl-grid">
                <div class="field">
                  <label for="ft-delay">延迟 ms（0–60000）</label>
                  <input id="ft-delay" v-model.number="delayMs" type="number" min="0" max="60000" placeholder="缺省 1000">
                </div>
                <div class="field">
                  <label for="ft-jitter">抖动 ms（0–30000）</label>
                  <input id="ft-jitter" v-model.number="jitterMs" type="number" min="0" max="30000" placeholder="缺省 0">
                </div>
                <div class="field">
                  <label for="ft-ct">Content-Type</label>
                  <input id="ft-ct" v-model="contentType" type="text" placeholder="缺省 application/json" spellcheck="false">
                </div>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-head">
              <div>
                <div class="card-title">默认载荷与请求头</div>
                <div class="card-note">引用方可通过 bodyOverride 整体覆盖载荷</div>
              </div>
            </div>
            <div class="card-body">
              <div class="field">
                <label for="ft-body">默认载荷（模板渲染）</label>
                <textarea
                  id="ft-body"
                  v-model="body"
                  rows="7"
                  class="tpl-editor"
                  placeholder='{ "orderNo": "{{body.orderNo}}", "status": "PAID" }'
                  spellcheck="false"
                ></textarea>
                <p class="hint">留空表示回调无请求体；占位符取不到值时原样保留</p>
              </div>
              <div class="tpl-headers">
                <div class="label-row">
                  <label>自定义请求头</label>
                  <button type="button" class="mini-btn" @click="addHeader">＋ 添加请求头</button>
                </div>
                <div v-for="(row, i) in headerRows" :key="i" class="header-row">
                  <input v-model="row.key" type="text" placeholder="头名称，如 X-Source" spellcheck="false" :aria-label="`请求头名称 ${i + 1}`">
                  <input v-model="row.value" type="text" placeholder="值，如 polymock-callback" spellcheck="false" :aria-label="`请求头值 ${i + 1}`">
                  <button type="button" class="rh-del" :aria-label="`删除请求头 ${i + 1}`" @click="removeHeader(i)">×</button>
                </div>
                <p v-if="!headerRows.length" class="hint">暂无请求头；Content-Type 由上方字段管理</p>
              </div>
            </div>
          </section>
        </div>

        <div class="drawer-foot">
          <span class="affect-warn" v-if="editing">此修改将影响 {{ currentUsage }} 个分支（保存后对后续命中立即生效）</span>
          <span class="foot-spacer"></span>
          <button type="button" class="btn" @click="closeDrawer">取消</button>
          <button type="button" class="btn primary" :disabled="submitting" @click="save">保存模板</button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped src="./route-form/section-card.css"></style>

<style scoped>
/* 全局 .drawer-panel 无 flex 布局（接口编辑抽屉由 RouteForm 自管滚动）；
   本抽屉的 head/body/foot 依赖 flex 列布局，foot 才能钉在视口底而非随内容溢出 */
.drawer-panel {
  display: flex;
  flex-direction: column;
}

.view-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 14px;
}

.add-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 18px;
  border: 1px solid rgba(8, 145, 178, 0.45);
  border-radius: 8px;
  cursor: pointer;
  color: #0e7490;
  background: rgba(8, 145, 178, 0.08);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 1px;
}

.plus {
  font-size: 15px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-soft);
  border-radius: 12px 12px 0 0;
}

.panel-head h2 {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: var(--text-dim);
}

.count-chip {
  padding: 1px 8px;
  border: 1px solid rgba(8, 145, 178, 0.45);
  border-radius: 999px;
  background: rgba(8, 145, 178, 0.1);
  color: #0e7490;
  font-size: 11px;
}

.panel {
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 6px 24px rgba(28, 39, 51, 0.08);
}

.tpl-list {
  padding: 12px;
  display: grid;
  gap: 8px;
}

.tpl-card {
  border: 1px solid var(--line);
  border-left: 3px solid #0891b2;
  border-radius: 8px;
  background: var(--bg);
  padding: 12px 14px;
}

.tpl-card:hover {
  border-color: var(--line-strong);
  background: var(--bg-soft);
}

.tpl-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.tpl-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.method-badge {
  flex: none;
  padding: 3px 9px;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 1px;
  background: color-mix(in srgb, var(--method-color) 12%, transparent);
  color: var(--method-color);
  border: 1px solid color-mix(in srgb, var(--method-color) 40%, transparent);
}

.tpl-url {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 12.5px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.tpl-actions {
  display: flex;
  gap: 6px;
}

.icon-btn {
  flex: none;
  width: 28px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: none;
  color: var(--text-faint);
  font-size: 13px;
  cursor: pointer;
}

.icon-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(14, 159, 93, 0.08);
}

.icon-btn.danger:hover {
  border-color: var(--danger);
  color: var(--danger);
  background: rgba(207, 34, 46, 0.06);
}

.tpl-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-dim);
}

.tpl-chip {
  padding: 1px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--bg);
  font-size: 11px;
}

.tpl-chip.referenced {
  border-color: rgba(8, 145, 178, 0.45);
  background: rgba(8, 145, 178, 0.1);
  color: #0e7490;
}

.tpl-chip.warn {
  border-color: rgba(183, 121, 31, 0.45);
  background: rgba(183, 121, 31, 0.08);
  color: #b7791f;
}

.meta-sep {
  color: var(--text-faint);
}

.tpl-fold {
  margin-top: 8px;
  border: none;
  background: none;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}

.tpl-usage {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
  display: grid;
  gap: 6px;
}

.usage-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.usage-method {
  flex: none;
  width: 46px;
  font-weight: 700;
  font-family: var(--mono);
}

.usage-path {
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage-branch {
  flex: none;
  color: var(--text-faint);
}

.tpl-empty {
  padding: 34px 20px;
  text-align: center;
  color: var(--text-faint);
}

.empty-glyph {
  font-size: 26px;
  margin-bottom: 6px;
}

.empty-title {
  font-size: 13px;
  color: var(--text-dim);
  margin-bottom: 4px;
}

.tpl-foot {
  padding: 10px 18px 12px;
  border-top: 1px solid var(--line);
  background: var(--bg-soft);
  display: grid;
  gap: 3px;
  font-size: 12px;
  color: var(--text-faint);
}

.tpl-foot b {
  color: var(--text-dim);
}

/* ---------- 编辑抽屉 ---------- */
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-soft);
}

.drawer-title {
  font-size: 14px;
  font-weight: 700;
}

.drawer-close {
  border: none;
  background: none;
  font-size: 20px;
  color: var(--text-faint);
  cursor: pointer;
}

.drawer-body {
  flex: 1;
  overflow: auto;
  padding: 16px 20px 24px;
  display: grid;
  gap: 12px;
  align-content: start;
}

.card-body .cb-method-row {
  display: flex;
  gap: 8px;
}

.card-body .cb-method-row select {
  flex: none;
  width: 104px;
  cursor: pointer;
}

.card-body .cb-method-row input {
  flex: 1;
  min-width: 0;
}

.tpl-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.tpl-editor {
  min-height: 120px;
  font-size: 12px;
  line-height: 1.55;
}

.tpl-headers,
.label-row {
  display: grid;
  gap: 6px;
}

.label-row {
  grid-template-columns: auto 1fr;
  align-items: center;
}

.label-row .mini-btn {
  justify-self: end;
}

.header-row {
  display: flex;
  gap: 6px;
}

.header-row input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  font-size: 12px;
}

.header-row input:first-child {
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
}

.rh-del:hover {
  color: var(--danger);
  border-color: var(--danger);
}

.drawer-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--line);
  background: var(--bg-soft);
}

.affect-warn {
  padding: 3px 10px;
  border: 1px dashed rgba(183, 121, 31, 0.5);
  border-radius: 6px;
  background: rgba(183, 121, 31, 0.08);
  color: #b7791f;
  font-size: 12px;
}

.foot-spacer {
  flex: 1;
}

.btn {
  padding: 9px 20px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: none;
  color: var(--text-dim);
  font-size: 13px;
  cursor: pointer;
}

.btn.primary {
  border: none;
  background: linear-gradient(135deg, var(--accent), #0b7a48);
  color: #fff;
  font-weight: 700;
  letter-spacing: 1px;
}

.btn:disabled {
  opacity: 0.55;
  cursor: default;
}

@media (max-width: 900px) {
  .tpl-grid {
    grid-template-columns: 1fr;
  }
}
</style>
