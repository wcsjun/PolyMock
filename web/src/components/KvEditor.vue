<script setup lang="ts">
import type { RequestCondition } from '../types';

const props = defineProps<{
  rows: RequestCondition[];
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}>();

const emit = defineEmits<{
  'update:rows': [rows: RequestCondition[]];
}>();

function update(index: number, field: keyof RequestCondition, event: Event) {
  const rows = props.rows.map((row, i) => (i === index ? { ...row, [field]: (event.target as HTMLInputElement).value } : row));
  emit('update:rows', rows);
}

function addRow() {
  emit('update:rows', [...props.rows, { key: '', value: '' }]);
}

function removeRow(index: number) {
  emit('update:rows', props.rows.filter((_, i) => i !== index));
}
</script>

<template>
  <div class="kv-editor">
    <div v-if="rows.length" class="kv-rows">
      <div v-for="(row, i) in rows" :key="i" class="kv-row">
        <input
          :value="row.key"
          type="text"
          class="kv-key"
          :placeholder="keyPlaceholder ?? '键'"
          spellcheck="false"
          @input="update(i, 'key', $event)"
        >
        <input
          :value="row.value"
          type="text"
          class="kv-value"
          :placeholder="valuePlaceholder ?? '值'"
          spellcheck="false"
          @input="update(i, 'value', $event)"
        >
        <button type="button" class="kv-remove" title="删除该行" :aria-label="`删除第 ${i + 1} 行`" @click="removeRow(i)">×</button>
      </div>
    </div>
    <p v-else class="kv-empty">暂无条件，点击下方按钮添加</p>
    <button type="button" class="kv-add" @click="addRow">＋ 添加</button>
  </div>
</template>
