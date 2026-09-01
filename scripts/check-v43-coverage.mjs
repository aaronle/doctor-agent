#!/usr/bin/env node
/**
 * 类名覆盖率检查：原件每个标签页渲染出的应用自有类名，重建版是不是也渲染了。
 *
 * 为什么需要它 —— compare-v43-fidelity.mjs 只比**我手写的选择器清单**里的元素。
 * 清单里漏写一个，那个元素就完全不在门禁视野内。预警评估的 `.risk-dot`
 * （风险等级色点）和 `.risk-actions`（大模型解读 / ↗ 两个按钮）就是这么漏掉的：
 * 界面上少了一整块，126→144 个元素的比对却一路全绿。
 *
 * 这个脚本不需要人工枚举：直接取两边渲染出的 class 集合做差集。
 * 它回答的是「有没有整块漏做」，还原度比对回答的是「做了的长得对不对」，
 * 两者互补，缺一不可。
 *
 * 用法：
 *   1. 先启动重建版：npm run dev
 *   2. node scripts/check-v43-coverage.mjs
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const GLOBAL_MODULES = '/Users/leying/.nvm/versions/node/v24.11.1/lib/node_modules';
const { chromium } = require(join(GLOBAL_MODULES, 'playwright'));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'references/ui-demo/AI-HIS门诊模块V4.3.html');
const REF_PORT = 8901;
const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:4173';
const VIEWPORT = { width: 1600, height: 1000 };

const TABS = ['智慧诊疗', '预警评估', '病历管理', '诊断管理', '医嘱管理', '共病管理', '健康档案', '时间轴'];

/**
 * 已知的合理差异，逐条写明理由。
 *
 * 白名单必须**逐条给理由**，否则它会变成「把报错静音」的地方 ——
 * 那样这个脚本就白写了。
 */
const ALLOWED_MISSING = {
  // V4.3 用 el-tooltip 包住部分元素；我们用原生 title，不产生这些容器类
  '*': [/^el-/, /^is-/],
};

function isAllowed(cls) {
  return (ALLOWED_MISSING['*'] || []).some((re) => re.test(cls));
}

/** 取出当前可见面板里所有应用自有类名 */
function collectClasses(root) {
  const scope = document.querySelector(root) || document.body;
  const out = new Set();
  for (const el of scope.querySelectorAll('*')) {
    const raw = typeof el.className === 'string' ? el.className.trim() : '';
    for (const c of raw.split(/\s+/)) {
      if (c && !c.startsWith('el-') && !c.startsWith('is-')) out.add(c);
    }
  }
  return [...out];
}

async function login(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  const btn = page.getByRole('button', { name: '进入门诊工作站' });
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(1200);
  }
}

/** 确保 AI 浮层开着 —— 关掉的话一个标签页都点不到 */
async function ensureFloat(page) {
  const round = page.locator('.ai-float-btn').first();
  if (await round.isVisible().catch(() => false)) {
    await round.click();
    await page.waitForTimeout(400);
  }
}

/**
 * 专项评估卡的说明行（.ka-card-detail-row 等）只在**展开态**才渲染。
 *
 * 两边的默认态是不同的：原件默认展开前两条，重建版一律折叠（产品决策，
 * 见 assessment_catalog.json 的 note）。不先统一成展开，重建版就会被报
 * 「缺 3 个类」——那是默认态差异，不是漏做。
 *
 * 「确保展开」而不是「点一下」：盲点会把原件那张已展开的收起来，
 * 于是反过来变成原件缺类。
 */
async function ensureFirstAssessmentCardOpen(page) {
  const card = page.locator('.ka-card').first();
  if (!(await card.isVisible().catch(() => false))) return;
  const collapsed = await card.evaluate((el) => el.classList.contains('collapsed')).catch(() => false);
  if (collapsed) {
    await card.click().catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function classesPerTab(page, gotoPatient) {
  const result = {};
  await gotoPatient();
  await ensureFloat(page);
  for (const tab of TABS) {
    await page.locator('.ttab').filter({ hasText: tab }).first().click().catch(() => {});
    await page.waitForTimeout(700);
    if (tab === '智慧诊疗') await ensureFirstAssessmentCardOpen(page);
    result[tab] = await page.evaluate(collectClasses, '.tips-tab-pane:not([style*="display: none"])');
  }
  return result;
}

const html = await readFile(SOURCE);
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((resolve) => server.listen(REF_PORT, '127.0.0.1', resolve));

const browser = await chromium.launch();
const refPage = await browser.newPage({ viewport: VIEWPORT });
const appPage = await browser.newPage({ viewport: VIEWPORT });

await login(refPage, `http://127.0.0.1:${REF_PORT}/#/login`);
await login(appPage, `${APP_URL}/login`);

const refClasses = await classesPerTab(refPage, async () => {
  await refPage.evaluate(() => { location.hash = '/outpatient/P001'; });
  await refPage.waitForTimeout(1800);
});
// 重建版首屏要等真实模型返回，给足时间
const appClasses = await classesPerTab(appPage, async () => {
  await appPage.goto(`${APP_URL}/outpatient/P001`, { waitUntil: 'networkidle' });
  await appPage.waitForTimeout(20000);
});

let missingTotal = 0;
for (const tab of TABS) {
  const ref = new Set(refClasses[tab] || []);
  const app = new Set(appClasses[tab] || []);
  const missing = [...ref].filter((c) => !app.has(c) && !isAllowed(c)).sort();
  const extra = [...app].filter((c) => !ref.has(c) && !isAllowed(c)).sort();

  console.log(`\n■ ${tab}   原件 ${ref.size} 类 / 重建 ${app.size} 类`);
  if (missing.length) {
    missingTotal += missing.length;
    console.log(`  ✗ 重建版缺 ${missing.length} 个：${missing.join(' ')}`);
  } else {
    console.log('  ✓ 原件的类名全部覆盖');
  }
  // 多出来的通常是【增强】，只提示不判失败
  if (extra.length) console.log(`  ＋ 重建版新增 ${extra.length} 个（增强）：${extra.slice(0, 12).join(' ')}${extra.length > 12 ? ' …' : ''}`);
}

console.log(`\n合计缺失 ${missingTotal} 个类名`);
await browser.close();
server.close();
process.exit(missingTotal ? 1 : 0);
