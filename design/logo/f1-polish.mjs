export const BLUE = '#1677ff';

/** F1 原版 */
const bubbleA = `<path d="M22 11h20a11 11 0 0 1 11 11v13a11 11 0 0 1-11 11H31l-10 8v-8h-0a11 11 0 0 1-11-11V22a11 11 0 0 1 11-11z" fill="#fff"/>`;

/**
 * 精修版。四处调整，都是为了小尺寸：
 *  1. 气泡放大、内边距收紧 —— 让听诊器占更多面积
 *  2. 听诊器线加粗 3.4 → 4.0，耳塞与听筒同步放大
 *  3. 气泡尾巴由细长尖角改成短粗的斜角 —— 尖角在 28px 下会被抗锯齿吃掉，看着像毛刺
 *  4. 听筒下移并右移，与耳塞拉开距离，避免三个圆点在小尺寸下糊成一团
 */
const bubbleB = `<path d="M21 9h22a12 12 0 0 1 12 12v14a12 12 0 0 1-12 12H32l-11 8v-8a12 12 0 0 1-12-12V21A12 12 0 0 1 21 9z" fill="#fff"/>`;

export const VARIANTS = [
  {
    id: 'F1-原版', name: 'F1 原版',
    body: `<rect width="64" height="64" rx="14" fill="${BLUE}"/>${bubbleA}
      <g fill="none" stroke="${BLUE}" stroke-width="3.4" stroke-linecap="round">
        <path d="M23 17.5c0 5.5 1 7.5 6.5 8"/>
        <path d="M37.5 17.5c0 4.5-1 6.5-6 8"/>
        <path d="M29.5 25.5c1 6.5 2.5 8.5 7 8.8"/>
      </g>
      <circle cx="40.4" cy="34.4" r="4.1" fill="${BLUE}"/>
      <circle cx="23" cy="16.6" r="2.1" fill="${BLUE}"/>
      <circle cx="37.5" cy="16.6" r="2.1" fill="${BLUE}"/>`,
  },
  {
    id: 'F1-精修', name: 'F1 精修',
    body: `<rect width="64" height="64" rx="14" fill="${BLUE}"/>${bubbleB}
      <g fill="none" stroke="${BLUE}" stroke-width="4" stroke-linecap="round">
        <path d="M22.5 16.5c0 6.5 1.2 8.8 7.5 9.4"/>
        <path d="M39 16.5c0 5.4-1.2 7.8-7 9.4"/>
        <path d="M30 25.9c1.2 7.6 3 10 8.2 10.3"/>
      </g>
      <circle cx="42.6" cy="36.4" r="4.8" fill="${BLUE}"/>
      <circle cx="22.5" cy="15.4" r="2.5" fill="${BLUE}"/>
      <circle cx="39" cy="15.4" r="2.5" fill="${BLUE}"/>`,
  },
];

export const svg = (m, size = 64) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">${m.body}</svg>`;
