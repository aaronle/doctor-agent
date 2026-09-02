/** 用 Playwright 把六个候选渲染成 PNG：单图 + 一张对照大图。 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

// playwright 装在全局，不在 workspace 里 —— 与 scripts/compare-v43-fidelity.mjs 同一条解析方式
const require = createRequire(import.meta.url);
const GLOBAL_MODULES = '/Users/leying/.nvm/versions/node/v24.11.1/lib/node_modules';
const { chromium } = require(join(GLOBAL_MODULES, 'playwright'));
import { writeFileSync, mkdirSync } from 'node:fs';
import { MARKS, svg } from './marks.mjs';

mkdirSync('png', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });

// ① 每个候选单独一张 512
for (const m of MARKS) {
  writeFileSync(`${m.id}.svg`, `${svg(m)}\n`);
  await page.setContent(
    `<body style="margin:0"><div style="width:256px;height:256px">${svg(m).replace('width="64" height="64"', 'width="256" height="256"')}</div></body>`,
  );
  await page.locator('div').first().screenshot({ path: `png/${m.id}.png`, omitBackground: true });
}

// ② 对照大图：六个 × 三个尺寸 × 两种底色。真正要看的就是这张。
const sizes = [88, 48, 28];
const row = (m) => `
  <tr>
    <td class="n"><b>${m.name}</b></td>
    ${['#ffffff', '#ededed'].map((bg) => `
      <td class="cell" style="background:${bg}">
        ${sizes.map((s) => `<span class="u">${svg(m).replace('width="64" height="64"', `width="${s}" height="${s}"`)}<i>${s}</i></span>`).join('')}
      </td>`).join('')}
  </tr>`;

await page.setContent(`
<body style="margin:0;background:#fff;font-family:-apple-system,'PingFang SC',sans-serif">
<div id="sheet" style="padding:28px 32px;width:900px">
  <div style="font-size:19px;font-weight:700;color:#1f2329">Doctor Agent · AI 门诊工作站 —— 标志候选</div>
  <div style="font-size:12px;color:#8a9099;margin:6px 0 18px">左：白底（浏览器标签、收藏夹）　右：#ededed（微信会话列表底色）　数字是像素</div>
  <table style="border-collapse:collapse;width:100%">
    <tr><th></th><th style="font-size:11px;color:#8a9099;font-weight:500;padding-bottom:6px">白底</th><th style="font-size:11px;color:#8a9099;font-weight:500;padding-bottom:6px">微信灰底</th></tr>
    ${MARKS.map(row).join('')}
  </table>
</div>
<style>
  td.n { width:190px; font-size:13px; color:#1f2329; padding:14px 12px 14px 0; vertical-align:middle; border-top:1px solid #eef0f2 }
  td.cell { padding:14px 18px; border-top:1px solid #eef0f2; border-radius:0 }
  span.u { display:inline-flex; flex-direction:column; align-items:center; margin-right:20px; vertical-align:middle }
  span.u i { font-style:normal; font-size:9px; color:#b0b5bd; margin-top:5px }
</style>
</body>`);
await page.locator('#sheet').screenshot({ path: 'png/全部候选对照.png' });

await browser.close();
console.log('导出完成：png/');
