#!/usr/bin/env node
/**
 * 线上冒烟：用真实浏览器把公网页面跑一遍，确认**画得出来**。
 *
 * 为什么部署脚本不够 —— 它查的是状态码。`200 但白屏`是完全可能的：
 * HTML 与 JS 都下发成功，Vue 在挂载时抛异常，页面一片空白，
 * 而所有健康检查都是绿的。这一类故障只有真开一个浏览器才看得见。
 *
 * 用法：node scripts/smoke-prod.mjs [https://da.aaronhealth.cn]
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const GLOBAL_MODULES = '/Users/leying/.nvm/versions/node/v24.11.1/lib/node_modules';
const { chromium } = require(join(GLOBAL_MODULES, 'playwright'));

const BASE = process.argv[2] || process.env.DA_PUBLIC || 'https://da.aaronhealth.cn';

/**
 * 每条断言都是「这一页的骨架在不在」，不是「内容对不对」。
 * 内容由门禁与单测守；这里只回答「线上这一页是不是白的」。
 */
const CHECKS = [
  { path: '/outpatient/list', must: ['.his-list-page', '.patient-card'], name: '候诊列表' },
  {
    path: '/outpatient/P002',
    must: ['.workstation-page', '.his-header', '.demo-badge', '.assistant-panel', '.assistant-toggle'],
    // AI 助手默认收起，抽屉这时**不该**在
    mustNot: ['.tips-drawer', '.workstation-body', '.his-orders-panel'],
    name: '门诊工作站',
  },
  { path: '/admin', must: ['.admin-page'], name: 'Agent 控制台' },
  { path: '/delivery', must: ['.delivery-page', '.lane-card'], name: '交付平台' },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

let bad = 0;
console.log(`线上冒烟 · ${BASE}\n`);

for (const check of CHECKS) {
  const before = consoleErrors.length;
  await page.goto(`${BASE}${check.path}`, { waitUntil: 'domcontentloaded' });

  // **每一个都要等，不能只等第一个。**
  //
  // 第一版只等 must[0]（页面骨架），其余立刻就查 —— 骨架是同步渲染的，
  // 而 .patient-card 之类要等接口回来。于是线上明明是好的，脚本却报
  // 「缺元素」。判据要落在每一个被检查的东西上，不是落在它的邻居上。
  const root = check.must[0];
  const mounted = await page
    .locator(root).first().waitFor({ state: 'attached', timeout: 30000 })
    .then(() => true).catch(() => false);

  const missing = [];
  if (mounted) {
    for (const sel of check.must.slice(1)) {
      const ok = await page.locator(sel).first()
        .waitFor({ state: 'attached', timeout: 30000 }).then(() => true).catch(() => false);
      if (!ok) missing.push(sel);
    }
  }
  // 「不该出现」的要在页面稳定之后再查，否则查得太早等于没查
  await page.waitForTimeout(1500);
  const leaked = [];
  for (const sel of check.mustNot || []) {
    if ((await page.locator(sel).count()) > 0) leaked.push(sel);
  }
  const errs = consoleErrors.slice(before);

  const ok = mounted && !missing.length && !leaked.length && !errs.length;
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${check.name.padEnd(14)} ${check.path}`);
  if (!mounted) console.log(`      整页没挂载：等不到 ${root}`);
  if (missing.length) console.log(`      缺元素：${missing.join(' ')}`);
  if (leaked.length) console.log(`      不该出现却出现了：${leaked.join(' ')}`);
  for (const e of errs.slice(0, 3)) console.log(`      控制台报错：${e.slice(0, 160)}`);
}

await browser.close();
console.log(`\n${bad ? `✗ ${bad} 页有问题` : '✓ 全部页面正常渲染'}`);
process.exit(bad ? 1 : 0);
