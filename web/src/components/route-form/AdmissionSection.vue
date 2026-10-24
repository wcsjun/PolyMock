<script setup lang="ts">
import { computed } from 'vue';
import type { BodyMatchMode, ConditionRow } from '../../types';
import { BODY_MATCH_LABELS } from '../../utils';
import ConditionTable from '../ConditionTable.vue';

const props = defineProps<{
  /** 扁平准入条件行（父组件持有；非 subset 策略下 body 行不在可见列表中，由本组件合并回传） */
  rows: ConditionRow[];
}>();

const gateOn = defineModel<boolean>('gateOn', { required: true });
const gateOpen = defineModel<boolean>('gateOpen', { required: true });
const gateBodyMatch = defineModel<BodyMatchMode>('gateBodyMatch', { required: true });
const gateBodyRaw = defineModel<string>('gateBodyRaw', { required: true });
const gateStatus = defineModel<400 | 404 | 422>('gateStatus', { required: true });

const emit = defineEmits<{
  /** 行列表被编辑：把可见行（必要时合并回隐藏的 body 行）交回父组件 */
  'update:rows': [rows: ConditionRow[]];
}>();

/** 准入失败码：400（缺省）/ 404（隐藏接口）/ 422 */
const gateStatuses = [400, 404, 422] as const;

/* 完整 JSON / 原文期望值占位示例 */
const BODY_RAW_PLACEHOLDER = `{
  "status": "PAID",
  "orderId": "1001"
}`;

const gateBodyRowCount = computed(() => props.rows.filter((row) => (row.source ?? 'query') === 'body').length);
const gateShowsStrategy = computed(() => gateBodyRowCount.value > 0 || gateBodyMatch.value !== 'subset');
const gateVisibleRows = computed(() =>
  gateBodyMatch.value === 'subset' ? props.rows : props.rows.filter((row) => (row.source ?? 'query') !== 'body'),
);

const gateBodyHint = computed(() => BODY_MATCH_LABELS.find((m) => m.value === gateBodyMatch.value)?.hint ?? '');

/** 准入区行列表被编辑：非 subset 策略下 body 行不在列表中，需保留原值合并回去 */
function setGateVisibleRows(rows: ConditionRow[]) {
  if (gateBodyMatch.value === 'subset') {
    emit('update:rows', rows);
    return;
  }
  const bodyRows = props.rows.filter((row) => (row.source ?? 'query') === 'body');
  emit('update:rows', [...rows, ...bodyRows]);
}
</script>

<template>
  <!-- ========== 请求准入 ========== -->
  <section class="card">
    <div class="card-head">
      <div>
        <div class="card-title">请求准入</div>
        <div class="card-note">共享条件只配置一次，所有响应分支都会先经过这里。</div>
      </div>
      <div class="card-head-ops">
        <span class="card-chip state" :class="{ off: !gateOn }">{{ gateOn ? '已开启' : '已关闭' }}</span>
        <button
          type="button"
          class="mini-btn"
          :aria-expanded="gateOpen"
          aria-controls="gate-body"
          @click="gateOpen = !gateOpen"
        >
          {{ gateOpen ? '收起 ▴' : '展开 ▾' }}
        </button>
      </div>
    </div>
    <div v-show="gateOpen" id="gate-body" class="card-body">
      <label class="switch-row" for="f-gate">
        <span class="switch-text">
          <span class="switch-title">启用请求准入</span>
          <span class="hint">不满足时不进入响应分支，并按下方「准入失败码」返回</span>
        </span>
        <input id="f-gate" v-model="gateOn" type="checkbox" class="switch-input">
        <span class="switch-ui" aria-hidden="true"></span>
      </label>

      <div class="gate-body" :class="{ off: !gateOn }">
        <div v-if="gateShowsStrategy" class="strategy-row">
          <label class="body-strategy">
            Body 匹配策略
            <select v-model="gateBodyMatch">
              <option v-for="m in BODY_MATCH_LABELS" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
          </label>
          <span class="hint">{{ gateBodyHint }}</span>
        </div>

        <ConditionTable
          v-if="gateBodyMatch === 'subset'"
          :rows="gateVisibleRows"
          show-source
          add-text="＋ 添加共享条件"
          @update:rows="setGateVisibleRows"
        />

        <template v-else>
          <textarea
            v-model="gateBodyRaw"
            class="body-raw-editor"
            rows="5"
            :placeholder="BODY_RAW_PLACEHOLDER"
            spellcheck="false"
            aria-label="请求准入的完整 JSON / 原文期望值"
          ></textarea>
          <ConditionTable :rows="gateVisibleRows" show-source add-text="＋ 添加共享条件" @update:rows="setGateVisibleRows" />
        </template>

        <div class="gate-footer">
          <p class="hint">推荐：权限 / 租户 / 版本等「所有分支都需要」的条件放这里。<strong>分支只描述差异。</strong></p>
          <label class="status-select">
            准入失败码
            <select v-model.number="gateStatus">
              <option v-for="code in gateStatuses" :key="code" :value="code">{{ code }}</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped src="./section-card.css"></style>

<style scoped>
/* ---------- 请求准入 ---------- */
.gate-body {
  display: grid;
  gap: 10px;
  transition: opacity 0.15s;
}

.gate-body.off {
  opacity: 0.55;
}

.strategy-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.body-strategy {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-dim);
  font-size: 12px;
  white-space: nowrap;
}

.body-strategy select {
  width: 158px;
  padding: 6px 8px;
  font-family: var(--mono);
  font-size: 12px;
}

.gate-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
}

.gate-footer p {
  margin: 0;
  max-width: 60%;
}

.gate-footer strong {
  color: var(--text);
}

.status-select {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text-dim);
  font-size: 12px;
  white-space: nowrap;
}

.status-select select {
  width: 92px;
  padding: 6px 8px;
  font-family: var(--mono);
  font-size: 12px;
}

/* 非 subset 策略下的期望值编辑器（与分支的 body-raw-editor 同一样式） */
.body-raw-editor {
  width: 100%;
  min-height: 110px;
  padding: 9px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: #fff;
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  resize: vertical;
}

.body-raw-editor.invalid {
  border-color: var(--danger);
}
</style>
