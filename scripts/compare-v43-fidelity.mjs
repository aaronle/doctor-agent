#!/usr/bin/env node
/**
 * 还原度比对：把 V4.3 原件与重建版在同一视口下跑起来，逐个元素比关键计算样式。
 *
 * 比对的是「同名 class 的第一个元素」的盒模型与排版属性。截图对屏靠肉眼，
 * 容易漏掉几像素的差异；这里用数值兜住，回归时能立刻发现走样。
 *
 * 用法：
 *   1. 先启动重建版：npm run dev
 *   2. node scripts/compare-v43-fidelity.mjs
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
const REF_PORT = 8899;
const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:4173';
const VIEWPORT = { width: 1600, height: 1000 };

// 决定视觉观感的属性。颜色与字号错一点就会整体走样，优先看这些。
//
// 刻意不比 width / height：两者都由内容长度决定。去掉「惠每」后标题变短、
// 真实模型产出的诊断描述比 fixture 长，都会让尺寸对不上，但那是内容差异
// 不是还原度差异。真正决定观感的是字号、字重、行高、配色与盒模型内距。
const PROPS = ['fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'padding', 'borderRadius'];

// 每个页面挑一组有代表性的 class 做比对
const PAGES = [
  {
    name: '候诊列表',
    hash: '#/outpatient/list',
    path: '/outpatient/list',
    selectors: ['.his-header', '.his-title', '.his-toolbar', '.patient-grid', '.patient-card', '.patient-avatar', '.patient-name', '.card-footer'],
  },
  {
    name: '门诊工作站',
    // 用 P006：只有带红色预警的患者才会渲染 risk-alert-section
    hash: '#/outpatient/P006',
    path: '/outpatient/P006',
    selectors: [
      '.workstation-page', '.his-header', '.basic-info-strip', '.workstation-body', '.his-record-panel',
      '.panel-title-bar', '.form-row', '.fl', '.tips-drawer', '.tips-tab-nav', '.ttab', '.assistant-panel',
      '.rc-label', '.skill-chip',
      // 鉴别诊断与风险提示：首轮重建做成了自拟结构，与原件差得最远的两块
      '.dd-card', '.dd-header', '.dd-title', '.dd-confirm-btn', '.dd-rec-item', '.dd-card-top',
      '.dd-primary-tag', '.dd-primary-name', '.dd-icd', '.dd-reason', '.dd-diff-label', '.dd-diff-count',
      '.risk-alert-section', '.ra-title', '.ra-card', '.ra-card-name', '.ra-card-suggestion', '.ra-view-btn',
    ],
  },
  // 八个 AI 标签页逐页比对。类名齐不等于样式对 —— 早先健康档案与病历质控
  // 就是「结构看着有、其实整块没做」，只有逐页取样才能发现。
  ...[
    ['智慧诊疗', ['.condition-overview-card', '.coc-title', '.dd-card', '.record-card', '.rc-label', '.ka-cat-name', '.ka-card', '.rc-vital', '.rc-vk']],
    ['预警评估', ['.risk-assess-block', '.risk-card', '.risk-card-header', '.risk-name', '.risk-summary']],
    ['病历管理', ['.record-layout', '.record-main', '.record-node', '.node-title', '.node-content', '.record-qc-side', '.rc-side-card', '.rc-side-head', '.rc-side-title', '.rc-risk-row', '.rc-risk-text', '.rc-qc-row', '.rc-qc-name', '.rc-qc-pill', '.rc-side-more']],
    ['诊断管理', ['.suspected-list', '.suspected-item', '.susp-name', '.susp-conf', '.susp-icd', '.susp-desc', '.primary-mark-btn', '.diag-selection-actions']],
    ['医嘱管理', ['.treat-panel', '.treat-section-title', '.treat-card', '.treat-drug', '.treat-spec', '.treat-basis', '.exam-rec-order', '.ero-name']],
    ['共病管理', ['.comorbidity-overview', '.comorbidity-condition-card', '.condition-name', '.condition-analysis', '.condition-dept', '.comorbidity-actions-bar']],
    ['健康档案', ['.archive-panel', '.archive-overview', '.ao-title', '.ao-k', '.ao-v', '.archive-toolbar', '.archive-muted', '.af-chip', '.visit-list', '.visit-card', '.vc-type', '.vc-time', '.vc-dept', '.vc-meta', '.vc-cc']],
    ['时间轴', ['.timeline-list', '.timeline-group', '.tl-time-tag', '.tl-group-card', '.tl-group-action', '.tl-sub-label', '.tl-sub-action', '.tl-sub-detail', '.tl-cat-tag', '.timeline-actions']],
  ].map(([tab, selectors]) => ({
    name: `标签页 · ${tab}`,
    hash: '#/outpatient/P001',
    path: '/outpatient/P001',
    prepare: async (page) => {
      await page.locator('.ttab').filter({ hasText: tab }).first().click();
      await page.waitForTimeout(700);
      // 专项评估与就诊卡默认折叠，展开第一个才能取到内部元素
      for (const sel of ['.ka-cat-header', '.visit-card']) {
        const el = page.locator(sel).first();
        if (await el.isVisible().catch(() => false)) {
          await el.click();
          await page.waitForTimeout(400);
        }
      }
    },
    selectors,
  })),

  {
    name: '语音问诊播放中',
    hash: '#/outpatient/P006',
    path: '/outpatient/P006',
    // 点「语音问诊」后 2.5 秒内采集：对话脚本约 7 秒播完就转 ended，浮层随之消失
    // V4.3 的问诊数据是本地的，点完即播；重建版要先等 voiceInit 的真实模型
    // 调用返回，所以等浮层出现而不是死等固定时长。
    prepare: async (page) => {
      await page.locator('.action-bar button', { hasText: '语音问诊' }).first().click();
      await page.locator('.pending-float').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
      await page.locator('.msg-bubble').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(800);
    },
    selectors: [
      '.pending-float', '.pending-title', '.pending-list', '.pq-item', '.pq-num', '.pq-text',
      '.msg-bubble', '.bubble-role', '.bubble-content', '.mode-badge',
    ],
  },
];

function readStyles(selectors, props) {
  const out = {};
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) {
      out[selector] = null;
      continue;
    }
    const cs = getComputedStyle(el);
    out[selector] = Object.fromEntries(props.map((p) => [p, cs[p]]));
  }
  return out;
}

const html = await readFile(SOURCE);
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((resolve) => server.listen(REF_PORT, '127.0.0.1', resolve));

const browser = await chromium.launch();

async function collect(page, selectors) {
  return page.evaluate(([s, p]) => {
    const out = {};
    for (const selector of s) {
      const el = document.querySelector(selector);
      if (!el) { out[selector] = null; continue; }
      const cs = getComputedStyle(el);
      out[selector] = Object.fromEntries(p.map((k) => [k, cs[k]]));
    }
    return out;
  }, [selectors, PROPS]);
}

const refPage = await browser.newPage({ viewport: VIEWPORT });
await refPage.goto(`http://127.0.0.1:${REF_PORT}/#/login`, { waitUntil: 'networkidle' });
await refPage.getByRole('button', { name: '进入门诊工作站' }).click();
await refPage.waitForTimeout(1500);

const appPage = await browser.newPage({ viewport: VIEWPORT });
await appPage.goto(`${APP_URL}/login`, { waitUntil: 'networkidle' });
await appPage.getByRole('button', { name: '进入门诊工作站' }).click();
await appPage.waitForTimeout(1500);

let total = 0;
let diffs = 0;
let missing = 0;

for (const target of PAGES) {
  await refPage.evaluate((h) => { location.hash = h.slice(1); }, target.hash);
  await refPage.waitForTimeout(1800);
  await appPage.goto(`${APP_URL}${target.path}`, { waitUntil: 'networkidle' });
  // 工作站首屏要等四个岗位跑完，给足时间
  await appPage.waitForTimeout(target.path.includes('/outpatient/P') ? 25000 : 2000);

  // 两边各自「准备完立刻采集」，不能先准备两边再一起采：
  // 原件的问诊浮层约 7 秒后随播放结束消失，而重建版要等真实模型返回，
  // 等回来时原件那边早没了，会误报成「原件中不存在」。
  let ref;
  let app;
  if (target.prepare) {
    await target.prepare(refPage);
    ref = await collect(refPage, target.selectors);
    await target.prepare(appPage);
    app = await collect(appPage, target.selectors);
  } else {
    [ref, app] = await Promise.all([collect(refPage, target.selectors), collect(appPage, target.selectors)]);
  }

  console.log(`\n■ ${target.name}`);
  for (const selector of target.selectors) {
    if (!ref[selector]) { console.log(`  ? ${selector.padEnd(22)} 原件中不存在，跳过`); continue; }
    if (!app[selector]) { console.log(`  ✗ ${selector.padEnd(22)} 重建版缺失该元素`); missing += 1; continue; }

    const bad = PROPS.filter((p) => ref[selector][p] !== app[selector][p]);
    total += 1;
    if (!bad.length) {
      console.log(`  ✓ ${selector.padEnd(22)} 一致`);
    } else {
      diffs += 1;
      console.log(`  △ ${selector.padEnd(22)} ${bad.length} 项不同`);
      for (const p of bad) console.log(`      ${p}: 原件 ${ref[selector][p]}  →  重建 ${app[selector][p]}`);
    }
  }
}

console.log(`\n合计比对 ${total} 个元素：一致 ${total - diffs}，有差异 ${diffs}，缺失 ${missing}`);

await browser.close();
server.close();
