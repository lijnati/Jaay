// Inline SVG icons, built with DOM calls (no innerHTML, CSP-safe). Decorative: aria-hidden, the text next to them carries the meaning.
const NS = "http://www.w3.org/2000/svg";
const STROKE: Record<string, string> = {
  sell: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  sales: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  wallet: "M3 7.5A2.5 2.5 0 0 1 5.5 5H18a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM3 8l13-4.5V5M16.5 13.5h.01",
  settings: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
  back: "M21 5H9l-6 7 6 7h12zM17.5 9.5l-5 5M12.5 9.5l5 5",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  check: "M5 12.5l4.5 4.5L19 7.5",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  x: "M7 7l10 10M17 7L7 17",
  alert: "M12 8.5v4.5M12 16.5h.01M10.3 4L2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z",
  shield: "M12 3l8 3v5.5c0 4.8-3.4 8.3-8 9.5-4.6-1.2-8-4.7-8-9.5V6zM8.8 12l2.2 2.2 4.3-4.4",
  flask: "M9 3h6M10 3v6.5l-5.2 8.7A1.9 1.9 0 0 0 6.4 21h11.2a1.9 1.9 0 0 0 1.6-2.8L14 9.5V3M7.5 15h9",
  refresh: "M20 11.5a8 8 0 1 0-2.3 5.6M20 4.5v7h-7",
  code: "M3 7h18v10H3zM7.5 12h.01M12 12h.01M16.5 12h.01",
  cloud: "M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8.5a4.8 4.8 0 0 1-1 9.5z",
};
const FILL: Record<string, string> = {
  plane: "M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
};
export type IconName = keyof typeof STROKE | keyof typeof FILL;

export function icon(name: IconName, cls = "ic"): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", cls);
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", STROKE[name] ?? FILL[name]!);
  if (FILL[name]) p.setAttribute("fill", "currentColor");
  else {
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
  }
  svg.append(p);
  return svg;
}

/** The jaay mark: a green tile, a white hook and the amber dot. */
export function mark(cls = "mark"): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 512 512");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", cls);
  const el = (tag: string, attrs: Record<string, string>) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.append(e);
  };
  el("rect", { width: "512", height: "512", rx: "120", class: "mark-tile" });
  el("circle", { cx: "316", cy: "140", r: "44", class: "mark-dot" });
  el("path", { d: "M316 250V350A50 50 0 0 1 266 400H196", fill: "none", "stroke-width": "64", "stroke-linecap": "round", class: "mark-hook" });
  return svg;
}
