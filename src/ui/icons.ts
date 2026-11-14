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
  logo: [['path', { d: 'M4 17.5l4-4 3 3 5-6 4 4' }], ['circle', { cx: '4', cy: '17.5', r: '1.6' }], ['circle', { cx: '8', cy: '13.5', r: '1.6' }], ['circle', { cx: '11', cy: '16.5', r: '1.6' }], ['circle', { cx: '16', cy: '10.5', r: '1.6' }], ['circle', { cx: '20', cy: '14.5', r: '1.6' }]],
} satisfies Record<string, readonly Shape[]>;

export type IconName = keyof typeof ICONS;

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
