import qrcode from "qrcode-generator";
import { draw, type Ecc, type QrInfo } from "./qr-common";

export function renderQr(canvas: HTMLCanvasElement, text: string, ecc: Ecc = "M"): QrInfo {
  const q = qrcode(0, ecc);
  q.addData(text, "Alphanumeric"); // explicit: the uppercase LIGHTNING: string is all alphanumeric
  q.make();
  const n = q.getModuleCount();
  const px = draw(canvas, n, (r, c) => q.isDark(r, c));
  return { lib: "qrcode-generator", version: (n - 17) / 4, modules: n, mode: "Alphanumeric", ecc, pxPerModule: px };
}
