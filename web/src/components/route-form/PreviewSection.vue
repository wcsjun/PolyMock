<script setup lang="ts">
import type { PreviewRoute } from '../../match-preview';
import MatchPreview from '../MatchPreview.vue';

defineProps<{
  /** 父组件推演好的预览路由（match-preview.ts 的纯前端推演输入） */
  previewRoute: PreviewRoute;
  method: string;
  path: string;
}>();

const previewOpen = defineModel<boolean>('previewOpen', { required: true });
</script>

<template>
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
</template>

<style scoped src="./section-card.css"></style>
