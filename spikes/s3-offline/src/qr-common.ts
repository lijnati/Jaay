export type Ecc = "L" | "M" | "Q" | "H";
export interface QrInfo { lib: string; version: number; modules: number; mode: string; ecc: Ecc; pxPerModule: number }

// Draws whole pixels per module with a 4-module quiet zone, centered on the canvas.
export function draw(canvas: HTMLCanvasElement, n: number, dark: (r: number, c: number) => boolean): number {
  const ctx = canvas.getContext("2d")!;
  const px = Math.floor(canvas.width / (n + 8));
  const off = Math.floor((canvas.width - px * n) / 2);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) ctx.fillRect(off + c * px, off + r * px, px, px);
  return px;
}
