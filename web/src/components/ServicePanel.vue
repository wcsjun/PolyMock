<script setup lang="ts">
import { computed, ref } from 'vue';
import { createService } from '../api';
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
          />
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
