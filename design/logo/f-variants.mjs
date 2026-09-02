export const BLUE = '#1677ff';

/** 实心白气泡（A/C 用的那个结构，28px 下最扛得住） */
const bubbleSolid = `<path d="M22 11h20a11 11 0 0 1 11 11v13a11 11 0 0 1-11 11H31l-10 8v-8h-0a11 11 0 0 1-11-11V22a11 11 0 0 1 11-11z" fill="#fff"/>`;

export const FS = [
  {
    id: 'F1-气泡里的听诊器', name: 'F1 · 气泡里的听诊器',
    note: '沿用 A/C 的结构：实心白气泡 + 内部蓝色听诊器。最稳。',
    body: `<rect width="64" height="64" rx="14" fill="${BLUE}"/>${bubbleSolid}
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
    id: 'F2-气泡即听筒', name: 'F2 · 气泡就是听筒头',
    note: '气泡当听诊器的听筒，顶上伸出两根耳管。一个意思，不是两个拼一起。',
    body: `<rect width="64" height="64" rx="14" fill="${BLUE}"/>
      <g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round">
        <path d="M17 26c-3-8-2-13 1-15"/>
        <path d="M47 26c3-8 2-13-1-15"/>
      </g>
      <circle cx="17.4" cy="9.6" r="3.4" fill="#fff"/>
      <circle cx="46.6" cy="9.6" r="3.4" fill="#fff"/>
      <path d="M22 22h20a11 11 0 0 1 11 11v6a11 11 0 0 1-11 11H31l-10 7v-7h-0a11 11 0 0 1-11-11v-6a11 11 0 0 1 11-11z" fill="#fff"/>`,
  },
  {
    id: 'F3-管线绕成气泡', name: 'F3 · 管线绕成气泡',
    note: '原本的想法，这次把描边加粗、Y 形分叉画明确、听筒放大。',
    body: `<rect width="64" height="64" rx="14" fill="${BLUE}"/>
      <path d="M26 12h14a12 12 0 0 1 12 12v11a12 12 0 0 1-12 12h-9"
            fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/>
      <path d="M26 12a12 12 0 0 0-12 12v11a12 12 0 0 0 8 11.3"
            fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/>
      <path d="M31 47v2a7 7 0 0 1-7 7h-1" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
      <circle cx="18.5" cy="56" r="6" fill="#fff"/>`,
  },
];

export const svg = (m, size = 64) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">${m.body}</svg>`;
