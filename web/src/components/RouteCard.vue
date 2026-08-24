<script setup lang="ts">
import { computed } from 'vue';
import type { Route } from '../types';
import { formatBody, routeCardStyle } from '../utils';

const props = defineProps<{
  route: Route;
  index: number;
}>();

const emit = defineEmits<{
  edit: [route: Route];
  remove: [route: Route];
}>();

const cardStyle = computed(() => routeCardStyle(props.route.method, props.index));
const bodyPreview = computed(() => formatBody(props.route.response.body));
</script>

<template>
  <article class="route-card" :style="cardStyle">
    <div v-if="route.name" class="route-title" :title="route.name">{{ route.name }}</div>
    <div class="route-row">
      <span class="method-badge">{{ route.method }}</span>
      <span class="route-path" :title="route.path">{{ route.path }}</span>
      <button
        type="button"
        class="route-edit"
        title="编辑接口"
        :aria-label="`编辑 ${route.method} ${route.path}`"
        @click="emit('edit', route)"
      >
        ✎
      </button>
      <button
        type="button"
        class="route-remove"
        title="删除接口"
        :aria-label="`删除 ${route.method} ${route.path}`"
        @click="emit('remove', route)"
      >
        ×
      </button>
    </div>
    <div class="route-meta">
      <span class="route-status" :class="{ bad: route.response.status >= 400 }">HTTP {{ route.response.status }}</span>
      <span>application/json</span>
    </div>
    <pre class="route-body">{{ bodyPreview }}</pre>
  </article>
</template>
