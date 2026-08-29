#!/usr/bin/env node
/**
 * 把抽取出来的 app.css 按组件作用域拆开，供重建的 Vue SFC 直接放进 <style scoped>。
 *
 * 为什么不能直接当全局样式用：
 *   V4.3 是编译产物，应用样式带 Vue 的 [data-v-xxxxxxxx] 作用域属性。
 *   同名类在不同组件里声明并不相同 —— 例如 .his-header 在工作站是 46px 高、
 *   在候诊列表是 56px 高。剥掉属性直接扁平化会让这两条规则互相覆盖。
 *
 * 正确做法是按作用域拆分后各自放进对应 SFC 的 <style scoped>：
 * Vue 会重新加上自己的 data-v 哈希，语义与原件完全一致。
 *
 * 用法：node scripts/split-v43-css.mjs
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'references/ui-demo/extracted/app.css');
const OUT_DIR = join(ROOT, 'references/ui-demo/extracted/scoped');

// 作用域哈希 → 组件。由 extracted/dom 下各页面的标志性类名比对确定。
const SCOPES = {
  '29a761d4': 'AiEmrFloat',
  '357079fb': 'OutpatientWorkstation',
  '95a361e4': 'OutpatientList',
  d5b2eb27: 'PatientManage',
  ae3fcc07: 'Login',
};

/** 切出顶层规则块，正确跳过 @media / @keyframes 这类嵌套结构。 */
function splitRules(css) {
  const blocks = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        blocks.push(css.slice(start, i + 1).trim());
        start = i + 1;
      }
    }
  }
  return blocks.filter(Boolean);
}

const css = await readFile(SOURCE, 'utf-8');
const blocks = splitRules(css.replace(/\/\*[\s\S]*?\*\//g, ''));

const buckets = Object.fromEntries([...Object.values(SCOPES), 'global'].map((k) => [k, []]));

const SCOPE_SUFFIX = new RegExp(`-(${Object.keys(SCOPES).join('|')})\\b`, 'g');

for (const block of blocks) {
  // 去掉作用域属性与动画名后缀；Vue 编译 <style scoped> 时会统一加回它自己的哈希，
  // 且会同时改写 @keyframes 定义与 animation 引用，两边始终对得上。
  const cleaned = block.replace(/\[data-v-[0-9a-f]{8}\]/g, '').replace(SCOPE_SUFFIX, '');

  // @keyframes 块不带 data-v 属性，只能靠动画名里的哈希后缀判定归属。
  // 漏了这一步，动画定义会全部落到 global，而引用它的规则在各组件里，动画直接失效。
  const keyframes = block.match(/@keyframes\s+[\w-]+?-([0-9a-f]{8})\b/);
  if (keyframes) {
    const component = SCOPES[keyframes[1]];
    buckets[component ?? 'global'].push(cleaned);
    continue;
  }

  const hashes = [...new Set([...block.matchAll(/data-v-([0-9a-f]{8})/g)].map((m) => m[1]))];
  if (hashes.length === 0) {
    buckets.global.push(cleaned);
    continue;
  }
  for (const hash of hashes) {
    const component = SCOPES[hash];
    if (component) buckets[component].push(cleaned);
    else buckets.global.push(cleaned);
  }
}

await mkdir(OUT_DIR, { recursive: true });
for (const [name, rules] of Object.entries(buckets)) {
  const header =
    `/* 由 scripts/split-v43-css.mjs 从 app.css 自动拆出，请勿手工编辑。\n` +
    `   ${name === 'global' ? '无作用域的全局规则' : `${name} 组件作用域`}：${rules.length} 条 */\n\n`;
  await writeFile(join(OUT_DIR, `${name}.css`), header + rules.join('\n') + '\n', 'utf-8');
  console.log(`✓ ${name.padEnd(22)} ${String(rules.length).padStart(4)} 条规则`);
}
console.log(`\n产物目录：${OUT_DIR}`);
