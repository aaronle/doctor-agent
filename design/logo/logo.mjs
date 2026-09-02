/**
 * Doctor Agent 标志 —— 唯一定义源。
 *
 * 方案 F1「气泡里的听诊器」精修版：对话气泡 = 这个产品「落地即对话」的前提，
 * 听诊器 = 临床。两件事合成一个形，且不用那个满大街的医疗十字。
 *
 * 结构上是**实心白气泡 + 内部蓝色图形** —— 这是 A/C/F1 里唯一在 20px 下
 * 还立得住的构造。描边式的（F3）小尺寸会发虚，负形式的（D 白大褂）会糊成一坨。
 */
export const BLUE = '#1677ff';

/** 纯图形，不含底板。用于需要自己控制背景的场合。 */
export const GLYPH = `
  <path d="M21 9h22a12 12 0 0 1 12 12v14a12 12 0 0 1-12 12H32l-11 8v-8a12 12 0 0 1-12-12V21A12 12 0 0 1 21 9z" fill="#fff"/>
  <g fill="none" stroke="${BLUE}" stroke-width="4" stroke-linecap="round">
    <path d="M22.5 16.5c0 6.5 1.2 8.8 7.5 9.4"/>
    <path d="M39 16.5c0 5.4-1.2 7.8-7 9.4"/>
    <path d="M30 25.9c1.2 7.6 3 10 8.2 10.3"/>
  </g>
  <circle cx="42.6" cy="36.4" r="4.8" fill="${BLUE}"/>
  <circle cx="22.5" cy="15.4" r="2.5" fill="${BLUE}"/>
  <circle cx="39" cy="15.4" r="2.5" fill="${BLUE}"/>`;

/** 圆角方板版。favicon、桌面图标、微信缩略图都用它。 */
export const TILE = `<rect width="64" height="64" rx="14" fill="${BLUE}"/>${GLYPH}`;

/** 满幅版（无圆角）。做分享大图时由外层控制形状，不要双重圆角。 */
export const FULL = `<rect width="64" height="64" fill="${BLUE}"/>${GLYPH}`;

export const svg = (body, size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"${size ? ` width="${size}" height="${size}"` : ''}>${body}</svg>`;
