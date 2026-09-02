/** 六个候选标志的唯一定义源。改这里，导出脚本跟着变。 */
export const BLUE = '#1677ff';
export const NAVY = '#0b4f9e';

const tile = (fill) => `<rect width="64" height="64" rx="14" fill="${fill}"/>`;
const bubble = (fill) =>
  `<path d="M21 13h22a9 9 0 0 1 9 9v14a9 9 0 0 1-9 9H30l-9 8v-8h0a9 9 0 0 1-9-9V22a9 9 0 0 1 9-9z" fill="${fill}"/>`;

export const MARKS = [
  {
    id: 'A-气泡十字', name: 'A · 气泡里的十字', bg: BLUE,
    body: `${tile(BLUE)}${bubble('#fff')}
      <rect x="28.6" y="19.5" width="6.8" height="19" rx="2" fill="${BLUE}"/>
      <rect x="22.5" y="25.6" width="19" height="6.8" rx="2" fill="${BLUE}"/>`,
  },
  {
    id: 'B-十字心电', name: 'B · 十字 + 心电波', bg: BLUE,
    body: `${tile(BLUE)}
      <rect x="27.5" y="12" width="9" height="40" rx="3" fill="#fff"/>
      <path d="M11 32h11l4-7 5 14 4-7h18" fill="none" stroke="#fff" stroke-width="8.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    id: 'C-气泡心电', name: 'C · 气泡里的心电波', bg: BLUE,
    body: `${tile(BLUE)}${bubble('#fff')}
      <path d="M19 29h6l3.5-6 4.5 12 3.5-6H45" fill="none" stroke="${BLUE}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    id: 'D-白大褂', name: 'D · 白大褂领口', bg: NAVY,
    body: `<defs><clipPath id="c"><rect width="64" height="64" rx="14"/></clipPath></defs>
      <g clip-path="url(#c)"><rect width="64" height="64" fill="${NAVY}"/>
      <path d="M6 64V37c0-7 4-12 11-14l9-3 6 15 6-15 9 3c7 2 11 7 11 14v27z" fill="#fff"/>
      <circle cx="32" cy="30" r="4.6" fill="${NAVY}"/></g>`,
  },
  {
    id: 'E-医字', name: 'E · 「医」字几何化', bg: '#ffffff',
    body: `<rect width="64" height="64" rx="14" fill="#fff" stroke="#dfe4ea"/>
      <rect x="13" y="13" width="9" height="38" rx="3" fill="${BLUE}"/>
      <rect x="13" y="13" width="33" height="9" rx="3" fill="${BLUE}"/>
      <rect x="13" y="42" width="33" height="9" rx="3" fill="${BLUE}"/>
      <path d="M27 32h4.5l3-6.5 4.5 13 3-6.5H52" fill="none" stroke="${BLUE}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    id: 'F-听诊器气泡', name: 'F · 听诊器围成的对话气泡', bg: BLUE,
    body: `${tile(BLUE)}
      <path d="M25 45h-1a10 10 0 0 1-10-10V25a10 10 0 0 1 10-10h16a10 10 0 0 1 10 10v10a10 10 0 0 1-10 10h-6" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
      <path d="M28 45v3a6 6 0 0 1-6 6" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
      <circle cx="17" cy="54" r="5.5" fill="#fff"/>`,
  },
];

export const svg = (m) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">${m.body}</svg>`;
