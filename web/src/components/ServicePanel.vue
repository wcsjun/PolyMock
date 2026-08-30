<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { createService, setProxy } from '../api';
import type { NotifyFn, Route, ServiceInfo } from '../types';
import RouteCard from './RouteCard.vue';

const props = defineProps<{
  services: ServiceInfo[];
  routes: Route[];
  expanded: Set<string>;
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

/* ---------- 新增服务表单 ---------- */

const sName = ref('');
const sPort = ref<number | ''>('');
const adding = ref(false);

async function submitService() {
  const name = sName.value.trim();
  const port = Number(sPort.value);

  if (!name) {
    props.notify('请输入服务名称', 'err');
    return;
  }
  if (!port || port < 1 || port > 65535) {
    props.notify('请输入 1-65535 之间的端口', 'err');
    return;
  }

  try {
    await createService(name, port);
    sName.value = '';
    sPort.value = '';
    props.notify(`已新增服务「${name}」(:${port})`);
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

async function saveProxy(svc: ServiceInfo) {
  const target = (proxyDrafts[svc.id] ?? '').trim() || null;
  try {
    await setProxy(svc.id, target);
    props.notify(target ? `已为「${svc.name}」设置代理穿透 → ${target}` : `已关闭「${svc.name}」的代理穿透`);
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
              <span class="service-port">:{{ svc.port }}</span>
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
        <div v-if="expanded.has(svc.id)" class="service-routes">
          <p v-if="routesOf(svc.id).length === 0" class="service-empty">该服务下还没有接口，点击上方「＋ 新增接口」添加</p>
          <RouteCard
            v-for="(route, i) in routesOf(svc.id)"
            :key="route.id"
            :route="route"
            :index="i"
            :port="svc.port"
            :notify="notify"
            @edit="emit('edit', $event)"
            @remove="emit('remove-route', $event)"
            @toggle-disable="emit('toggle-disable', $event)"
          />
        </div>
        <div v-if="expanded.has(svc.id)" class="service-proxy">
          <input
            v-model="proxyDrafts[svc.id]"
            name="proxy"
            type="text"
            placeholder="代理穿透目标，如 http://localhost:3000（留空关闭）"
            spellcheck="false"
            @keydown.enter.prevent="saveProxy(svc)"
          >
          <button type="button" class="proxy-save" title="保存代理穿透配置" @click="saveProxy(svc)">保存</button>
        </div>
      </div>
    </div>

    <form class="service-form" autocomplete="off" @submit.prevent="submitService">
      <input v-model="sName" name="name" type="text" placeholder="服务名称，如 订单服务" spellcheck="false">
      <input v-model.number="sPort" name="port" type="number" placeholder="端口，如 3001" min="1" max="65535">
      <button type="submit" class="svc-add" title="新增服务（独立端口监听）">＋</button>
    </form>
  </section>
</template>

<style scoped>
/* 展开卡片内的代理穿透配置行，视觉对齐 .service-form */
.service-proxy {
  display: flex;
  gap: 8px;
  padding: 10px 12px 12px;
  border-top: 1px dashed var(--line);
}

.service-proxy input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  font-size: 12px;
}

.proxy-save {
  flex: none;
  padding: 8px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: none;
  color: var(--text-dim);
  font-family: var(--mono);
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
