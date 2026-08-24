<script setup lang="ts">
import { ref, watch } from 'vue';
import { createRoute, updateRoute } from '../api';
import type { NotifyFn, Route, RoutePayload, ServiceInfo } from '../types';
import { formatBody } from '../utils';

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

const BODY_PLACEHOLDER = `{
  "code": 0,
  "data": {
    "id": 1001,
    "name": "PolyMock"
  }
}`;

const serviceId = ref('');
const name = ref('');
const method = ref<string>('GET');
const path = ref('');
const status = ref<number | null>(200);
const body = ref('');
const bodyInvalid = ref(false);
const submitting = ref(false);
const pathInput = ref<HTMLInputElement | null>(null);

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
  serviceId.value = props.services.some((s) => s.id === keepService)
    ? keepService
    : props.services[0]?.id ?? '';
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

  const rawBody = body.value.trim();
  if (rawBody) {
    try {
      JSON.parse(rawBody);
      bodyInvalid.value = false;
    } catch {
      bodyInvalid.value = true;
      props.notify('body 不是合法的 JSON', 'err');
      return;
    }
  }

  submitting.value = true;
  try {
    const payload: RoutePayload = {
      serviceId: serviceId.value,
      method: routeMethod,
      path: routePath,
      response: { status: routeStatus, body: rawBody },
    };
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
        <label for="f-status">响应状态码</label>
        <input id="f-status" v-model.number="status" name="status" type="number" min="100" max="599">
      </div>

      <div class="field">
        <div class="label-row">
          <label for="f-body">响应 Body（JSON）</label>
          <span class="hint">留空则返回空对象</span>
        </div>
        <textarea
          id="f-body"
          v-model="body"
          name="body"
          rows="8"
          :placeholder="BODY_PLACEHOLDER"
          spellcheck="false"
          :class="{ invalid: bodyInvalid }"
        ></textarea>
        <p v-show="bodyInvalid" class="field-error">body 不是合法的 JSON</p>
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
