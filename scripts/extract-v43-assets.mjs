#!/usr/bin/env node
/**
 * 从 references/ui-demo/AI-HIS门诊模块V4.3.html（不可修改的打包原件）中抽取
 * 重建一期前端所需的 UI 基准资料：
 *
 *   extracted/app.css            应用自有 CSS（已剔除 Element Plus 内置规则）
 *   extracted/design-tokens.css  :root 设计令牌与 Element Plus 主题覆盖
 *   extracted/element-plus.css   Element Plus 规则（仅供比对，不要直接引入）
 *   extracted/fixtures/*.json    演示数据（患者、药品、评估、病历、共病、对话脚本、时间轴、检查）
 *   extracted/inventory.json     路由、组件名、后端 API 端点与 SSE 事件类型清单
 *
 * 用法： node scripts/extract-v43-assets.mjs
 *
 * 该脚本只读源件，输出全部落在 references/ui-demo/extracted/。
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "references/ui-demo/AI-HIS门诊模块V4.3.html");
const OUT = path.join(ROOT, "references/ui-demo/extracted");

/** 打包原件的 SHA-256 前缀，防止误对着改过的文件抽取。 */
const EXPECTED_MD5 = "df95a09bb3711a20a2ed8bbdb0a86264";

const src = fs.readFileSync(SOURCE, "utf8");

/* ------------------------------------------------------------------ *
 * 1. CSS 拆分
 * ------------------------------------------------------------------ */

/** 把一段 CSS 按顶层大括号切成规则数组。 */
function splitRules(css) {
  const rules = [];
  let depth = 0;
  let buf = "";
  for (const c of css) {
    buf += c;
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        rules.push(buf.trim());
        buf = "";
      }
    }
  }
  return rules;
}

/** Element Plus 自带规则：选择器里出现 .el- / --el- / .ep-，或 @font-face。 */
function isElementPlusRule(rule) {
  const selector = rule.split("{", 1)[0];
  return /\.el-|--el-|\.ep-/.test(selector) || selector.trim().startsWith("@font-face");
}

/** 设计令牌块：只含自定义属性声明的 :root 规则。 */
function isTokenRule(rule) {
  const selector = rule.split("{", 1)[0].trim();
  return selector === ":root" || selector === "html" || selector === ":root,html";
}

function extractCss() {
  const blocks = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const rules = splitRules(blocks.join("\n"));

  const tokens = rules.filter(isTokenRule);
  const elementPlus = rules.filter((r) => !isTokenRule(r) && isElementPlusRule(r));
  const app = rules.filter((r) => !isTokenRule(r) && !isElementPlusRule(r));

  write("design-tokens.css", header("设计令牌与 Element Plus 主题覆盖") + tokens.join("\n\n"));
  write("app.css", header("应用自有样式（重建 Vue SFC 时的视觉基准）") + app.join("\n"));
  write("element-plus.css", header("Element Plus 内置规则，仅供比对，不要直接引入") + elementPlus.join("\n"));

  return { total: rules.length, tokens: tokens.length, app: app.length, elementPlus: elementPlus.length };
}

/* ------------------------------------------------------------------ *
 * 2. 演示数据
 * ------------------------------------------------------------------ */

/** 从 index 处的开括号开始，按配对规则截出完整的字面量（跳过字符串内的括号）。 */
function readLiteral(startIndex) {
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = startIndex; i < src.length; i += 1) {
    const c = src[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escaped = true;
      else if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = true;
      quote = c;
      continue;
    }
    if (c === "[" || c === "{" || c === "(") depth += 1;
    else if (c === "]" || c === "}" || c === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(startIndex, i + 1);
    }
  }
  return null;
}

/** 打包后变量名会随构建变化，因此按数据形状定位而不是按变量名。 */
const FIXTURES = [
  { file: "patients.json", anchor: '=[{id:"P001"', open: "[", note: "候诊/患者主数据，7 例" },
  { file: "drugs.json", anchor: '=[{id:"D001"', open: "[", note: "药品字典" },
  { file: "assessments.json", anchor: /=\{P001:\{overall_conclusion:/, open: "{", note: "智慧诊疗：结论、风险评估、风险预警、疗效、推荐医嘱" },
  { file: "record-content.json", anchor: /=\{P001:\{chief_complaint:/, open: "{", note: "病历七段基线文本" },
  { file: "comorbidity.json", anchor: /=\{P001:\{detected:/, open: "{", note: "共病识别结果" },
  { file: "dialog-script.json", anchor: /=\{P001:\[\{role:"doctor"/, open: "{", note: "医患对话脚本" },
  { file: "timeline.json", anchor: /=\{P001:\[\{time:"/, open: "{", note: "接诊时间轴事件" },
  { file: "examinations.json", anchor: /=\{P001:\[\{id:"e1"/, open: "{", note: "检查报告" },
];

function extractFixtures() {
  const report = [];
  for (const fixture of FIXTURES) {
    const index =
      typeof fixture.anchor === "string"
        ? src.indexOf(fixture.anchor)
        : (src.match(fixture.anchor)?.index ?? -1);
    if (index < 0) {
      report.push({ ...fixture, status: "not-found" });
      continue;
    }
    const open = src.indexOf(fixture.open, index);
    const literal = readLiteral(open);
    if (!literal) {
      report.push({ ...fixture, status: "unbalanced" });
      continue;
    }
    try {
      const value = vm.runInNewContext(`(${literal})`, {}, { timeout: 10_000 });
      write(path.join("fixtures", fixture.file), JSON.stringify(value, null, 2));
      const size = Array.isArray(value) ? value.length : Object.keys(value).length;
      report.push({ ...fixture, status: "ok", entries: size });
    } catch (error) {
      report.push({ ...fixture, status: `eval-failed: ${error.message.slice(0, 120)}` });
    }
  }
  return report;
}

/* ------------------------------------------------------------------ *
 * 3. 路由 / 组件 / 后端契约清单
 * ------------------------------------------------------------------ */

function extractInventory() {
  const routes = [...src.matchAll(/path:"(\/[^"]*)",name:"([A-Za-z]+)"[^}]*?title:"([^"]+)"/g)].map((m) => ({
    path: m[1],
    name: m[2],
    title: m[3],
  }));

  const componentNames = [...new Set([...src.matchAll(/__name:"([A-Z][A-Za-z0-9_]*)"/g)].map((m) => m[1]))];

  const endpoints = [...new Set([...src.matchAll(/(\/api\/[a-zA-Z0-9_\/-]+)/g)].map((m) => m[1]))].sort();

  const sseEvents = [...new Set([...src.matchAll(/\.type===?"([a-z_]+)"/g)].map((m) => m[1]))]
    .filter((t) => /token|record_|prompt_|done/.test(t))
    .sort();

  return { routes, componentNames, endpoints, sseEvents };
}

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

function header(title) {
  return `/* ${title}\n   由 scripts/extract-v43-assets.mjs 从 AI-HIS门诊模块V4.3.html 自动抽取，请勿手工编辑。 */\n\n`;
}

function write(relativePath, content) {
  const target = path.join(OUT, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const css = extractCss();
  const fixtures = extractFixtures();
  const inventory = extractInventory();

  write("inventory.json", JSON.stringify({ source: path.basename(SOURCE), expectedMd5: EXPECTED_MD5, css, fixtures, ...inventory }, null, 2));

  console.log(`CSS      规则 ${css.total}：令牌 ${css.tokens} / 应用 ${css.app} / Element Plus ${css.elementPlus}`);
  console.log(`路由     ${inventory.routes.length}：${inventory.routes.map((r) => r.path).join(" ")}`);
  console.log(`组件     ${inventory.componentNames.join(", ")}`);
  console.log(`API      ${inventory.endpoints.length} 个端点`);
  console.log(`SSE      ${inventory.sseEvents.join(", ")}`);
  for (const f of fixtures) {
    console.log(`Fixture  ${f.file.padEnd(22)} ${f.status}${f.entries ? ` (${f.entries})` : ""}`);
  }
}

main();
