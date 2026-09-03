/**
 * 演示前全量走查：候诊列表 → 工作站 → 八页 → 病历 → 控制台 → 移动端。
 *
 * 与 `demo-check.mjs` 分工：那个测**未解锁的主线叙事**（门禁、自动展开），
 * 这个测**解锁后每一页有没有内容**。两个都跑才算覆盖住演示会点到的地方。
 *
 * 用 P005 并自己造解锁前提 —— 把 P001 留给真正的演示。
 *
 * 用法：node scripts/demo-walk.mjs（跑完记得 npm run demo:reset -- --apply）
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(join('/Users/leying/.nvm/versions/node/v24.11.1/lib/node_modules','playwright'));
const B = 'https://da.aaronhealth.cn';
let bad = 0;
const fail = (m) => { bad++; console.log(`   ✗ ${m}`); };
const ok = (m) => console.log(`   ✓ ${m}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

console.log('■ 1 候诊列表');
await page.goto(`${B}/outpatient/list`, { waitUntil: 'domcontentloaded' });
await page.locator('.patient-card').first().waitFor({ timeout: 30000 });
const cards = await page.locator('.patient-card').count();
cards >= 5 ? ok(`${cards} 张患者卡片`) : fail(`只有 ${cards} 张卡片`);
// 过敏标记
const red = await page.locator('.patient-name .allergy-badge.danger').count();
const warn = await page.locator('.patient-name .allergy-badge.warn').count();
red === 1 ? ok(`红色过敏标记 ${red} 个（P002 青霉素）`) : fail(`红标 ${red} 个，应为 1`);
warn === 2 ? ok(`黄色未采集标记 ${warn} 个`) : fail(`黄标 ${warn} 个，应为 2`);
// 出生年月
const meta = await page.locator('.patient-meta').first().innerText();
/\d{4}-\d{2}/.test(meta) ? ok(`患者副行含出生年月：${meta}`) : fail(`副行没有出生年月：${meta}`);

console.log('\n■ 2 进入工作站 P005（先解锁 —— 这一段测的是「解锁后各页有内容」）');
// **前提要自己造。** 上一版直接点第一张卡，而 demo-reset 之后患者都是未解锁态，
// 八页全是门禁说明卡 —— 报出来是 11 项失败，看着像界面崩了，实际是前提没满足。
await page.request.post(`${B}/api/emr/analysis/unlock`, { data:{ patient_id:'P005', reason:'skipped' } });
await page.goto(`${B}/outpatient/P005`, { waitUntil:'domcontentloaded' });
await page.locator('.workstation-page').waitFor({ timeout: 30000 });
ok('工作站已打开');
// 面板要等数据回来才挂载 —— 必须 waitFor 而不是立刻 count()。
// 上一版直接 count()，报「缺抽屉把手」，而下一步又成功点到了它：
// 那是我查得太早，不是产品缺东西。**自相矛盾的失败要先怀疑仪器。**
for (const [sel, name] of [['.assistant-panel','医生智能体面板'],['.assistant-handle','抽屉把手'],['.demo-badge','演示环境角标']]) {
  const seen = await page.locator(sel).first().waitFor({ state:'attached', timeout: 30000 }).then(()=>true).catch(()=>false);
  seen ? ok(name) : fail(`缺 ${name}`);
}
// AI 助手默认收起
(await page.locator('.tips-drawer').count()) === 0 ? ok('AI 助手默认收起') : fail('AI 助手不该默认展开');
// 患者信息行
const line = await page.locator('.patient-tab-meta').first().innerText().catch(() => '');
/\d{4}-\d{2}/.test(line) && line.includes('P00') ? ok(`患者行：${line}`) : fail(`患者行不对：${line}`);
(await page.locator('.mode-badge.voice').count()) === 0 ? ok('红色「语」标记已移除') : fail('「语」标记还在');

console.log('\n■ 3 点抽屉把手展开 AI 助手');
await page.locator('.assistant-handle').click();
const opened = await page.locator('.tips-drawer').waitFor({ state:'visible', timeout: 10000 }).then(()=>true).catch(()=>false);
opened ? ok('抽屉已展开') : fail('点把手没展开');
(await page.locator('.assistant-handle.expanded').count()) ? ok('把手切到展开态') : fail('把手状态没变');

console.log('\n■ 4 八个标签页');
const tabs = ['智慧诊疗','预警评估','病历管理','诊断管理','医嘱管理','共病管理','健康档案','时间轴'];
for (const t of tabs) {
  await page.locator('.ttab').filter({ hasText: t }).first().click().catch(()=>{});
  await page.waitForTimeout(600);
  await page.waitForFunction(() => ![...document.querySelectorAll('.el-loading-mask')]
      .some(m => m.offsetParent !== null), null, { timeout: 150000 }).catch(()=>{});
  const pane = page.locator('.tips-tab-pane:not([style*="display: none"])');
  const txt = (await pane.innerText().catch(()=>'')).trim();
  txt.length > 30 ? ok(`${t}（${txt.length} 字）`) : fail(`${t} 内容过少：「${txt.slice(0,50)}」`);
}

console.log('\n■ 5 病历七段');
await page.locator('.ttab').filter({ hasText:'病历管理' }).first().click();
await page.waitForTimeout(1200);
const recTxt = await page.locator('.tips-tab-pane:not([style*="display: none"])').innerText().catch(()=>'');
for (const s of ['主诉','现病史','既往史','个人史','体格检查','辅助检查','初步诊断']) {
  recTxt.includes(s) ? ok(`病历含「${s}」`) : fail(`病历缺「${s}」`);
}

console.log('\n■ 6 控制台 / 交付平台');
for (const [u, sel, n] of [['/admin','.admin-page','Agent 控制台'],['/delivery','.delivery-page','交付平台'],['/outpatient/manage','.pm-page','患者管理']]) {
  await page.goto(B+u, { waitUntil:'domcontentloaded' });
  const found = await page.locator(sel).first().waitFor({ timeout: 20000 }).then(()=>true).catch(()=>false);
  found ? ok(n) : fail(`${n} 没渲染`);
}

console.log('\n■ 7 移动端 (375×812)');
await page.setViewportSize({ width:375, height:812 });
await page.goto(`${B}/outpatient/list`, { waitUntil:'domcontentloaded' });
await page.waitForTimeout(2500);
const mob = await page.locator('.m-list-page, .mobile-outpatient, [class*="mobile"], [class*="m-"]').count();
mob ? ok(`移动端候诊列表渲染（${mob} 个移动端元素）`) : fail('移动端没渲染');
await page.goto(`${B}/outpatient/P001`, { waitUntil:'domcontentloaded' });
await page.waitForTimeout(3000);
const mw = await page.locator('[class*="m-"], [class*="mobile"]').count();
mw ? ok('移动端工作站渲染') : fail('移动端工作站没渲染');

console.log(`\n控制台错误 ${errs.length} 条`);
errs.slice(0,6).forEach(e => console.log(`   ! ${e.slice(0,140)}`));
await browser.close();
console.log(`\n${bad ? `✗ ${bad} 项失败` : '✓ 全部通过'}`);
process.exit(bad ? 1 : 0);
