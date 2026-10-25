import { ref, type Ref } from 'vue';
import { clampDrawerWidth, clearDrawerWidth, loadDrawerWidth, saveDrawerWidth } from '../utils';

/**
 * 抽屉宽度拖拽（左缘手柄，localStorage 记忆，双击恢复默认，←/→ 键 ±16px 微调）。
 * 宽度存取复用 utils 的既有实现（与接口管理抽屉同一记忆键）：从一个抽屉拖宽后，
 * 其他抽屉打开即同宽（对齐「单抽屉」心智）。
 */
export function useDrawerResize(panelRef: Ref<HTMLElement | null>, rzRef: Ref<HTMLElement | null>) {
  const width = ref<number | null>(loadDrawerWidth(window.innerWidth));

  function apply() {
    if (panelRef.value) {
      panelRef.value.style.width = width.value === null ? '' : `${width.value}px`;
    }
  }

  function reset() {
    width.value = null;
    clearDrawerWidth();
    apply();
  }

  function onDown(event: PointerEvent) {
    event.preventDefault();
    const handle = rzRef.value;
    const panel = panelRef.value;
    if (!handle || !panel) return;
    const startX = event.clientX;
    const startW = width.value ?? panel.offsetWidth;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('active');
    document.body.classList.add('drawer-resizing');
    const onMove = (ev: PointerEvent) => {
      width.value = clampDrawerWidth(startW + (startX - ev.clientX), window.innerWidth);
      apply();
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      handle.classList.remove('active');
      document.body.classList.remove('drawer-resizing');
      if (width.value !== null) saveDrawerWidth(width.value);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const base = width.value ?? panelRef.value?.offsetWidth ?? 0;
    if (!base) return;
    width.value = clampDrawerWidth(base + (event.key === 'ArrowLeft' ? -16 : 16), window.innerWidth);
    apply();
    if (width.value !== null) saveDrawerWidth(width.value);
  }

  return { width, reset, onDown, onKeydown, apply };
}
