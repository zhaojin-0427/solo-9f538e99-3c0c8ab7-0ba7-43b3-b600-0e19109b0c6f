/*
 * 端到端核对脚本（Playwright + Chromium）
 *
 * 运行方式（需要可访问的 Chromium 与 playwright 包）：
 *   NODE_PATH=/path/to/node_modules LD_LIBRARY_PATH=... node tests/verify.cjs
 *
 * 核对内容：
 *  A. 每页页脚脚注集合 == 该页正文实际引用编号（去重、按首次出现排序）
 *  B. 同一注号跨页时，每个引用页页底都出现且只出现一次
 *  C. 贪心“最大连续整行”：采纳高度 <= A5，首个被拒行高度 > A5
 *  D. 分页连续覆盖全部视觉行
 *  E. 空白页也放不下的行 -> 标红 + 问题面板 + 停用打印；缩短脚注后恢复
 *  F. 改字号后页数变化（重新分页）
 *  G. 打印媒体下 .page 不溢出；导出的 PDF 页数 == 预览页数
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const { PDFDocument } = require("pdf-lib");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8000";
const SHOT_DIR = process.env.SHOT_DIR || "/tmp/shots";
const PDF_PATH = process.env.PDF_PATH || "/tmp/handout.pdf";

fs.mkdirSync(SHOT_DIR, { recursive: true });

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log("  ✅ " + name);
  } else {
    failures++;
    console.error("  ❌ " + name + (extra !== undefined ? " :: " + JSON.stringify(extra) : ""));
  }
}
function section(t) { console.log("\n=== " + t + " ==="); }

async function getDebug(page) {
  return page.evaluate(() => window.__paginateApp.runNow()).then(() =>
    page.evaluate(() => window.__paginationDebug)
  );
}

async function setText(page, text) {
  await page.fill("#source-input", text);
  await page.waitForTimeout(220); // 120ms debounce + layout
  return getDebug(page);
}

async function setFontSize(page, size) {
  await page.evaluate((s) => {
    const el = document.getElementById("font-size");
    el.value = String(s);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, size);
  await page.waitForTimeout(220);
  return page.evaluate(() => window.__paginationDebug);
}

/** 在浏览器内核对每页 DOM：脚注集合与正文引用一致、页内无重复 */
async function auditPageDom(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll("#pages .page").forEach((pg, i) => {
      const bodyRefs = Array.from(pg.querySelectorAll(".page-body .fn-ref")).map((e) => e.dataset.ref);
      const seen = new Set();
      const uniqueOrdered = [];
      for (const id of bodyRefs) if (!seen.has(id)) { seen.add(id); uniqueOrdered.push(id); }

      const fnIds = Array.from(pg.querySelectorAll(".page-footnotes .fn-item")).map((e) => e.dataset.id);
      const dupFn = fnIds.filter((id, idx) => fnIds.indexOf(id) !== idx);

      out.push({
        page: i + 1,
        bodyRefCount: bodyRefs.length,
        uniqueOrdered,
        fnIds,
        dupFn,
        equal: JSON.stringify(uniqueOrdered) === JSON.stringify(fnIds),
        bodyLineCount: pg.querySelectorAll(".page-body .body-line").length,
      });
    });
    return out;
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1180, height: 980 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => { failures++; console.error("  ❌ 页面 JS 错误:", e.message); });
  page.on("console", (m) => { if (m.type() === "error") console.error("  [browser console.error]", m.text()); });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#pages .page", { timeout: 8000 });
  await page.waitForTimeout(400); // 等 document.fonts.ready 的防抖重排

  // ---------------------------------------------------------------
  section("A. 内置示例：基本分页与页内脚注一致性");
  let dbg = await getDebug(page);
  console.log("  示例分页:", dbg.pageCount, "页 /", dbg.lineCount, "视觉行 / A5高", dbg.a5HeightPx, "px");
  check("示例至少排出 3 页", dbg.pageCount >= 3, dbg.pageCount);
  check("没有纵向排不下的行", dbg.verticalIssues.length === 0, dbg.verticalIssues);
  check("没有横向溢出行", dbg.horizontalIssues.length === 0, dbg.horizontalIssues);

  let audit = await auditPageDom(page);
  check("每一页的脚注集合都与该页正文引用一致", audit.every((p) => p.equal), audit.filter((p) => !p.equal));
  check("任何一页的脚注都没有重复编号", audit.every((p) => p.dupFn.length === 0));
  check("每页至少有 1 个正文行", audit.every((p) => p.bodyLineCount > 0));

  // 连续性：页与页覆盖 1..N 行
  let contiguous = dbg.pages[0].startLine === 1;
  for (let i = 1; i < dbg.pages.length; i++) {
    if (dbg.pages[i].startLine !== dbg.pages[i - 1].endLine + 1) contiguous = false;
  }
  if (dbg.pages.length) {
    contiguous = contiguous && dbg.pages[dbg.pages.length - 1].endLine === dbg.lineCount;
  }
  check("所有页连续、不重不漏地覆盖全部视觉行", contiguous, dbg.pages.map((p) => [p.startLine, p.endLine]));

  // 最大性：被接受页高度 <= A5；若有下一行被拒，其试排高度 > A5(+容差)
  let maxima = true;
  for (const p of dbg.pages) {
    if (p.invalidLine) continue;
    if (p.acceptedHeightPx != null && p.acceptedHeightPx > dbg.a5HeightPx + 1.5) maxima = false;
    if (p.rejectHeightPx != null && p.rejectHeightPx <= dbg.a5HeightPx + 1) maxima = false;
  }
  check("每页都是最大可容纳连续前缀（采纳不超高、加下一行必超高）", maxima,
    dbg.pages.map((p) => ({ n: p.page, h: p.acceptedHeightPx, reject: p.rejectHeightPx })));

  await page.locator("#pages .page").nth(0).screenshot({ path: path.join(SHOT_DIR, "sample-page1.png") });
  await page.screenshot({ path: path.join(SHOT_DIR, "ui-overview.png") });
  const midIdx = Math.floor(dbg.pageCount / 2);
  await page.locator("#pages .page").nth(midIdx).screenshot({ path: path.join(SHOT_DIR, `sample-page${midIdx + 1}.png`) });

  // ---------------------------------------------------------------
  section("B. 同号跨页讲义（专门构造）");
  const crossLines = [];
  for (let i = 1; i <= 46; i++) {
    crossLines.push(
      `第${i}段：社区夜校的大字讲义试排文字，学员翻到任何一页都能在页底看到本页脚注。同一条编号一会在很多段里重复出现。[^1]`
    );
    if (i % 7 === 0) crossLines.push("");
  }
  crossLines.push("最后一段引用另一条较长的脚注。[^2]");
  const crossText = crossLines.join("\n");

  // 通过 UI 填入，并填写两条脚注
  await setText(page, crossText);
  await page.fill('.note-field[data-id="1"] textarea', "这是编号一的脚注，内容中等长度，用来观察跨页时各页页底是否分别排出、且同页只排一次。");
  await page.fill('.note-field[data-id="2"] textarea', "另一条脚注。");
  await page.waitForTimeout(220);
  dbg = await getDebug(page);

  const pagesWith1 = dbg.pages.filter((p) => p.footnoteIds.includes("1")).map((p) => p.page);
  console.log("  含 [^1] 脚注的页:", pagesWith1.join(", "));
  check("编号 1 出现在至少两页（同号跨页）", pagesWith1.length >= 2, pagesWith1);
  check("跨页讲义无排不下的行", dbg.verticalIssues.length === 0, dbg.verticalIssues);
  check("跨页讲义无横向溢出", dbg.horizontalIssues.length === 0, dbg.horizontalIssues);

  audit = await auditPageDom(page);
  check("跨页讲义每页脚注仍与正文引用一致", audit.every((p) => p.equal));
  check("跨页讲义没有任何一页重复排出同一注号", audit.every((p) => p.dupFn.length === 0));
  // 每个正文有 [^1] 的页，脚注区恰好一个 [1]
  const oneOnce = audit
    .filter((p) => p.uniqueOrdered.includes("1"))
    .every((p) => p.fnIds.filter((x) => x === "1").length === 1);
  check("每个相关页的页底 [1] 恰好出现一次", oneOnce);

  // 截图前两页与跨页边界相邻两页
  await page.locator("#pages .page").nth(0).screenshot({ path: path.join(SHOT_DIR, "cross-page1.png") });
  if (pagesWith1.length >= 2) {
    const b = pagesWith1[1] - 1;
    await page.locator("#pages .page").nth(Math.max(0, b - 1)).screenshot({ path: path.join(SHOT_DIR, "cross-boundary-a.png") });
    await page.locator("#pages .page").nth(b).screenshot({ path: path.join(SHOT_DIR, "cross-boundary-b.png") });
  }

  // ---------------------------------------------------------------
  section("C. 空白页也放不下的行 -> 标记 + 停用打印 + 可恢复");
  await setText(page, "这是一行本身很短、但拖着一条超长脚注的测试行。[^9]");
  const longNote = "超长脚注内容。".repeat(180); // ~1620 字，必然超过整页
  await page.waitForSelector('.note-field[data-id="9"] textarea');
  await page.fill('.note-field[data-id="9"] textarea', longNote);
  await page.waitForTimeout(220);
  dbg = await getDebug(page);

  const printDisabledWhenBad = await page.$eval("#print-btn", (b) => b.disabled);
  const invalidPages = await page.$$eval(".page.is-invalid", (e) => e.length);
  const badLines = await page.$$eval(".body-line.line-bad", (e) => e.length);
  const issueItems = await page.$$eval("#issues-list .issue-item", (e) => e.length);

  check("报告 1 个纵向排不下问题", dbg.verticalIssues.length === 1, dbg.verticalIssues);
  check("打印按钮已停用", printDisabledWhenBad === true);
  check("预览中有 1 张标红的问题页", invalidPages === 1, invalidPages);
  check("问题行有 line-bad 标记", badLines === 1, badLines);
  check("问题面板列出问题", issueItems >= 1, issueItems);
  await page.locator("#pages .page.is-invalid").screenshot({ path: path.join(SHOT_DIR, "invalid-line.png") });

  // 即使绕过禁用按钮（模拟 Ctrl+P / 菜单打印），打印样式也只给停用说明页
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(120);
  const blockedBodyClass = await page.$eval("body", (b) => b.classList.contains("print-blocked"));
  await page.pdf({ path: "/tmp/blocked.pdf", preferCSSPageSize: true, printBackground: true });
  const blockedPdf = await PDFDocument.load(fs.readFileSync("/tmp/blocked.pdf"));
  check("阻断时 body 带 print-blocked", blockedBodyClass);
  check("阻断时打印结果只有 1 页停用说明", blockedPdf.getPageCount() === 1, blockedPdf.getPageCount());
  await page.emulateMedia({ media: "screen" });

  // 缩短脚注后应恢复
  await page.fill('.note-field[data-id="9"] textarea', "短脚注。");
  await page.waitForTimeout(220);
  dbg = await getDebug(page);
  const printEnabledAfterFix = await page.$eval("#print-btn", (b) => b.disabled === false);
  check("缩短脚注后问题消失", dbg.verticalIssues.length === 0, dbg.verticalIssues);
  check("缩短脚注后打印恢复可用", printEnabledAfterFix);

  // ---------------------------------------------------------------
  section("D. 改字号后重新分页");
  // 回到示例
  await page.click("#load-sample-btn");
  await page.waitForTimeout(220);
  const d18 = await getDebug(page);
  const d28 = await setFontSize(page, 28);
  const d14 = await setFontSize(page, 14);
  console.log(`  14pt=${d14.pageCount}页, 18pt=${d18.pageCount}页, 28pt=${d28.pageCount}页`);
  check("字号变大页数不减少", d28.pageCount >= d18.pageCount, { p18: d18.pageCount, p28: d28.pageCount });
  check("字号变小页数不增多", d14.pageCount <= d18.pageCount, { p14: d14.pageCount, p18: d18.pageCount });
  check("28pt 下无横向溢出", d28.horizontalIssues.length === 0, d28.horizontalIssues);
  check("14pt 下无横向溢出", d14.horizontalIssues.length === 0);
  // 恢复 18
  await setFontSize(page, 18);

  // ---------------------------------------------------------------
  section("E. 打印一致性（print 媒体不溢出 + PDF 页数）");
  dbg = await getDebug(page);
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(150);

  const overflow = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll("#pages .page").forEach((pg, i) => {
      // 打印 CSS 下页面仍是固定 A5；内容不应超出
      if (pg.scrollHeight > pg.clientHeight + 1) {
        bad.push({ page: i + 1, scrollHeight: pg.scrollHeight, clientHeight: pg.clientHeight });
      }
    });
    const measureHidden = getComputedStyle(document.getElementById("measure-stage")).display === "none";
    const headerHidden = getComputedStyle(document.querySelector(".app-header")).display === "none";
    return { bad, measureHidden, headerHidden };
  });
  check("print 媒体下测量台被隐藏", overflow.measureHidden);
  check("print 媒体下编辑顶栏被隐藏", overflow.headerHidden);
  check("print 媒体下没有任何 A5 页内容溢出", overflow.bad.length === 0, overflow.bad);

  await page.pdf({ path: PDF_PATH, preferCSSPageSize: true, printBackground: true });
  const pdfBytes = fs.readFileSync(PDF_PATH);
  const pdf = await PDFDocument.load(pdfBytes);
  const pdfPages = pdf.getPageCount();
  const p0 = pdf.getPage(0);
  const { width: pw, height: ph } = p0.getSize();
  console.log("  预览页数:", dbg.pageCount, " PDF 页数:", pdfPages, " 尺寸(pt):", pw.toFixed(1) + "x" + ph.toFixed(1));
  check("PDF 纸张为 A5（约 419.5×595.3pt）", Math.abs(pw - 419.5) < 1.5 && Math.abs(ph - 595.3) < 1.5, { pw, ph });
  check("导出的 PDF 页数与预览分页完全一致", pdfPages === dbg.pageCount, { pdfPages, preview: dbg.pageCount });

  await page.emulateMedia({ media: "screen" });

  // 额外：直接对“同号跨页”场景出一份 PDF 并核对页数
  section("F. 同号跨页讲义的 PDF 也与预览一致");
  await setText(page, crossText);
  await page.fill('.note-field[data-id="1"] textarea', "这是编号一的脚注，内容中等长度，用来观察跨页时各页页底是否分别排出、且同页只排一次。");
  await page.fill('.note-field[data-id="2"] textarea', "另一条脚注。");
  await page.waitForTimeout(220);
  const crossDbg = await getDebug(page);
  // 注意：page.pdf 默认用 print 媒体，但若测试此前显式 emulate 过 screen，
  // 该覆盖会持续生效，所以出 PDF 前必须显式切回 print。
  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(150);
  const pdf2Path = "/tmp/cross-handout.pdf";
  await page.pdf({ path: pdf2Path, preferCSSPageSize: true, printBackground: true });
  const pdf2 = await PDFDocument.load(fs.readFileSync(pdf2Path));
  check("跨页讲义 PDF 页数 == 预览页数", pdf2.getPageCount() === crossDbg.pageCount,
    { pdf: pdf2.getPageCount(), preview: crossDbg.pageCount });
  await page.emulateMedia({ media: "screen" });

  // ---------------------------------------------------------------
  section("G. 同页同号多次引用只排一次 + 编号空白归一化");
  await setText(page, "第一处[^7]和第二处[^7]在同一页，还有带空格的[^ 7 ]。");
  await page.waitForSelector('.note-field[data-id="7"] textarea');
  await page.fill('.note-field[data-id="7"] textarea', "第七条脚注只应在页底出现一次。");
  await page.waitForTimeout(200);
  const gAudit = await auditPageDom(page);
  check("同页多次引用 [^7] 时页底脚注恰好 1 条", gAudit.length === 1 && gAudit[0].fnIds.length === 1 && gAudit[0].fnIds[0] === "7", gAudit);
  check("正文里 3 个引用标记都被保留（含空格写法）", gAudit[0] && gAudit[0].bodyRefCount === 3, gAudit[0]);
  check("该场景无横向溢出", (await getDebug(page)).horizontalIssues.length === 0);

  // ---------------------------------------------------------------
  section("H. 窄屏（390px）布局不产生整页横向溢出");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const scroll = await page.evaluate(() => ({
    docScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  check("document 不出现横向溢出（A5 在预览区内滚动）", scroll.docScrollWidth <= scroll.innerWidth + 1, scroll);
  await page.screenshot({ path: path.join(SHOT_DIR, "mobile-390.png") });

  await browser.close();

  console.log("\n========================================");
  if (failures === 0) {
    console.log("全部核对通过 ✅  截图目录: " + SHOT_DIR + "  PDF: " + PDF_PATH);
  } else {
    console.error("共有 " + failures + " 项核对失败 ❌");
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error("验证脚本异常：", e);
  process.exit(2);
});
