import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";

const jobs = [
  ["icon.svg", "icon-192.png", 192],
  ["icon.svg", "icon-512.png", 512],
  ["icon-maskable.svg", "icon-maskable-512.png", 512],
];
for (const [src, out, w] of jobs) {
  const svg = readFileSync(new URL(`../public/${src}`, import.meta.url), "utf8");
  const png = new Resvg(svg, { fitTo: { mode: "width", value: w }, background: "#000000" }).render().asPng();
  writeFileSync(new URL(`../public/${out}`, import.meta.url), png);
  console.log(out, png.length);
}
