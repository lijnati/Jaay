import QRCode from "qrcode";
import { draw, type Ecc, type QrInfo } from "./qr-common";

export function renderQr(canvas: HTMLCanvasElement, text: string, ecc: Ecc = "M"): QrInfo {
  const q = QRCode.create(text, { errorCorrectionLevel: ecc });
  const n = q.modules.size;
  const px = draw(canvas, n, (r, c) => Boolean(q.modules.get(r, c)));
  const mode = q.segments.map((s) => (s.mode as unknown as { id: string }).id).join("+");
  return { lib: "qrcode", version: q.version, modules: n, mode, ecc, pxPerModule: px };
}
