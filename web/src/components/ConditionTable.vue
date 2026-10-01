<script setup lang="ts">
import { computed } from 'vue';
import type { ConditionMatch, ConditionRow, ConditionSource, ConditionType } from '../types';
import { CONDITION_MATCH_LABELS } from '../utils';

const props = defineProps<{
  rows: ConditionRow[];
  /** 显示「来源」列（请求准入的扁平条件列表用；分支条件按页签分组，不显示） */
  showSource?: boolean;
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
  { value: 'array', label: 'array' },
];

const SOURCES: Array<{ value: ConditionSource; label: string }> = [
  { value: 'query', label: 'Params' },
  { value: 'headers', label: 'Headers' },
  { value: 'body', label: 'Body' },
];

/** 存在 / 非空无需填写期望值（空字符串也算存在） */
const NO_VALUE_MATCHES: ReadonlySet<ConditionMatch> = new Set<ConditionMatch>(['exists', 'nonEmpty']);

const rowsWithSource = computed(() => props.showSource === true);

function update(index: number, field: keyof ConditionRow, value: string | boolean) {
  emit('update:rows', props.rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
}

function updateText(index: number, field: 'key' | 'value', event: Event) {
  update(index, field, (event.target as HTMLInputElement).value);
}

function updateMatch(index: number, match: ConditionMatch) {
  /* 切到「存在」时必填失去意义，统一置为必填，避免出现永远通过的无效条件 */
  if (match === 'exists') {
    emit('update:rows', props.rows.map((item, i) => (i === index ? { ...item, match, required: true } : item)));
    return;
  }
  update(index, 'match', match);
}

function addRow() {
  emit('update:rows', [
    ...props.rows,
    {
      key: '',
      value: '',
      type: 'string',
      required: true,
      enabled: true,
      match: 'equals',
      ...(rowsWithSource.value ? { source: 'query' as ConditionSource } : {}),
    },
  ]);
}

function removeRow(index: number) {
  emit('update:rows', props.rows.filter((_, i) => i !== index));
}

function matchHint(match: ConditionMatch): string {
  return CONDITION_MATCH_LABELS.find((item) => item.value === match)?.hint ?? '';
}
</script>

<template>
  <div class="cond-table">
    <div v-for="(row, i) in rows" :key="i" class="cond-row" :class="{ off: !row.enabled }">
      <input
        :checked="row.enabled"
        type="checkbox"
        class="cond-check"
        :title="row.enabled ? '已启用：参与匹配' : '已停用：不参与匹配'"
        :aria-label="`第 ${i + 1} 行启用`"
        @change="update(i, 'enabled', ($event.target as HTMLInputElement).checked)"
      >

      <select
        v-if="rowsWithSource"
        :value="row.source ?? 'query'"
        class="cond-source"
        :aria-label="`第 ${i + 1} 行条件来源`"
        @change="update(i, 'source', ($event.target as HTMLSelectElement).value as ConditionSource)"
      >
        <option v-for="s in SOURCES" :key="s.value" :value="s.value">{{ s.label }}</option>
      </select>

      <input
        :value="row.key"
        type="text"
        class="cond-input cond-key"
        :placeholder="keyPlaceholder ?? '参数名'"
        spellcheck="false"
        :aria-label="`第 ${i + 1} 行参数名`"
        @input="updateText(i, 'key', $event)"
      >

      <select
        :value="row.match"
        class="cond-op"
        :title="matchHint(row.match)"
        :aria-label="`第 ${i + 1} 行匹配操作符`"
        @change="updateMatch(i, ($event.target as HTMLSelectElement).value as ConditionMatch)"
      >
        <option v-for="op in CONDITION_MATCH_LABELS" :key="op.value" :value="op.value">{{ op.label }}</option>
      </select>

      <span v-if="row.match === 'exists' || row.match === 'nonEmpty'" class="cond-note">
        {{ row.match === 'exists' ? '无需填写值 · 空字符串也算存在' : '无需填写值 · 存在且非空即通过' }}
      </span>
      <input
        v-else
        :value="row.value"
        type="text"
        class="cond-input cond-value"
        :class="{ 'cond-regex': row.match === 'regex' }"
        :placeholder="row.match === 'regex' ? '正则，如 ^cn-\\w+$' : (valuePlaceholder ?? '参数值')"
        spellcheck="false"
        :aria-label="`第 ${i + 1} 行参数值`"
        @input="updateText(i, 'value', $event)"
      >

      <select
        v-if="row.match === 'equals'"
        :value="row.type"
        class="cond-type"
        title="比对方式：json 深度相等 / array 包含匹配"
        :aria-label="`第 ${i + 1} 行比对类型`"
        @change="update(i, 'type', ($event.target as HTMLSelectElement).value as ConditionType)"
      >
        <option v-for="t in TYPES" :key="t.value" :value="t.value">{{ t.label }}</option>
      </select>

      <label
        v-if="row.match !== 'exists'"
        class="cond-req"
        :title="row.required ? '必填：请求缺少该参数则本条不通过' : '选填：请求携带该参数时才比对值'"
      >
        <input
          :checked="row.required"
          type="checkbox"
          class="cond-check"
          :aria-label="`第 ${i + 1} 行是否必填`"
          @change="update(i, 'required', ($event.target as HTMLInputElement).checked)"
        >
        <span>{{ row.required ? '必填' : '选填' }}</span>
      </label>

      <button type="button" class="cond-remove" title="删除该条件" :aria-label="`删除第 ${i + 1} 行`" @click="removeRow(i)">×</button>
    </div>

    <p v-if="!rows.length" class="cond-empty">暂无条件，点击下方按钮添加</p>
    <button type="button" class="cond-add" @click="addRow">{{ addText ?? '＋ 添加条件' }}</button>
  </div>
</template>

<style scoped>
.cond-table {
  display: grid;
  gap: 7px;
}

.cond-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
}

.cond-row.off .cond-input,
.cond-row.off .cond-type,
.cond-row.off .cond-op,
.cond-row.off .cond-source,
.cond-row.off .cond-note {
  opacity: 0.45;
}

.cond-check {
  flex: none;
  width: 14px;
  height: 14px;
  accent-color: var(--accent);
  cursor: pointer;
}

.cond-source {
  flex: none;
  width: 92px;
  padding: 7px 6px !important;
  border-color: transparent;
  color: var(--accent-strong);
  background: var(--accent-dim);
  font-size: 12px !important;
  font-weight: 600;
  cursor: pointer;
}

.cond-input {
  padding: 7px 9px !important;
  font-size: 12px !important;
}

.cond-key {
  flex: 1 1 92px;
  min-width: 0;
}

.cond-value {
  flex: 1 1 96px;
  min-width: 0;
}

.cond-value.cond-regex {
  font-family: var(--mono);
}

.cond-op {
  flex: none;
  width: 74px;
  padding: 7px 6px !important;
  font-size: 12px !important;
  cursor: pointer;
}

.cond-note {
  flex: 1 1 150px;
  min-width: 0;
  color: var(--text-faint);
  font-size: 12px;
  padding: 0 4px;
}

.cond-type {
  flex: none;
  width: 74px;
  padding: 7px 6px !important;
  font-size: 12px !important;
  cursor: pointer;
}

.cond-req {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  white-space: nowrap;
}

.cond-remove {
  flex: none;
  width: 26px;
  height: 26px;
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
  font-family: var(--sans);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.cond-add:hover {
  color: var(--accent-strong);
  border-color: var(--accent);
  background: var(--accent-dim);
}

.cond-empty {
  font-size: 12px;
  color: var(--text-faint);
}
</style>
