/** Inline SVG icons drawn from simple shapes, built with DOM calls (no markup strings). */

const SVG_NS = 'http://www.w3.org/2000/svg';

type Shape = readonly [tag: string, attrs: Readonly<Record<string, string>>];

const ICONS = {
  menu: [['path', { d: 'M4 6h16M4 12h16M4 18h16' }]],
  close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  search: [['circle', { cx: '11', cy: '11', r: '6.5' }], ['path', { d: 'M16 16l4.5 4.5' }]],
  copy: [['rect', { x: '8', y: '8', width: '12', height: '12', rx: '2' }], ['path', { d: 'M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8' }]],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  download: [['path', { d: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14' }]],
  sun: [['circle', { cx: '12', cy: '12', r: '4' }], ['path', { d: 'M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8' }]],
  moon: [['path', { d: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z' }]],
  info: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M12 11v6M12 7.5v.5' }]],
  warning: [['path', { d: 'M12 3.5L2.5 20h19z' }], ['path', { d: 'M12 10v4.5M12 17.5v.5' }]],
  error: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M9 9l6 6M15 9l-6 6' }]],
  ok: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M8 12.5l2.8 2.8L16 10' }]],
  clock: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M12 7v5l3.5 2' }]],
  shield: [['path', { d: 'M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z' }]],
  arrowUp: [['path', { d: 'M12 19V5M6 11l6-6 6 6' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  split: [['path', { d: 'M4 6h16M4 12h7M13 12h7M4 18h4M10 18h4M16 18h4' }]],
  link: [['path', { d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' }]],
  external: [['path', { d: 'M14 4.5h5.5V10M19.5 4.5L11 13M17.5 14v4.5A1.5 1.5 0 0 1 16 20H5.5A1.5 1.5 0 0 1 4 18.5V8a1.5 1.5 0 0 1 1.5-1.5H10' }]],
  logo: [['path', { d: 'M4 17.5l4-4 3 3 5-6 4 4' }], ['circle', { cx: '4', cy: '17.5', r: '1.6' }], ['circle', { cx: '8', cy: '13.5', r: '1.6' }], ['circle', { cx: '11', cy: '16.5', r: '1.6' }], ['circle', { cx: '16', cy: '10.5', r: '1.6' }], ['circle', { cx: '20', cy: '14.5', r: '1.6' }]],
} satisfies Record<string, readonly Shape[]>;

export type IconName = keyof typeof ICONS;

/** The RadMage Labs mark, as on radmagelabs.com: a 16 by 16 pixel badge in its own colors. */
const LABS_MARK: readonly (readonly [fill: string, d: string])[] = [
  ['#33506B', 'M2 0h12v1h-12zM1 1h1v1h-1zM14 1h1v1h-1zM0 2h1v1h-1zM15 2h1v1h-1zM0 3h1v1h-1zM15 3h1v1h-1zM0 4h1v1h-1zM15 4h1v1h-1zM0 5h1v1h-1zM15 5h1v1h-1zM0 6h1v1h-1zM15 6h1v1h-1zM0 7h1v1h-1zM15 7h1v1h-1zM0 8h1v1h-1zM15 8h1v1h-1zM0 9h1v1h-1zM15 9h1v1h-1zM0 10h1v1h-1zM15 10h1v1h-1zM0 11h1v1h-1zM15 11h1v1h-1zM0 12h1v1h-1zM15 12h1v1h-1zM0 13h1v1h-1zM15 13h1v1h-1zM1 14h1v1h-1zM14 14h1v1h-1zM2 15h12v1h-12z'],
  ['#1B2636', 'M2 1h12v1h-12zM1 2h14v1h-14zM1 3h1v1h-1zM6 3h2v1h-2zM9 3h3v1h-3zM13 3h2v1h-2zM1 4h1v1h-1zM7 4h1v1h-1zM10 4h1v1h-1zM14 4h1v1h-1zM1 5h1v1h-1zM4 5h2v1h-2zM11 5h1v1h-1zM14 5h1v1h-1zM1 6h1v1h-1zM4 6h2v1h-2zM14 6h1v1h-1zM1 7h1v1h-1zM6 7h1v1h-1zM10 7h1v1h-1zM14 7h1v1h-1zM1 8h1v1h-1zM7 8h1v1h-1zM10 8h2v1h-2zM14 8h1v1h-1zM1 9h1v1h-1zM4 9h1v1h-1zM6 9h2v1h-2zM10 9h2v1h-2zM14 9h1v1h-1zM1 10h1v1h-1zM4 10h2v1h-2zM7 10h1v1h-1zM10 10h2v1h-2zM14 10h1v1h-1zM1 11h1v1h-1zM4 11h2v1h-2zM10 11h2v1h-2zM14 11h1v1h-1zM1 12h2v1h-2zM4 12h3v1h-3zM8 12h1v1h-1zM10 12h3v1h-3zM14 12h1v1h-1zM1 13h14v1h-14zM2 14h12v1h-12z'],
  ['#C4F1FA', 'M2 3h4v1h-4zM8 3h1v1h-1zM12 3h1v1h-1zM2 4h1v1h-1zM6 4h1v1h-1zM8 4h2v1h-2zM11 4h2v1h-2zM2 5h1v1h-1zM6 5h1v1h-1zM8 5h1v1h-1zM10 5h1v1h-1zM12 5h1v1h-1z'],
  ['#0B4A5B', 'M3 4h3v1h-3zM13 4h1v1h-1zM3 5h1v1h-1zM7 5h1v1h-1zM9 5h1v1h-1zM13 5h1v1h-1zM3 6h1v1h-1zM7 6h1v1h-1zM9 6h1v1h-1zM11 6h1v1h-1zM13 6h1v1h-1zM7 7h1v1h-1zM9 7h1v1h-1zM11 7h1v1h-1zM13 7h1v1h-1zM3 8h1v1h-1zM5 8h2v1h-2zM9 8h1v1h-1zM13 8h1v1h-1zM3 9h1v1h-1zM9 9h1v1h-1zM13 9h1v1h-1zM3 10h1v1h-1zM9 10h1v1h-1zM13 10h1v1h-1zM3 11h1v1h-1zM7 11h1v1h-1zM9 11h1v1h-1zM13 11h1v1h-1zM3 12h1v1h-1zM7 12h1v1h-1zM9 12h1v1h-1zM13 12h1v1h-1z'],
  ['#7DD3E8', 'M2 6h1v1h-1zM6 6h1v1h-1zM8 6h1v1h-1zM10 6h1v1h-1zM12 6h1v1h-1zM2 7h4v1h-4zM8 7h1v1h-1zM12 7h1v1h-1zM2 8h1v1h-1zM4 8h1v1h-1zM8 8h1v1h-1zM12 8h1v1h-1zM2 9h1v1h-1zM5 9h1v1h-1zM8 9h1v1h-1zM12 9h1v1h-1zM2 10h1v1h-1zM6 10h1v1h-1zM8 10h1v1h-1zM12 10h1v1h-1zM2 11h1v1h-1zM6 11h1v1h-1zM8 11h1v1h-1zM12 11h1v1h-1z'],
];

export function labsMark(className = 'labs-mark'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('shape-rendering', 'crispEdges');
  for (const [fill, d] of LABS_MARK) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', fill);
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

export function icon(name: IconName, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of ICONS[name]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.appendChild(shape);
  }
  return svg;
}
