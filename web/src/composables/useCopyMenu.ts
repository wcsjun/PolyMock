import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * 复制菜单的开关行为（RouteCard / WsRouteCard 共用）：
 * 开关状态 + 点击菜单外部关闭 + Escape 关闭，document 级监听随组件挂卸。
 * wrapRef 绑定到菜单容器元素，作为「外点关闭」的判定依据。
 */
export function useCopyMenu() {
  const open = ref(false);
  const wrapRef = ref<HTMLElement | null>(null);

  function toggle() {
    open.value = !open.value;
  }

  function onDocPointerDown(event: MouseEvent) {
    if (open.value && !wrapRef.value?.contains(event.target as Node)) {
      open.value = false;
    }
  }

  function onDocKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') open.value = false;
  }

  onMounted(() => {
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onDocKeydown);
  });

  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onDocPointerDown);
    document.removeEventListener('keydown', onDocKeydown);
  });

  return { open, wrapRef, toggle };
}
