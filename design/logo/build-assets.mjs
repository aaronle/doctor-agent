/**
 * 从唯一的标志定义生成 apps/web/public/ 下的全部图标与分享图。
 *
 * **不要手改 public/ 里的产物** —— 改 logo.mjs 然后重跑 `npm run logo`。
 * 手改的那一份下次重跑就没了，而且两处会悄悄不一致。
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLUE, TILE, FULL, GLYPH, svg } from './logo.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(join('/Users/leying/.nvm/versions/node/v24.11.1/lib/node_modules', 'playwright'));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'apps', 'web', 'public');
mkdirSync(OUT, { recursive: true });

// SVG favicon：现代浏览器优先用它，任何尺寸都清晰
writeFileSync(join(OUT, 'favicon.svg'), `${svg(TILE)}\n`);
writeFileSync(join(ROOT, 'design', 'logo', 'doctor-agent-logo.svg'), `${svg(TILE, 512)}\n`);

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

/** 把一段 HTML 里的 #shot 截成 PNG */
async function shot(html, path, w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<body style="margin:0">${html}</body>`);
  await page.locator('#shot').screenshot({ path: join(OUT, path) });
}

// ① 位图 favicon 与桌面图标
for (const [size, name] of [
  [32, 'favicon-32.png'],
  [16, 'favicon-16.png'],
  [180, 'apple-touch-icon.png'], // iOS「添加到主屏幕」
  [192, 'icon-192.png'],
  [512, 'icon-512.png'],
]) {
  await shot(`<div id="shot" style="width:${size}px;height:${size}px">${svg(TILE, size)}</div>`, name, size + 8, size + 8);
}

// ② 微信缩略图：**正方形**。
// 微信把分享卡片的图裁成方的，给 1200×630 会被拦腰切掉。
// 满幅不留白 —— 缩到 80px 时任何边距都是浪费。
await shot(`<div id="shot" style="width:600px;height:600px">${svg(FULL, 600)}</div>`, 'share-square.png', 620, 620);

// ③ 其他平台的横版大图（1.91:1）。微信用不上，但链接发到别处时是标准尺寸。
await shot(
  `<div id="shot" style="width:1200px;height:630px;background:#fff;display:flex;align-items:center;justify-content:center;gap:56px;font-family:-apple-system,'PingFang SC',sans-serif">
     <div style="width:220px;height:220px">${svg(TILE, 220)}</div>
     <div>
       <div style="font-size:60px;font-weight:700;color:#1f2329;letter-spacing:-0.5px">AI 门诊工作站</div>
       <div style="font-size:26px;color:#5b6470;margin-top:14px">Doctor Agent · 医生超级智能体</div>
       <div style="font-size:19px;color:#8a9099;margin-top:22px">语音问诊 · 病历生成 · 鉴别诊断 · 风险与共病管理</div>
       <div style="font-size:16px;color:#b0b5bd;margin-top:26px">演示环境，全部为虚构病例</div>
     </div>
   </div>`,
  'og-cover.png', 1220, 650,
);

await browser.close();
console.log('图标已生成到 apps/web/public/');
