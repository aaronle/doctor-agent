import { createRequire } from 'node:module';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { FS, svg } from './f-variants.mjs';

const require = createRequire(import.meta.url);
const GLOBAL_MODULES = '/Users/leying/.nvm/versions/node/v24.11.1/lib/node_modules';
const { chromium } = require(join(GLOBAL_MODULES, 'playwright'));

mkdirSync('png', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });

for (const m of FS) {
  writeFileSync(`${m.id}.svg`, `${svg(m)}\n`);
  await page.setContent(`<body style="margin:0"><div style="width:256px;height:256px">${svg(m, 256)}</div></body>`);
  await page.locator('div').first().screenshot({ path: `png/${m.id}.png`, omitBackground: true });
}

const sizes = [88, 48, 28];
await page.setContent(`
<body style="margin:0;background:#fff;font-family:-apple-system,'PingFang SC',sans-serif">
<div id="s" style="padding:28px 32px;width:900px">
  <div style="font-size:19px;font-weight:700;color:#1f2329">F · 听诊器气泡 —— 三种执行</div>
  <div style="font-size:12px;color:#8a9099;margin:6px 0 18px">概念已定，比的是哪一种画法真能读出听诊器</div>
  <table style="border-collapse:collapse;width:100%">
    <tr><th></th><th style="font-size:11px;color:#8a9099;font-weight:500">白底</th><th style="font-size:11px;color:#8a9099;font-weight:500">微信灰底</th></tr>
    ${FS.map((m) => `<tr>
      <td class="n"><b>${m.name}</b><div class="d">${m.note}</div></td>
      ${['#ffffff', '#ededed'].map((bg) => `<td class="c" style="background:${bg}">
        ${sizes.map((s) => `<span class="u">${svg(m, s)}<i>${s}</i></span>`).join('')}
      </td>`).join('')}
    </tr>`).join('')}
  </table>
</div>
<style>
  td.n { width:210px; font-size:13px; color:#1f2329; padding:16px 12px 16px 0; vertical-align:middle; border-top:1px solid #eef0f2 }
  td.n .d { font-size:11px; color:#8a9099; margin-top:4px; line-height:1.6; font-weight:400 }
  td.c { padding:16px 18px; border-top:1px solid #eef0f2 }
  span.u { display:inline-flex; flex-direction:column; align-items:center; margin-right:20px; vertical-align:middle }
  span.u i { font-style:normal; font-size:9px; color:#b0b5bd; margin-top:5px }
</style>
</body>`);
await page.locator('#s').screenshot({ path: 'png/F-三种执行对照.png' });
await browser.close();
console.log('ok');
