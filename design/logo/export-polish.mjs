import { createRequire } from 'node:module';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { VARIANTS, svg } from './f1-polish.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(join('/Users/leying/.nvm/versions/node/v24.11.1/lib/node_modules', 'playwright'));

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
for (const m of VARIANTS) writeFileSync(`${m.id}.svg`, `${svg(m)}\n`);

const sizes = [112, 64, 40, 28, 20];
await page.setContent(`
<body style="margin:0;background:#fff;font-family:-apple-system,'PingFang SC',sans-serif">
<div id="s" style="padding:28px 32px;width:940px">
  <div style="font-size:19px;font-weight:700;color:#1f2329">F1 · 气泡里的听诊器 —— 精修前后</div>
  <div style="font-size:12px;color:#8a9099;margin:6px 0 18px">20px 是浏览器标签页的实际大小，28px 是微信会话列表</div>
  <table style="border-collapse:collapse;width:100%">
    <tr><th></th><th style="font-size:11px;color:#8a9099;font-weight:500">白底</th><th style="font-size:11px;color:#8a9099;font-weight:500">微信灰底</th></tr>
    ${VARIANTS.map((m) => `<tr>
      <td class="n"><b>${m.name}</b></td>
      ${['#ffffff', '#ededed'].map((bg) => `<td class="c" style="background:${bg}">
        ${sizes.map((s) => `<span class="u">${svg(m, s)}<i>${s}</i></span>`).join('')}
      </td>`).join('')}
    </tr>`).join('')}
  </table>
</div>
<style>
  td.n { width:120px; font-size:13px; color:#1f2329; padding:18px 12px 18px 0; vertical-align:middle; border-top:1px solid #eef0f2 }
  td.c { padding:18px 16px; border-top:1px solid #eef0f2 }
  span.u { display:inline-flex; flex-direction:column; align-items:center; margin-right:16px; vertical-align:middle }
  span.u i { font-style:normal; font-size:9px; color:#b0b5bd; margin-top:5px }
</style>
</body>`);
await page.locator('#s').screenshot({ path: 'png/F1-精修对照.png' });
await browser.close();
console.log('ok');
