<script setup lang="ts">
import { ref } from 'vue';
import type { PolyMockMode, ServiceInfo } from '../../types';
import { serviceDisplaySuffix } from '../../utils';

defineProps<{
  editing: boolean;
  /** 运行模式：决定服务分组下拉的后缀展示（端口模式 :端口 / 路径模式 basePath 前缀） */
  mode: PolyMockMode;
  services: ServiceInfo[];
}>();

const serviceId = defineModel<string>('serviceId', { required: true });
const name = defineModel<string>('name', { required: true });
const method = defineModel<string>('method', { required: true });
const path = defineModel<string>('path', { required: true });

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/* 路径参数提示（含 {{ }} 字面量，须经常量绑定渲染） */
const PATH_PARAM_HINT = '支持 :参数 段，如 /api/users/:id，响应模板可用 {{params.id}}';

const pathInput = ref<HTMLInputElement | null>(null);

/** 表单挂在抽屉里，等抽屉显示后再聚焦（父组件在编辑回填后调用） */
function focusPath() {
  pathInput.value?.focus();
}

defineExpose({ focusPath });
</script>

<template>
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
            <option v-for="s in services" :key="s.id" :value="s.id">{{ s.name }} {{ serviceDisplaySuffix(s, mode) }}</option>
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
</template>

<style scoped src="./section-card.css"></style>

<style scoped>
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

@media (max-width: 900px) {
  .field-grid {
    grid-template-columns: 1fr;
  }
}
</style>
