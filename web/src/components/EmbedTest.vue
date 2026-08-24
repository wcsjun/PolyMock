<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { NotifyFn } from '../types';

const props = defineProps<{
  active: boolean;
  notify: NotifyFn;
}>();

const EMBED_MIN_W = 320;
const EMBED_MIN_H = 240;

const urlInput = ref('');
const loaded = ref(false);
const noteVisible = ref(false);
const boxVisible = ref(false);
const resizing = ref(false);
const frameSrc = ref('about:blank');
const sizeText = ref('— × —');

const stageEl = ref<HTMLElement | null>(null);
const boxEl = ref<HTMLElement | null>(null);

let currentEmbedUrl = '';

function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`;
}

function updateSizeLabel() {
  const el = boxEl.value;
  if (el) sizeText.value = `${el.offsetWidth} × ${el.offsetHeight}`;
}

function embedMaxSize() {
  const stage = stageEl.value;
  if (!stage) return { maxW: EMBED_MIN_W, maxH: EMBED_MIN_H };
  const pad = getComputedStyle(stage);
  const padX = parseFloat(pad.paddingLeft) + parseFloat(pad.paddingRight);
  const padY = parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom);
  return {
    maxW: Math.max(EMBED_MIN_W, stage.clientWidth - padX),
    maxH: Math.max(EMBED_MIN_H, stage.clientHeight - padY),
  };
}

function clampEmbedSize() {
  const el = boxEl.value;
  if (!el) return;
  const { maxW, maxH } = embedMaxSize();
  const w = Math.min(Math.max(el.offsetWidth, EMBED_MIN_W), maxW);
  const h = Math.min(Math.max(el.offsetHeight, EMBED_MIN_H), maxH);
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
}

function load() {
  const url = normalizeUrl(urlInput.value);
  if (!url) {
    props.notify('请输入要嵌入的页面地址', 'err');
    return;
  }
  currentEmbedUrl = url;
  frameSrc.value = url;
  loaded.value = true;
  noteVisible.value = true;
  void nextTick(() => {
    clampEmbedSize();
    updateSizeLabel();
  });
}

function openExternal() {
  if (currentEmbedUrl) window.open(currentEmbedUrl, '_blank', 'noopener');
}

function fillStage() {
  const el = boxEl.value;
  if (!el) return;
  const { maxW, maxH } = embedMaxSize();
  el.style.width = `${maxW}px`;
  el.style.height = `${maxH}px`;
  updateSizeLabel();
}

function close() {
  frameSrc.value = 'about:blank';
  currentEmbedUrl = '';
  loaded.value = false;
  noteVisible.value = false;
}

/* ---------- 拖拽调整宽高（右／下／右下角） ---------- */

type ResizeDir = 'e' | 's' | 'se';

function onResizePointerdown(event: PointerEvent, dir: ResizeDir) {
  event.preventDefault();
  const handle = event.currentTarget as HTMLElement;
  const box = boxEl.value;
  if (!box) return;

  const startX = event.clientX;
  const startY = event.clientY;
  const startW = box.offsetWidth;
  const startH = box.offsetHeight;
  const { maxW, maxH } = embedMaxSize();

  handle.setPointerCapture(event.pointerId);
  resizing.value = true;

  const onMove = (ev: PointerEvent) => {
    if (dir.includes('e')) {
      const w = Math.min(Math.max(startW + ev.clientX - startX, EMBED_MIN_W), maxW);
      box.style.width = `${w}px`;
    }
    if (dir.includes('s')) {
      const h = Math.min(Math.max(startH + ev.clientY - startY, EMBED_MIN_H), maxH);
      box.style.height = `${h}px`;
    }
    updateSizeLabel();
  };
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    resizing.value = false;
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

/* 切回嵌入视图 / 窗口尺寸变化时重新约束尺寸并刷新标签 */
watch(
  () => props.active,
  (active) => {
    if (active && boxVisible.value) {
      clampEmbedSize();
      updateSizeLabel();
    }
  },
);

function onWindowResize() {
  if (boxVisible.value && props.active) {
    clampEmbedSize();
    updateSizeLabel();
  }
}

onMounted(() => window.addEventListener('resize', onWindowResize));
onBeforeUnmount(() => window.removeEventListener('resize', onWindowResize));
</script>

<template>
  <section id="view-embed" class="view" :hidden="!active">
    <div class="embed-layout">
      <form class="embed-bar panel" autocomplete="off" @submit.prevent="load">
        <input
          v-model="urlInput"
          name="url"
          type="text"
          placeholder="输入要嵌入的页面地址，如 http://localhost:3000/api/hello"
          spellcheck="false"
        >
        <button type="submit" class="embed-load">加载</button>
        <button v-show="loaded" type="button" class="embed-open" title="在新标签页打开" @click="openExternal">↗</button>
      </form>
      <p v-show="noteVisible" class="embed-note">若下方区域空白，说明目标站点可能通过 X-Frame-Options / CSP 禁止被嵌入，可点击 ↗ 在新标签页验证。</p>

      <div ref="stageEl" class="embed-stage">
        <div v-show="!boxVisible" class="embed-empty">
          <div class="empty-glyph">⛶</div>
          <p class="empty-title">输入地址并加载，把任意网页嵌入此处测试</p>
          <p class="empty-desc">容器的宽高可通过拖拽右／下／右下角边缘自由调整</p>
        </div>

        <div v-show="boxVisible" ref="boxEl" class="embed-frame" :class="{ resizing }">
          <div class="embed-frame-head">
            <span class="embed-size">{{ sizeText }}</span>
            <span class="embed-hint">拖拽右／下／右下角调整宽高</span>
            <button type="button" class="embed-fill" title="铺满画布区域" @click="fillStage">铺满</button>
            <button type="button" class="embed-close" title="关闭" @click="close">×</button>
          </div>
          <iframe :src="frameSrc" title="嵌入式页面容器"></iframe>
          <div
            class="rz rz-e"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整宽度"
            @pointerdown="onResizePointerdown($event, 'e')"
          ></div>
          <div
            class="rz rz-s"
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整高度"
            @pointerdown="onResizePointerdown($event, 's')"
          ></div>
          <div
            class="rz rz-se"
            role="separator"
            aria-label="调整宽高"
            @pointerdown="onResizePointerdown($event, 'se')"
          ></div>
        </div>
      </div>
    </div>
  </section>
</template>
