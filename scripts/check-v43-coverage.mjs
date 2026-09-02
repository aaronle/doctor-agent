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

/**
 * 进到候诊列表。
 *
 * 原件要先过登录页；重建版已于 2026-09-01 移除登录（一期无 SSO），直接就是列表。
 * 所以这里按「有登录按钮就点，没有就算了」处理，两边共用一个入口函数。
 */
async function enter(page, url) {
  // 不用 networkidle：解锁过的就诊进场即拉分析，Sonnet 5 下网络一分钟不会闲下来。
  // 判据换成「要用的元素在场了」。
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const btn = page.getByRole('button', { name: '进入门诊工作站' });
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(1200);
  }
}

/**
 * 把这一位患者的这场就诊推进到「问诊已完成」。
 *
 * 改成问诊状态机之后，智慧诊疗 / 病历管理 / 诊断管理 / 共病管理四页在问诊前是
 * 锁着的（整页让位给说明卡）——不先解锁，这四页一个元素都取不到，
 * 比出来会是「重建版缺一大片」，而那是状态差异不是漏做。
 *
 * 走 voice/complete 而不是 analysis/unlock：前者会落一份真实 VoiceSession，
 * 上下文里就有对话，产出的内容量与原件可比；后者是「跳过」，没有对话，
 * 分析会明显更薄，比的就不是同一个东西了。
 */
async function ensureAnalysisUnlocked(page, apiBase, patientId) {
  await page.evaluate(async ({ base, pid }) => {
    const state = await fetch(`${base}/api/emr/visit-state/${pid}`).then((r) => r.json()).catch(() => null);
    if (state?.analysis_unlocked) return;
    await fetch(`${base}/api/emr/voice/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patient_id: pid,
        conversation_summary: '门禁脚本：以种子对话推进到问诊完成态',
        messages: [
          { role: 'doctor', text: '最近情况怎么样？' },
          { role: 'patient', text: '和上次差不多，没有明显好转。' },
        ],
      }),
    });
  }, { base: apiBase, pid: patientId });
}

/**
 * 等加载遮罩散掉再动手。
 *
 * 这里比还原度脚本更要紧：下面几处 click 都带着 `.catch(() => {})`，
 * 遮罩挡住时点击会**静悄悄地没发生** —— 卡片没展开，于是报「重建版缺 3 个类」。
 * 那是个假失败，而且长得和真失败一模一样，上一轮已经因为它误判过一次。
 *
 * 150 秒：智慧诊疗聚合在 Sonnet 5 下要跑一分钟以上（Haiku 时代约 20 秒）。
 */
async function settle(page, timeout = 150000) {
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('.el-loading-mask')].some(
        (m) => m.offsetParent !== null && getComputedStyle(m).display !== 'none',
      ),
    null,
    { timeout },
  );
}

/** 确保 AI 浮层开着 —— 关掉的话一个标签页都点不到 */
async function ensureFloat(page) {
  await settle(page);
  const round = page.locator('.ai-float-btn').first();
  if (await round.isVisible().catch(() => false)) {
    await round.click();
    await page.waitForTimeout(400);
  }
  // AI 助手 2026-09-02 起**默认收起**（问诊前不该先把结论摆出来）。
  // 采类名之前必须先展开，否则整个抽屉都不在 DOM 里，
  // 八页会被报成「重建版全缺」—— 那是默认态差异，不是漏做。
  const toggle = page.locator('.assistant-toggle').first();
  if (!(await page.locator('.tips-drawer').first().isVisible().catch(() => false))
      && await toggle.isVisible().catch(() => false)) {
    await toggle.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  await page.locator('.tips-drawer').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
}

/**
 * 把「专项评估小助手」摊到与原件同一个展开层次再采类名。
 *
 * 这一块有**两层**折叠，两边的默认态都不一样：
 *
 * | | 分类（.ka-list） | 单条说明（.ka-card-detail-row） |
 * | --- | --- | --- |
 * | V4.3 原件 | 默认展开 | 默认展开前两条 |
 * | 重建版 | 默认折叠（2026-09-02 产品决策） | 默认折叠 |
 *
 * 不先统一，重建版会被报「缺一批类」—— 那是默认态差异，不是漏做。
 *
 * **必须先开分类，再开卡片。** 早先只有开卡片那一步，它一上来
 * `.ka-card` 不可见就直接 return —— 分类一折叠，整段静悄悄地被跳过，
 * 报出来是「重建版缺 N 个类」，和真的漏做长得一模一样。
 *
 * 一律「确保展开」而不是「点一下」：盲点会把原件那份已展开的收起来，
 * 于是反过来变成原件缺类。
 */
async function ensureAssessmentVisible(page) {
  // ① **每一个分类都要开，不能只开第一个。**
  //
  // 卡片配色是按分类分布的：danger/warning 在「诊疗质控助手」，
  // success 在「患者服务助手」「临床教学助手」，info 在「临床科研助手」。
  // 只开第一个，`ka-card-info` 与 `ka-card-success` 就永远采不到 ——
  // 实测就是这两个被报成「重建版缺 2 个类」。原件五个分类全开着，
  // 要比就得比同一个状态。
  // 这里只在「智慧诊疗」页调用，所以分类一定可见；但短超时照样给上 ——
  // 标签页之间是 v-show，元素在别处也存在，点不动时不该等满 30 秒默认超时。
  const categories = page.locator('.ka-category');
  const catCount = await categories.count().catch(() => 0);
  for (let i = 0; i < catCount; i += 1) {
    const cat = categories.nth(i);
    if (await cat.locator('.ka-list').isVisible().catch(() => false)) continue;
    await cat.locator('.ka-cat-header').click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(120);
  }

  // ② 分类里的第一张卡（说明行只在展开态渲染）
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
    await settle(page);
    if (tab === '智慧诊疗') await ensureAssessmentVisible(page);
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

await enter(refPage, `http://127.0.0.1:${REF_PORT}/#/login`);
await enter(appPage, `${APP_URL}/outpatient/list`);
// 受门禁的四页要先解锁，否则会被报「缺一大片」——那是状态差异不是漏做
await ensureAnalysisUnlocked(appPage, APP_URL, 'P001');

const refClasses = await classesPerTab(refPage, async () => {
  await refPage.evaluate(() => { location.hash = '/outpatient/P001'; });
  await refPage.waitForTimeout(1800);
});
// 重建版首屏要等真实模型返回，给足时间
const appClasses = await classesPerTab(appPage, async () => {
  await appPage.goto(`${APP_URL}/outpatient/P001`, { waitUntil: 'domcontentloaded' });
  await appPage.locator('.workstation-page').first().waitFor({ state: 'visible', timeout: 30000 });
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
