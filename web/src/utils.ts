import type { CSSProperties } from 'vue';

export const METHOD_COLORS: Record<string, string> = {
  GET: '#0e9f5d',
  POST: '#1f6feb',
  PUT: '#b7791f',
  PATCH: '#8250df',
  DELETE: '#cf222e',
};

export function methodColor(method: string): string {
  return METHOD_COLORS[method] || '#5b6b7c';
}

/** 对应原 app.js 的 formatBody()：字符串原样展示，其余格式化缩进 */
export function formatBody(body: unknown): string {
  if (body === undefined) return '{}';
  if (typeof body === 'string') return body;
  return JSON.stringify(body, null, 2);
}

export interface CardStyle extends CSSProperties {
  '--method-color': string;
}

export function routeCardStyle(method: string, index: number): CardStyle {
  return {
    '--method-color': methodColor(method),
    animationDelay: `${Math.min(index * 40, 240)}ms`,
  };
}
