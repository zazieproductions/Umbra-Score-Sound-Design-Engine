export function tc(seconds: number, frames = false, fps = 24): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const base = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  if (!frames) return base;
  const f = Math.floor((s % 1) * fps);
  return `${base}:${String(f).padStart(2, '0')}`;
}

export function db(gain: number): string {
  if (gain <= 0.0001) return '-\u221e';
  const v = 20 * Math.log10(gain);
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}

export function bytes(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n > 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}
