/**
 * 演示前走查：用真实浏览器把**演示主线**跑一遍。
 *
 * `npm run smoke` 只回答「页面白不白」；这个脚本回答「演示讲的那个故事还成不成立」：
 *
 *   未解锁进入 → 只有医生智能体 → 八页标 🔒 并给说明卡 →
 *   硬规则红线不被锁（危急值不能等）→ 结束问诊 → AI 助手自动展开 → 八页出内容
 *
 * 每一条都是**产品叙事**，不是技术指标。它们坏掉时页面照样是「正常」的，
 * 冒烟测试一个都发现不了。
 *
 * 用法：
 *   node scripts/demo-reset.mjs --apply   # 先重置到初始态
 *   node scripts/demo-check.mjs           # 再走查（会消耗掉一位患者的初始态）
 *   node scripts/demo-reset.mjs --apply   # 走查完再重置一次
 *
 * 走查用 P006，把 P001 留给真正的演示。
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(join('/Users/leying/.nvm/versions/node/v24.11.1/lib/node_modules','playwright'));
const B='https://da.aaronhealth.cn', PID='P006';
let bad=0; const fail=m=>{bad++;console.log(`   ✗ ${m}`)}; const ok=m=>console.log(`   ✓ ${m}`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport:{width:1600,height:1000} });
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
page.on('console',m=>{if(m.type()==='error')errs.push(m.text())});

console.log(`■ 演示主线（${PID}，未解锁态进入）`);
await page.goto(`${B}/outpatient/${PID}`, { waitUntil:'domcontentloaded' });
await page.locator('.workstation-page').waitFor({ timeout:30000 });
await page.waitForTimeout(3000);
ok('工作站已打开');

// ① 一进来：只有医生智能体，AI 助手收起
(await page.locator('.assistant-panel').count()) ? ok('医生智能体面板在') : fail('缺面板');
(await page.locator('.tips-drawer').count())===0 ? ok('AI 助手默认收起 ✔核心叙事') : fail('AI 助手不该已展开');
const handle = page.locator('.assistant-handle');
(await handle.count()) ? ok('抽屉把手在（左边线中间）') : fail('缺把手');

// ② 手工展开：八页应显示「问诊后解锁」的说明，而不是结论
await handle.click(); await page.waitForTimeout(1500);
// 门禁态下**整页让位给说明卡**（.gate-card），`.tips-tab-pane` 自然是 0 个 ——
// 上一版查 pane 拿到空串，报「未问诊却直接给了内容」，方向完全反了。
// 规格原话：「锁着的部分留在原位并说明原因，不是让它消失 ——
// 消失会让医生以为系统没这功能」。所以判据是**说明卡在不在**。
const gate = await page.locator('.gate-card').first().innerText().catch(()=>'');
/问诊|锚定|解锁/.test(gate) ? ok(`门禁说明卡在位：「${gate.slice(0,36).replace(/\n/g,' ')}…」`)
                            : fail(`未问诊时是空白页，没有说明卡：「${gate.slice(0,60)}」`);
const locks = await page.locator('.tips-tab-nav [class*="lock"], .ttab:has-text("🔒")').count();
locks >= 3 ? ok(`四页标了 🔒（${locks} 处），另四页可点`) : fail(`锁标记只有 ${locks} 处`);
const skip = await page.locator('button, a').filter({ hasText:/跳过问诊/ }).count();
skip ? ok('「跳过问诊，直接分析」出路在 ✔（复诊/患者不配合时不能没路走）') : fail('缺跳过入口');
// 硬规则红线**不该**被锁（危急值不能等）
await page.locator('.ttab').filter({hasText:'预警评估'}).first().click().catch(()=>{});
await page.waitForTimeout(1200);
const warnTxt = await page.locator('.tips-tab-pane:not([style*="display: none"])').innerText().catch(()=>'');
/异常|风险|未采集|心电图/.test(warnTxt) ? ok('硬规则红线未被门禁锁住 ✔（危急值不能等）')
                                        : fail(`预警页也被锁了：「${warnTxt.slice(0,60)}」`);
await handle.click(); await page.waitForTimeout(500);   // 收回去，模拟医生开始问诊

// ③ 结束问诊 → AI 助手自动展开
const stop = page.locator('button', { hasText:'结束问诊' }).first();
const hasStop = await stop.count();
if (!hasStop) {
  const start = page.locator('button', { hasText:/语音问诊|开始问诊|问诊/ }).first();
  (await start.count()) ? (await start.click(), await page.waitForTimeout(2500), ok('已点开始问诊'))
                        : fail('找不到问诊按钮');
}
const stop2 = page.locator('button', { hasText:'结束问诊' }).first();
if (await stop2.count()) {
  await stop2.click();
  ok('已点「结束问诊」');
  const auto = await page.locator('.tips-drawer').waitFor({state:'visible',timeout:180000}).then(()=>true).catch(()=>false);
  auto ? ok('AI 助手**自动展开** ✔核心叙事') : fail('结束问诊后没自动展开');
  const att = await page.locator('.assistant-handle.attention').count();
  att ? ok('把手闪蓝提示（自动展开）') : console.log('   · 把手闪蓝已回落（2 秒动画，正常）');
  await page.waitForFunction(()=>![...document.querySelectorAll('.el-loading-mask')]
      .some(m=>m.offsetParent!==null), null, {timeout:200000}).catch(()=>{});
  const after = await page.locator('.tips-tab-pane:not([style*="display: none"])').innerText().catch(()=>'');
  after.length>200 ? ok(`八页已解锁并出内容（${after.length} 字）`) : fail(`解锁后内容太少：${after.length} 字`);
} else fail('没有「结束问诊」按钮');

console.log(`\n控制台错误 ${errs.length} 条`);
errs.slice(0,5).forEach(e=>console.log(`   ! ${e.slice(0,140)}`));
await browser.close();
console.log(`\n${bad?`✗ ${bad} 项失败`:'✓ 演示主线全通'}`);
