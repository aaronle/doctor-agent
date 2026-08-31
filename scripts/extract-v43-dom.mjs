#!/usr/bin/env node
/**
 * 从 AI-HIS门诊模块V4.3.html 抽取真实渲染 DOM、结构骨架与截图。
 *
 * 与 extract-v43-assets.mjs 的分工：
 *   - extract-v43-assets.mjs 做静态抽取（CSS、设计令牌、fixture），不跑浏览器。
 *   - 本脚本做动态抽取（渲染后的 DOM、各交互状态、截图），需要 Playwright。
 *
 * 产物统一落在 references/ui-demo/extracted/dom/，是前端复刻的结构事实源。
 * 与 CSS 抽取一样：可随时重跑复现，不手工编辑产物。
 *
 * 用法：
 *   node scripts/extract-v43-dom.mjs
 */

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const GLOBAL_MODULES = '/Users/leying/.nvm/versions/node/v24.11.1/lib/node_modules';
const { chromium } = require(join(GLOBAL_MODULES, 'playwright'));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'references/ui-demo/AI-HIS门诊模块V4.3.html');
const OUT_DIR = join(ROOT, 'references/ui-demo/extracted/dom');
const PORT = 8899;
const VIEWPORT = { width: 1600, height: 1000 };

/**
 * 点击文本包含 text 的元素，找不到就报错，避免静默抓到错误状态。
 * 用子串而非全等：部分标签带角标子元素（如「共病管理」后挂 .ttab-dot），全等匹配会落空。
 * 八个标签名互不包含，子串足够唯一。
 */
async function clickExact(page, selector, text) {
  const target = page.locator(selector).filter({ hasText: text }).first();
  await target.waitFor({ state: 'visible', timeout: 8000 });
  await target.click();
  await page.waitForTimeout(700);
}

/** 关闭 AI 助手抽屉与医生智能体面板，露出被浮层遮挡的 HIS 医嘱区。 */
async function closeAiFloat(page) {
  for (const sel of ['.tips-close', '.panel-close']) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(400);
    }
  }
}

/** AI 助手的八个标签页 */
const AI_TABS = ['智慧诊疗', '预警评估', '病历管理', '诊断管理', '医嘱管理', '共病管理', '健康档案', '时间轴'];

/** 需要抓取的界面状态。steps 在采集前把界面点到目标状态。 */
const TARGETS = [
  { key: '01-login', hash: '#/login' },
  { key: '02-outpatient-list', hash: '#/outpatient/list' },
  { key: '03-patient-manage', hash: '#/outpatient/manage' },
  { key: '04-workstation-P001', hash: '#/outpatient/P001' },
  { key: '05-workstation-P002', hash: '#/outpatient/P002' },
  { key: '06-workstation-P006', hash: '#/outpatient/P006' },

  // AI 助手八个标签页（统一在 P001 上采集，保证可横向比对）
  // 八个面板全部常驻 DOM、靠 display 切换，因此把作用域限定到当前可见的那一个
  ...AI_TABS.map((tab, i) => ({
    key: `10-aitab-${String(i + 1).padStart(2, '0')}-${tab}`,
    hash: '#/outpatient/P001',
    root: '.tips-tab-pane:not([style*="display: none"])',
    steps: async (page) => clickExact(page, '.ttab', tab),
  })),

  // AI 浮层全部关闭后的纯 HIS 界面
  { key: '19-his-only', hash: '#/outpatient/P001', steps: closeAiFloat },

  // 医嘱面板三个子页（AI 浮层盖住医嘱区，必须先关掉）
  ...['药品', '检查', '检验'].map((tab, i) => ({
    key: `20-orders-${String(i + 1).padStart(2, '0')}-${tab}`,
    hash: '#/outpatient/P001',
    steps: async (page) => {
      await closeAiFloat(page);
      await clickExact(page, '.ostab', tab);
    },
  })),

  // 专项评估五个分类全部展开
  {
    key: '30-key-assessment-expanded',
    hash: '#/outpatient/P001',
    steps: async (page) => {
      const headers = page.locator('.ka-cat-header');
      for (let i = 0; i < (await headers.count()); i += 1) {
        await headers.nth(i).click();
        await page.waitForTimeout(250);
      }
    },
  },

  // 左侧患者栏展开态
  {
    key: '31-sidebar-expanded',
    hash: '#/outpatient/P001',
    steps: async (page) => page.locator('.sidebar-toggle').first().click(),
  },

  // 语音问诊进行中。V4.3 会自动播放 dialog_script，播放过程中浮出
  // 「AI 追问提示」并累积「补充观察」。这一组状态此前完全没有采集到 ——
  // 脚本从没启动过问诊，导致重建时整块功能缺失。
  {
    key: '40-voice-playing',
    hash: '#/outpatient/P006',
    steps: async (page) => {
      await page.locator('.action-bar button', { hasText: '语音问诊' }).first().click();
      // 只等 2.5 秒：对话脚本约 7 秒播完就转 ended，追问提示浮层随之消失。
      // 等太久会采到播放结束后的空状态 —— 这正是首轮抽取漏掉整块功能的原因。
      await page.waitForTimeout(2500);
    },
  },
  {
    key: '41-voice-observations',
    hash: '#/outpatient/P006',
    steps: async (page) => {
      await page.locator('.action-bar button', { hasText: '语音问诊' }).first().click();
      await page.waitForTimeout(2500);
      const toggle = page.locator('.obs-toggle-btn').first();
      if (await toggle.isVisible().catch(() => false)) await toggle.click();
      await page.waitForTimeout(800);
    },
  },

  // 鉴别诊断的「需鉴别（N）」展开态
  {
    key: '42-differential-expanded',
    hash: '#/outpatient/P006',
    steps: async (page) => {
      await page.locator('.dd-diff-toggle').first().click();
      await page.waitForTimeout(600);
    },
  },

  // 阳性结果展开态：点某一条，列表让位给该条详情
  {
    key: '44-result-detail',
    hash: '#/outpatient/P001',
    root: '.result-detail',
    steps: async (page) => {
      await closeAiFloat(page);
      await page.locator('.result-list-item').first().click();
      await page.waitForTimeout(600);
    },
  },

  // 质控明细：点「查看全部 N 处遗漏」才展开，默认只有摘要
  {
    key: '43-qc-detail',
    hash: '#/outpatient/P001',
    root: '.rc-qc-detail',
    steps: async (page) => {
      await clickExact(page, '.ttab', '病历管理');
      await page.locator('.rc-risk-card .rc-side-more').first().click();
      await page.waitForTimeout(600);
    },
  },

  // ＋ 菜单与技能管理。这几个状态此前完全没采集过 —— 它们藏在菜单展开与对话框里，
  // 不点开就不存在于 DOM，照着源码写会漏掉计算样式，还原度比对也覆盖不到。
  {
    key: '50-plus-menu',
    hash: '#/outpatient/P001',
    root: '.plus-menu',
    steps: async (page) => {
      await page.locator('.tb-plus-btn').first().click();
      await page.waitForTimeout(400);
    },
  },
  {
    key: '51-plus-menu-prompts',
    hash: '#/outpatient/P001',
    root: '.plus-menu',
    steps: async (page) => {
      await page.locator('.tb-plus-btn').first().click();
      await page.waitForTimeout(300);
      await page.locator('.pm-submenu-trigger').first().click();
      await page.waitForTimeout(400);
    },
  },
  {
    key: '52-skill-manage',
    hash: '#/outpatient/P001',
    root: '.skill-manage-dialog',
    steps: async (page) => {
      await page.locator('.tb-plus-btn').first().click();
      await page.waitForTimeout(300);
      // 「技能管理」是 ＋ 菜单最后一项
      await page.locator('.plus-menu .pm-item').last().click();
      await page.waitForTimeout(700);
    },
  },

  // 浮层关闭后的两个重新唤出态。两者互斥，必须分别采。
  // 漏掉它们的后果不是样式差一点，而是医生点了 × 之后再也唤不回浮层。
  {
    key: '53-solo-tips-open-btn',
    hash: '#/outpatient/P001',
    root: '.solo-tips-open-btn',
    steps: async (page) => {
      await page.locator('.tips-close').first().click();
      await page.waitForTimeout(500);
    },
  },
  {
    key: '54-ai-float-btn',
    hash: '#/outpatient/P001',
    root: '.ai-float-btn',
    steps: async (page) => {
      await closeAiFloat(page);
      await page.waitForTimeout(500);
    },
  },
];

/**
 * 在页面里执行：产出「标签 + class + 直接文本」的结构骨架。
 * root 为可选的 CSS 选择器；八个 AI 标签页共存于 DOM 靠 display 切换，
 * 传入 `.tips-tab-pane:not([style*="display: none"])` 可只抓当前可见面板。
 */
function outlineFn([maxDepth, root]) {
  const app = (root && document.querySelector(root)) || document.querySelector('#app') || document.body;
  const lines = [];
  (function walk(el, depth) {
    if (depth > maxDepth) return;
    for (const child of el.children) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'svg' || tag === 'path' || tag === 'style' || tag === 'script') continue;
      const raw = typeof child.className === 'string' ? child.className.trim() : '';
      const cls = raw
        ? '.' + raw.split(/\s+/).filter((c) => c && !c.startsWith('el-tooltip')).join('.')
        : '';
      const ownText = [...child.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 60);
      lines.push('  '.repeat(depth) + tag + cls + (ownText ? `  «${ownText}»` : ''));
      walk(child, depth + 1);
    }
  })(app, 0);
  return lines.join('\n');
}

/** 在页面里执行：收集应用自有 class 及其关键计算样式，用于核对复刻后的视觉。 */
function computedFn() {
  const app = document.querySelector('#app') || document.body;
  const seen = new Map();
  const PROPS = [
    'display', 'position', 'width', 'height', 'padding', 'margin', 'gap',
    'flexDirection', 'alignItems', 'justifyContent', 'gridTemplateColumns',
    'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor',
    'border', 'borderRadius', 'boxShadow', 'overflow',
  ];
  for (const el of app.querySelectorAll('*')) {
    const raw = typeof el.className === 'string' ? el.className.trim() : '';
    if (!raw) continue;
    for (const cls of raw.split(/\s+/)) {
      // 只记录应用自有类名，Element Plus 内置类不重复采集
      if (!cls || cls.startsWith('el-') || cls.startsWith('is-') || seen.has(cls)) continue;
      const cs = getComputedStyle(el);
      const style = {};
      for (const p of PROPS) {
        const v = cs[p];
        if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') {
          style[p] = v;
        }
      }
      seen.set(cls, style);
    }
  }
  return Object.fromEntries([...seen.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

async function main() {
  const html = await readFile(SOURCE);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });

  // 应用有路由守卫：未登录时任何 hash 都会被打回 #/login。
  // 所以顺序固定为「先抓登录页 → 登录一次 → 之后只改 hash 切换」，全程不再整页重载。
  await page.goto(`http://127.0.0.1:${PORT}/#/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  let loggedIn = false;
  const manifest = [];
  for (const target of TARGETS) {
    if (target.hash !== '#/login') {
      if (!loggedIn) {
        await page.getByRole('button', { name: '进入门诊工作站' }).click();
        await page.waitForFunction(() => !location.hash.includes('login'), null, { timeout: 15000 });
        loggedIn = true;
      }
      // 先回候诊列表再进目标，确保每个状态都从干净的组件挂载开始
      await page.evaluate(() => { location.hash = '/outpatient/list'; });
      await page.waitForTimeout(400);
      await page.evaluate((h) => { location.hash = h.slice(1); }, target.hash);
    }
    await page.waitForTimeout(1500);

    if (target.steps) {
      await target.steps(page);
      await page.waitForTimeout(600);
    }

    const [dom, outline, computed] = await Promise.all([
      page.evaluate(
        (root) => ((root && document.querySelector(root)) || document.querySelector('#app') || document.body).outerHTML,
        target.root ?? null,
      ),
      page.evaluate(outlineFn, [12, target.root ?? null]),
      page.evaluate(computedFn),
    ]);

    await writeFile(join(OUT_DIR, `${target.key}.html`), dom);
    await writeFile(join(OUT_DIR, `${target.key}.outline.txt`), outline);
    await writeFile(join(OUT_DIR, `${target.key}.computed.json`), JSON.stringify(computed, null, 2));
    await page.screenshot({ path: join(OUT_DIR, `${target.key}.png`), fullPage: true });

    manifest.push({
      key: target.key,
      hash: target.hash,
      title: await page.title(),
      domBytes: dom.length,
      outlineLines: outline.split('\n').length,
      classCount: Object.keys(computed).length,
    });
    console.log(`✓ ${target.key}  ${dom.length} B DOM, ${Object.keys(computed).length} 个自有 class`);
  }

  await writeFile(
    join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ source: 'AI-HIS门诊模块V4.3.html', viewport: VIEWPORT, targets: manifest }, null, 2),
  );

  await browser.close();
  server.close();
  console.log(`\n产物目录：${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
