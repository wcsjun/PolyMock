<script setup lang="ts">
import type { ConditionRow, ConditionType } from '../types';

const props = defineProps<{
  rows: ConditionRow[];
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addText?: string;
}>();

const emit = defineEmits<{
  'update:rows': [rows: ConditionRow[]];
}>();

const TYPES: Array<{ value: ConditionType; label: string }> = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
  { value: 'json', label: 'json' },
];

function update(index: number, field: keyof ConditionRow, value: string | boolean) {
  emit('update:rows', props.rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
}

function updateText(index: number, field: 'key' | 'value', event: Event) {
  update(index, field, (event.target as HTMLInputElement).value);
}

function addRow() {
  emit('update:rows', [...props.rows, { key: '', value: '', type: 'string', required: true, enabled: true }]);
}

function removeRow(index: number) {
  emit('update:rows', props.rows.filter((_, i) => i !== index));
}
</script>

<template>
  <div class="cond-table">
    <div v-if="rows.length" class="cond-grid cond-head">
      <span>启用</span>
      <span>参数名</span>
      <span>参数值</span>
      <span>类型</span>
      <span>是否必填</span>
      <span></span>
    </div>

    <div v-for="(row, i) in rows" :key="i" class="cond-grid cond-line" :class="{ off: !row.enabled }">
      <input
        :checked="row.enabled"
        type="checkbox"
        class="cond-check"
        :title="row.enabled ? '已启用：参与匹配' : '已停用：不参与匹配'"
        :aria-label="`第 ${i + 1} 行启用`"
        @change="update(i, 'enabled', ($event.target as HTMLInputElement).checked)"
      >
      <input
        :value="row.key"
        type="text"
        class="cond-input"
        :placeholder="keyPlaceholder ?? '参数名'"
        spellcheck="false"
        :aria-label="`第 ${i + 1} 行参数名`"
        @input="updateText(i, 'key', $event)"
      >
      <input
        :value="row.value"
        type="text"
        class="cond-input"
        :placeholder="valuePlaceholder ?? '参数值（留空仅要求存在）'"
        spellcheck="false"
        :aria-label="`第 ${i + 1} 行参数值`"
        @input="updateText(i, 'value', $event)"
      >
      <select
        :value="row.type"
        class="cond-type"
        :aria-label="`第 ${i + 1} 行比对类型`"
        @change="update(i, 'type', ($event.target as HTMLSelectElement).value as ConditionType)"
      >
        <option v-for="t in TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
      </select>
      <label class="cond-req" :title="row.required ? '必填：请求缺少该参数则本场景不命中' : '选填：请求携带该参数时才比对值'">
        <input
          :checked="row.required"
          type="checkbox"
          class="cond-check"
          :aria-label="`第 ${i + 1} 行是否必填`"
          @change="update(i, 'required', ($event.target as HTMLInputElement).checked)"
        >
        <span>{{ row.required ? '必填' : '选填' }}</span>
      </label>
      <button type="button" class="cond-remove" title="删除该行" :aria-label="`删除第 ${i + 1} 行`" @click="removeRow(i)">×</button>
    </div>

    <p v-if="!rows.length" class="cond-empty">暂无条件，点击下方按钮添加</p>
    <button type="button" class="cond-add" @click="addRow">{{ addText ?? '＋ 添加参数' }}</button>
  </div>
</template>

<style scoped>
.cond-table {
  display: grid;
  gap: 6px;
}

.cond-grid {
  display: grid;
  grid-template-columns: 30px minmax(0, 1.1fr) minmax(0, 1.3fr) 92px 64px 24px;
  gap: 6px;
  align-items: center;
}

.cond-head {
  padding: 0 2px;
  font-size: 11px;
  color: var(--text-dim);
  text-align: center;
}

.cond-head span:nth-child(2),
.cond-head span:nth-child(3) {
  text-align: left;
}

.cond-line.off .cond-input,
.cond-line.off .cond-type {
  opacity: 0.4;
}

.cond-check {
  justify-self: center;
  width: 14px;
  height: 14px;
  accent-color: var(--accent);
  cursor: pointer;
}

.cond-input {
  padding: 7px 9px !important;
  font-size: 12px !important;
}

.cond-type {
  width: 100%;
  padding: 7px 6px !important;
  font-size: 12px !important;
  cursor: pointer;
}

.cond-req {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-dim);
  cursor: pointer;
  white-space: nowrap;
}

.cond-remove {
  justify-self: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: none;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: all 0.15s;
}

.cond-remove:hover {
  color: var(--danger);
  border-color: var(--danger);
  background: rgba(207, 34, 46, 0.06);
}

.cond-add {
  justify-self: start;
  margin-top: 2px;
  padding: 5px 12px;
  border: 1px dashed var(--line-strong);
  border-radius: 6px;
  background: none;
  color: var(--text-dim);
  font-family: var(--mono);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.cond-add:hover {
  color: var(--accent-strong);
  border-color: var(--accent);
  background: var(--accent-dim);
}

.cond-empty {
  font-size: 11px;
  color: var(--text-faint);
}
</style>
