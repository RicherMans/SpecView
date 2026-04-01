export function fmt(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sc = s % 60;
  return m + ':' + (sc < 10 ? '0' : '') + sc.toFixed(3);
}

export function fmtShort(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sc = s % 60;
  return m > 0 ? m + ':' + (sc < 10 ? '0' : '') + sc.toFixed(1) : sc.toFixed(1) + 's';
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
