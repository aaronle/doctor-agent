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
const PROPS = ['width', 'height', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'padding', 'borderRadius'];

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
    hash: '#/outpatient/P001',
    path: '/outpatient/P001',
    selectors: ['.workstation-page', '.his-header', '.basic-info-strip', '.workstation-body', '.his-record-panel', '.panel-title-bar', '.form-row', '.fl', '.tips-drawer', '.tips-tab-nav', '.ttab', '.assistant-panel', '.rc-label', '.skill-chip'],
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
  await appPage.waitForTimeout(target.path.includes('P001') ? 25000 : 2000);

  const [ref, app] = await Promise.all([collect(refPage, target.selectors), collect(appPage, target.selectors)]);

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
