<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { clearCrudStore, fetchCrudStores } from '../api';
import type { CrudCollectionStore, NotifyFn, ServiceInfo } from '../types';

const props = defineProps<{
  service: ServiceInfo;
  collection: string;
  open: boolean;
  notify: NotifyFn;
}>();

const emit = defineEmits<{ close: [] }>();

const data = ref<CrudCollectionStore | null>(null);
const loading = ref(false);
const clearing = ref(false);

async function load() {
  loading.value = true;
  try {
    const res = await fetchCrudStores();
    const found = res.collections.find(
      (c) => c.serviceId === props.service.id && c.collection === props.collection,
    );
    data.value = found ?? { serviceId: props.service.id, collection: props.collection, count: 0, records: [] };
  } catch (err) {
    props.notify((err as Error).message, 'err');
  } finally {
    loading.value = false;
  }
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close');
}

/* 打开时拉取数据并监听 Esc（immediate：组件以 open=true 挂载时同样触发）；关闭时移除监听 */
watch(
  () => props.open,
  (open) => {
    if (open) {
      data.value = null;
      void load();
      window.addEventListener('keydown', onKey);
    } else {
      window.removeEventListener('keydown', onKey);
    }
  },
  { immediate: true },
);

onUnmounted(() => window.removeEventListener('keydown', onKey));

/** 清空集合数据：弹窗内二次确认后执行，成功后重新拉取 */
async function clearAll() {
  const count = data.value?.count ?? 0;
  if (!window.confirm(`确认清空 CRUD集合 /${props.collection} 的全部 ${count} 条数据？该操作不可恢复（接口路由保留）`)) return;
  clearing.value = true;
  try {
    const res = await clearCrudStore({ serviceId: props.service.id, collection: props.collection });
    props.notify(`已清空 CRUD集合 /${props.collection} 的 ${res.cleared} 条数据`);
    await load();
  } catch (err) {
    props.notify((err as Error).message, 'err');
  } finally {
    clearing.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="crud-modal-overlay" @click.self="emit('close')">
    <div class="crud-modal" role="dialog" aria-modal="true" :aria-label="`CRUD集合 /${collection} 内存数据`">
      <div class="crud-modal-head">
        <span class="crud-modal-title">CRUD集合 /{{ collection }}</span>
        <span class="crud-modal-count">{{ data ? `${data.count} 条数据` : '加载中…' }}</span>
        <button type="button" class="crud-modal-close" title="关闭（Esc）" aria-label="关闭" @click="emit('close')">×</button>
      </div>
      <div class="crud-modal-bar">
        <span class="crud-modal-hint">内存数据（重启即清），与该集合的接口路由共享</span>
        <span class="crud-modal-actions">
          <button type="button" class="crud-modal-btn" :disabled="loading" @click="load">{{ loading ? '加载中…' : '刷新' }}</button>
          <button
            type="button"
            class="crud-modal-btn danger"
            :disabled="clearing || loading || !data?.count"
            title="清空该 CRUD集合的全部数据"
            @click="clearAll"
          >{{ clearing ? '清空中…' : '清空数据' }}</button>
        </span>
      </div>
      <pre class="crud-modal-pre">{{ data ? JSON.stringify(data.records, null, 2) : '加载中…' }}</pre>
    </div>
  </div>
</template>

<style scoped>
.crud-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(28, 39, 51, 0.45);
}

.crud-modal {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: 10px;
  width: min(760px, 100%);
  max-height: min(640px, 86vh);
  padding: 14px 16px 16px;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  box-shadow: var(--shadow);
}

.crud-modal-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.crud-modal-title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.crud-modal-count {
  flex: none;
  font-size: 12px;
  color: var(--text-dim);
}

.crud-modal-close {
  flex: none;
  margin-left: auto;
  width: 26px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: none;
  color: var(--text-dim);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.crud-modal-close:hover {
  color: var(--danger);
  border-color: var(--danger);
}

.crud-modal-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.crud-modal-hint {
  font-size: 12px;
  color: var(--text-dim);
}

.crud-modal-actions {
  flex: none;
  display: flex;
  gap: 6px;
}

.crud-modal-btn {
  padding: 5px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text-dim);
  font-family: var(--sans);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.crud-modal-btn:hover:not(:disabled) {
  color: var(--accent-strong);
  border-color: var(--accent);
  background: var(--accent-dim);
}

.crud-modal-btn.danger:hover:not(:disabled) {
  color: var(--danger);
  border-color: var(--danger);
  background: rgba(207, 34, 46, 0.08);
}

.crud-modal-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.crud-modal-pre {
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  color: var(--text);
  white-space: pre;
}
</style>
