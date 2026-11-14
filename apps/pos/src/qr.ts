// QR rendering, from spike S3: qrcode-generator, error correction M (5 px modules at 300 px for a 211-char
// LNURL), explicit alphanumeric mode for the uppercase LIGHTNING: string, 4-module quiet zone, whole pixels.
import qrcode from "qrcode-generator";

export function renderQr(canvas: HTMLCanvasElement, text: string, size = 300): void {
  const q = qrcode(0, "M");
  q.addData(text, "Alphanumeric");
  q.make();
  const n = q.getModuleCount();
  const px = Math.max(1, Math.floor(size / (n + 8)));
  canvas.width = size;
  canvas.height = size;
  const off = Math.floor((size - px * n) / 2);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect(off + c * px, off + r * px, px, px);
}
