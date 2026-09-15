<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { createService, deleteRoute, setProxy, updateServiceBasePath } from '../api';
import type { NotifyFn, PolyMockMode, Route, ServiceInfo } from '../types';
import { groupCrudRoutes, proxyTargetLabel, type CrudRouteGroup } from '../utils';
import CrudDataModal from './CrudDataModal.vue';
import RouteCard from './RouteCard.vue';

const props = defineProps<{
  services: ServiceInfo[];
  routes: Route[];
  expanded: Set<string>;
  mode: PolyMockMode;
  /** 主端口：路径模式下非默认服务接口 URL 用 mainPort + basePath 拼接 */
  mainPort: number;
  notify: NotifyFn;
}>();

const emit = defineEmits<{
  toggle: [serviceId: string];
  remove: [service: ServiceInfo];
  edit: [route: Route];
  'remove-route': [route: Route];
  'toggle-disable': [route: Route];
  changed: [];
}>();

const routesByService = computed(() => {
  const map = new Map<string, Route[]>();
  for (const route of props.routes) {
    const list = map.get(route.serviceId) ?? [];
    list.push(route);
    map.set(route.serviceId, list);
  }
  return map;
});

function routesOf(serviceId: string): Route[] {
  return routesByService.value.get(serviceId) ?? [];
}

/* ---------- 有状态 CRUD：集合分组与存储查看/清空 ---------- */

/** 组 key = serviceId + 集合键 */
function crudGroupKey(serviceId: string, collection: string): string {
  return `${serviceId}\u0000${collection}`;
}

function crudGroupsOf(serviceId: string): CrudRouteGroup[] {
  return groupCrudRoutes(routesOf(serviceId));
}

/** 非 crud 的普通接口卡片（crud 路由已在集合分组内展示） */
function plainRoutesOf(serviceId: string): Route[] {
  return routesOf(serviceId).filter((route) => route.crud !== true);
}

/** 分组折叠状态：默认展开（保持卡片可见），可折叠只留组头 */
const collapsedGroups = reactive(new Set<string>());

function toggleCrudGroup(key: string) {
  if (collapsedGroups.has(key)) collapsedGroups.delete(key);
  else collapsedGroups.add(key);
}

/** 数据弹窗：当前查看的集合（null = 关闭） */
const crudModal = ref<{ service: ServiceInfo; collection: string } | null>(null);

function openCrudData(svc: ServiceInfo, collection: string) {
  crudModal.value = { service: svc, collection };
}

/** 正在整集合删除中的组 key */
const deletingCollections = reactive(new Set<string>());

/** 删除整个 CRUD集合：确认后逐个删除组内接口（内存数据随之丢弃） */
async function removeCrudCollection(svc: ServiceInfo, group: CrudRouteGroup) {
  if (!window.confirm(`删除 CRUD集合 /${group.collection} 的全部 ${group.routes.length} 个接口？接口与内存数据一并删除，不可恢复`)) return;
  const key = crudGroupKey(svc.id, group.collection);
  deletingCollections.add(key);
  try {
    for (const route of group.routes) {
      await deleteRoute({ method: route.method, path: route.path, serviceId: route.serviceId });
    }
    props.notify(`已删除 CRUD集合 /${group.collection} 的 ${group.routes.length} 个接口`);
  } catch (err) {
    props.notify((err as Error).message, 'err');
  } finally {
    deletingCollections.delete(key);
    emit('changed');
  }
}

/* ---------- 新增服务表单 ---------- */

const sName = ref('');
const sPort = ref<number | ''>('');
const sBasePath = ref('');
const adding = ref(false);

async function submitService() {
  const name = sName.value.trim();

  if (!name) {
    props.notify('请输入服务名称', 'err');
    return;
  }

  try {
    if (props.mode === 'path') {
      await createService(name, 0, sBasePath.value.trim());
      props.notify(`已新增服务「${name}」（/${sBasePath.value.trim() || '自动生成前缀'}）`);
    } else {
      const port = Number(sPort.value);
      if (!port || port < 1 || port > 65535) {
        props.notify('请输入 1-65535 之间的端口', 'err');
        return;
      }
      await createService(name, port);
      props.notify(`已新增服务「${name}」(:${port})`);
    }
    sName.value = '';
    sPort.value = '';
    sBasePath.value = '';
    emit('changed');
  } catch (err) {
    props.notify((err as Error).message, 'err');
  }
}

/* ---------- basePath 编辑（路径模式） ---------- */

const basePathDrafts = reactive<Record<string, string>>({});

watch(
  () => props.services,
  (list) => {
    for (const svc of list) {
      if (!(svc.id in basePathDrafts)) basePathDrafts[svc.id] = svc.basePath ?? '';
    }
  },
  { immediate: true },
);

/** 正在编辑 basePath 的服务 id：由头部前缀徽标唤出，就地显示在服务头部下方 */
const basePathEditing = ref<string | null>(null);

function toggleBasePathRow(serviceId: string) {
  basePathEditing.value = basePathEditing.value === serviceId ? null : serviceId;
}

async function saveBasePath(svc: ServiceInfo) {
  const basePath = (basePathDrafts[svc.id] ?? '').trim();
  try {
    await updateServiceBasePath(svc.id, basePath);
    props.notify(`已更新「${svc.name}」的 basePath → /${basePath}`);
    basePathEditing.value = null;
    emit('changed');
  } catch (err) {
    props.notify((err as Error).message, 'err');
  }
}

/* ---------- 服务代理穿透配置 ---------- */

const proxyDrafts = reactive<Record<string, string>>({});

/* 服务首次出现时用 proxyTarget 回填草稿；轮询刷新不覆盖正在编辑的内容 */
watch(
  () => props.services,
  (list) => {
    for (const svc of list) {
      if (!(svc.id in proxyDrafts)) proxyDrafts[svc.id] = svc.proxyTarget ?? '';
    }
  },
  { immediate: true },
);

/** 正在编辑代理的服务 id：编辑行就地显示在服务头部下方，无需展开卡片滚动到底部 */
const proxyEditing = ref<string | null>(null);

function toggleProxyRow(serviceId: string) {
  proxyEditing.value = proxyEditing.value === serviceId ? null : serviceId;
}

async function saveProxy(svc: ServiceInfo) {
  const target = (proxyDrafts[svc.id] ?? '').trim() || null;
  try {
    await setProxy(svc.id, target);
    props.notify(target ? `已为「${svc.name}」设置代理穿透 → ${target}` : `已关闭「${svc.name}」的代理穿透`);
    proxyEditing.value = null;
    emit('changed');
  } catch (err) {
    props.notify((err as Error).message, 'err');
  }
}
</script>

<template>
  <section class="panel routes-panel">
    <div class="panel-head">
      <h2>服务分组</h2>
      <span class="count-badge">{{ services.length }}</span>
    </div>

    <div class="services" aria-live="polite">
      <div
        v-for="svc in services"
        :key="svc.id"
        class="service-card"
        :class="{ open: expanded.has(svc.id) }"
      >
        <div class="service-head">
          <button
            type="button"
            class="service-toggle"
            :aria-expanded="expanded.has(svc.id)"
            @click="emit('toggle', svc.id)"
          >
            <span class="chevron">▸</span>
            <span class="service-main">
              <span class="service-name-row">
                <span class="service-name" :title="svc.name">{{ svc.name }}</span>
                <span v-if="svc.isDefault" class="service-tag">默认</span>
              </span>
              <span v-if="mode === 'path' && svc.isDefault" class="service-port" title="默认服务占用主端口根路径，接口无需前缀">/</span>
              <span v-else-if="mode !== 'path'" class="service-port">:{{ svc.port }}</span>
            </span>
            <span class="service-meta">
              <span
                class="service-dot"
                :class="svc.running ? 'on' : 'off'"
                :title="svc.running ? '监听中' : '未监听'"
              ></span>
              <span>{{ routesOf(svc.id).length }} 个接口</span>
            </span>
          </button>
          <button
            v-if="mode === 'path' && !svc.isDefault"
            type="button"
            class="proxy-chip"
            :class="{ on: basePathEditing === svc.id }"
            :title="`路径前缀 /${svc.basePath ?? ''}（点击修改）`"
            @click="toggleBasePathRow(svc.id)"
          >/{{ svc.basePath }}</button>
          <button
            type="button"
            class="proxy-chip"
            :class="{ on: !!svc.proxyTarget }"
            :title="svc.proxyTarget ? `代理穿透 → ${svc.proxyTarget}（点击修改）` : '设置代理穿透：未命中接口转发到该地址'"
            @click="toggleProxyRow(svc.id)"
          >代理<template v-if="svc.proxyTarget"> → {{ proxyTargetLabel(svc.proxyTarget) }}</template></button>
          <span v-if="svc.isDefault" class="service-remove-ph" aria-hidden="true"></span>
          <button
            v-else
            type="button"
            class="service-remove"
            title="删除服务及其接口"
            @click="emit('remove', svc)"
          >
            ×
          </button>
        </div>
        <!-- 代理穿透就地编辑：由头部徽标唤出，无需展开卡片滚动到底部 -->
        <div v-if="proxyEditing === svc.id" class="proxy-edit">
          <input
            v-model="proxyDrafts[svc.id]"
            name="proxy"
            type="text"
            placeholder="代理穿透目标，如 http://localhost:3000（留空保存 = 关闭）"
            spellcheck="false"
            @keydown.enter.prevent="saveProxy(svc)"
          >
          <button type="button" class="proxy-save" title="保存代理穿透配置" @click="saveProxy(svc)">保存</button>
          <button type="button" class="proxy-save" title="收起编辑行" @click="toggleProxyRow(svc.id)">收起</button>
        </div>
        <!-- basePath 就地编辑：由头部前缀徽标唤出，与代理编辑行同款布局 -->
        <div v-if="basePathEditing === svc.id" class="proxy-edit">
          <input
            v-model="basePathDrafts[svc.id]"
            name="basePath"
            type="text"
            placeholder="basePath 前缀，如 order（留空恢复自动生成）"
            spellcheck="false"
            @keydown.enter.prevent="saveBasePath(svc)"
          >
          <button type="button" class="proxy-save" title="保存 basePath 前缀" @click="saveBasePath(svc)">保存</button>
          <button type="button" class="proxy-save" title="收起编辑行" @click="toggleBasePathRow(svc.id)">收起</button>
        </div>
        <div v-if="expanded.has(svc.id)" class="service-routes">
          <p v-if="routesOf(svc.id).length === 0" class="service-empty">该服务下还没有接口，点击上方「＋ 新增接口」添加</p>

          <!-- 有状态 CRUD：同集合（同服务同路径形状）的路由聚为一组，共享同一份内存数据 -->
          <div
            v-for="group in crudGroupsOf(svc.id)"
            :key="`crud-${svc.id}-${group.collection}`"
            class="crud-group"
          >
            <div class="crud-group-head">
              <button
                type="button"
                class="crud-group-toggle"
                :aria-expanded="!collapsedGroups.has(crudGroupKey(svc.id, group.collection))"
                title="展开/折叠该 CRUD集合的接口"
                @click="toggleCrudGroup(crudGroupKey(svc.id, group.collection))"
              >
                <span class="crud-chevron" :class="{ open: !collapsedGroups.has(crudGroupKey(svc.id, group.collection)) }">▸</span>
                <span class="crud-group-name">CRUD集合 /{{ group.collection }}</span>
                <span class="crud-group-meta">{{ group.routes.length }} 个接口</span>
              </button>
              <span class="crud-group-actions">
                <button
                  type="button"
                  class="crud-group-btn"
                  title="查看该 CRUD集合的内存数据"
                  @click="openCrudData(svc, group.collection)"
                >查看数据</button>
                <button
                  type="button"
                  class="crud-group-btn danger"
                  :disabled="deletingCollections.has(crudGroupKey(svc.id, group.collection))"
                  title="删除该 CRUD集合的全部接口与数据"
                  @click="removeCrudCollection(svc, group)"
                >{{ deletingCollections.has(crudGroupKey(svc.id, group.collection)) ? '删除中…' : '删除' }}</button>
              </span>
            </div>
            <template v-if="!collapsedGroups.has(crudGroupKey(svc.id, group.collection))">
              <RouteCard
                v-for="(route, i) in group.routes"
                :key="route.id"
                :route="route"
                :index="i"
                :port="mode === 'path' && !svc.isDefault ? mainPort : svc.port"
                :base-path="mode === 'path' && !svc.isDefault ? svc.basePath : undefined"
                :notify="notify"
                @edit="emit('edit', $event)"
                @remove="emit('remove-route', $event)"
                @toggle-disable="emit('toggle-disable', $event)"
              />
            </template>
          </div>

          <!-- 普通（非 CRUD）接口卡片 -->
          <RouteCard
            v-for="(route, i) in plainRoutesOf(svc.id)"
            :key="route.id"
            :route="route"
            :index="i"
            :port="mode === 'path' && !svc.isDefault ? mainPort : svc.port"
            :base-path="mode === 'path' && !svc.isDefault ? svc.basePath : undefined"
            :notify="notify"
            @edit="emit('edit', $event)"
            @remove="emit('remove-route', $event)"
            @toggle-disable="emit('toggle-disable', $event)"
          />
        </div>
      </div>
    </div>

    <form class="service-form" autocomplete="off" @submit.prevent="submitService">
      <input v-model="sName" name="name" type="text" placeholder="服务名称，如 订单服务" spellcheck="false">
      <input
        v-if="mode === 'path'"
        v-model="sBasePath"
        name="basePath"
        type="text"
        placeholder="basePath（可选）"
        title="basePath 前缀（可选）：小写字母或数字开头，仅含小写字母、数字、连字符；留空时按服务名自动生成，如 order"
        spellcheck="false"
      >
      <input
        v-else
        v-model.number="sPort"
        name="port"
        type="number"
        placeholder="端口号"
        title="服务监听端口，1-65535 的整数，如 3001"
        min="1"
        max="65535"
      >
      <button type="submit" class="svc-add" :title="mode === 'path' ? '新增服务（basePath 前缀分发）' : '新增服务（独立端口监听）'">＋</button>
    </form>

    <!-- CRUD集合内存数据弹窗 -->
    <CrudDataModal
      v-if="crudModal"
      :service="crudModal.service"
      :collection="crudModal.collection"
      :open="true"
      :notify="notify"
      @close="crudModal = null"
    />
  </section>
</template>

<style scoped>
/* ---------- 服务头部的代理状态徽标 ---------- */
.proxy-chip {
  flex: none;
  max-width: 200px;
  padding: 3px 10px;
  border: 1px dashed var(--line-strong);
  border-radius: 999px;
  background: none;
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.proxy-chip:hover,
.proxy-chip.on {
  color: var(--accent-strong);
  border-color: var(--accent);
  background: var(--accent-dim);
}

.proxy-chip.on {
  border-style: solid;
}

/* ---------- 代理穿透就地编辑行（头部下方） ---------- */
.proxy-edit {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px dashed var(--line);
  background: var(--bg-soft);
}

.proxy-edit input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  font-size: 12px;
}

/* ---------- 有状态 CRUD 集合分组 ---------- */
/* 与普通接口卡片同级等宽：外层 .service-routes 网格统一提供外边距与间距，组内用自身网格排布 */
.crud-group {
  display: grid;
  gap: 8px;
  padding: 8px 10px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-soft);
}

.crud-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.crud-group-toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font-family: var(--sans);
  color: var(--text);
  text-align: left;
}

/* 组折叠箭头（chevron）：独立类名，避开全局 .service-card.open .chevron 的旋转规则 */
.crud-chevron {
  flex: none;
  display: inline-block;
  color: var(--text-faint);
  transition: transform 0.15s;
}

.crud-chevron.open {
  transform: rotate(90deg);
}

.crud-group-name {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.crud-group-meta {
  flex: none;
  font-size: 12px;
  color: var(--text-dim);
}

.crud-group-actions {
  flex: none;
  display: flex;
  gap: 6px;
}

.crud-group-btn {
  padding: 3px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text-dim);
  font-family: var(--sans);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.crud-group-btn:hover {
  color: var(--accent-strong);
  border-color: var(--accent);
  background: var(--accent-dim);
}

.crud-group-btn.danger:hover:not(:disabled) {
  color: var(--danger);
  border-color: var(--danger);
  background: rgba(207, 34, 46, 0.08);
}

.crud-group-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.proxy-save {
  flex: none;
  padding: 8px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: none;
  color: var(--text-dim);
  font-family: var(--sans);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.proxy-save:hover {
  color: var(--accent-strong);
  border-color: var(--accent);
  background: var(--accent-dim);
}
</style>
