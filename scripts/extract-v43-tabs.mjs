#!/usr/bin/env node
/**
 * 逐标签页抽取 V4.3 的完整实现参照：结构、文案、图标、配色。
 *
 * 前面几个脚本给的是「整页」视角，重建单个标签页时要反复在大文件里翻找，
 * 容易漏掉角标、图标、状态色这些细节 —— 已经因此漏做过健康档案与病历质控。
 * 这个脚本按标签页切开，每页产出一份自足的参照文件。
 *
 * 用法：node scripts/extract-v43-tabs.mjs
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOM_DIR = join(ROOT, 'references/ui-demo/extracted/dom');
const CSS_FILE = join(ROOT, 'references/ui-demo/extracted/scoped/AiEmrFloat.css');
const OUT_DIR = join(ROOT, 'references/ui-demo/extracted/tabs');

const TABS = [
  '01-智慧诊疗', '02-预警评估', '03-病历管理', '04-诊断管理',
  '05-医嘱管理', '06-共病管理', '07-健康档案', '08-时间轴',
];

/** 颜色相关的声明。重建时最容易走样的就是状态色与角标色。 */
const COLOR_PROPS = /(?:^|;)\s*(color|background|background-color|border|border-color|border-left|fill)\s*:/;

/** 抽出结构骨架：标签 + class + 直接文本 */
function outline(html) {
  const lines = [];
  const stack = [];
  const token = /<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi;
  let match;
  while ((match = token.exec(html))) {
    const [, closing, tag, attrs, text] = match;
    if (text !== undefined) {
      const trimmed = text.replace(/\s+/g, ' ').trim();
      if (trimmed && lines.length) lines[lines.length - 1] += `  «${trimmed.slice(0, 70)}»`;
      continue;
    }
    if (tag === 'br' || tag === 'input' || tag === 'img') continue;
    if (closing) {
      stack.pop();
      continue;
    }
    const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || '';
    const clean = cls
      .split(/\s+/)
      .filter((c) => c && !c.startsWith('el-tooltip'))
      .join('.');
    lines.push('  '.repeat(stack.length) + tag + (clean ? `.${clean}` : ''));
    if (!/\/>$/.test(match[0])) stack.push(tag);
  }
  return lines.join('\n');
}

const css = await readFile(CSS_FILE, 'utf-8');
const cssRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
  selector: sel.trim(),
  body: body.trim(),
}));

await mkdir(OUT_DIR, { recursive: true });
const index = [];

for (const tab of TABS) {
  const html = await readFile(join(DOM_DIR, `10-aitab-${tab}.html`), 'utf-8');
  const stripped = html.replace(/\sdata-v-[0-9a-f]{8}=""/g, '').replace(/<!--+[^>]*-->/g, '');

  // 该页用到的应用自有类名
  const classes = new Set();
  for (const m of stripped.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) {
      if (c && !c.startsWith('el-') && !c.startsWith('is-')) classes.add(c);
    }
  }

  // 该页可见的图标 / emoji
  const icons = [...new Set((stripped.match(/[←-⇿⌀-➿⬀-⯿️\u{1F300}-\u{1FAFF}]/gu) || []))];

  // 与这些类名相关、且含颜色声明的规则
  const colorRules = cssRules.filter(
    (r) => COLOR_PROPS.test(`;${r.body}`) && [...classes].some((c) => r.selector.includes(`.${c}`)),
  );

  const lines = [
    `# ${tab.split('-')[1]} —— V4.3 实现参照`,
    '',
    '> 由 scripts/extract-v43-tabs.mjs 从原件自动抽取，请勿手工编辑。',
    '',
    `## 自有类名（${classes.size}）`,
    '',
    '```',
    [...classes].sort().join(' '),
    '```',
    '',
    `## 图标 / emoji（${icons.length}）`,
    '',
    icons.length ? '`' + icons.join('` `') + '`' : '（无）',
    '',
    `## 配色规则（${colorRules.length}）`,
    '',
    '```css',
    colorRules.map((r) => `${r.selector}{${r.body}}`).join('\n'),
    '```',
    '',
    '## 结构与文案',
    '',
    '```',
    outline(stripped),
    '```',
    '',
  ];

  await writeFile(join(OUT_DIR, `${tab}.md`), lines.join('\n'), 'utf-8');
  index.push({ tab, classes: classes.size, icons: icons.length, colorRules: colorRules.length });
  console.log(`✓ ${tab.padEnd(14)} ${String(classes.size).padStart(3)} 类  ${String(icons.length).padStart(2)} 图标  ${String(colorRules.length).padStart(3)} 条配色规则`);
}

await writeFile(join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf-8');
console.log(`\n产物目录：${OUT_DIR}`);
