/*
 * 拆分脚注功能端到端核对（Playwright + Chromium）
 *
 *   BASE_URL=http://127.0.0.1:8000 node tests/split-verify.cjs
 *
 * 核对：
 *  S1. 按正文原换行列出每处引用；同一行多处引用可分别勾选
 *  S2. 只改勾选标记的编号，其他正文改动保留，新脚注出现、预览刷新
 *  S3. 勾选后移动原行（整行位置变化）仍可拆注
 *  S4. 新号被当前正文中“未填写的引用”占用 -> 拒绝并保持原状
 *  S5. 新号被“未被引用的已保存脚注”占用 -> 拒绝并保持原状
 *  S6. 新号与原号相同 / 含非法字符 / 释义为空 -> 拒绝
 *  S7. 原行在当前正文出现多次（无法唯一定位）或被改字（无法逐字匹配）-> 拒绝并保持原状
 *  S8. 保存失败（localStorage 抛错）-> 回滚，保持确认前正文与脚注
 *  S9. 成功后草稿持久化，刷新页面后仍是拆分后的内容
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8000";
const SHOT_DIR = process.env.SHOT_DIR || "/tmp/shots";
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

async function setText(page, text) {
  await page.fill("#source-input", text);
  await page.waitForTimeout(240);
  return page.evaluate(() => window.__paginationDebug);
}

async function fillNote(page, id, value) {
  await page.fill('.note-field[data-id="' + id + '"] textarea', value);
  await page.waitForTimeout(240);
}

async function snapshot(page) {
  return page.evaluate(() => ({
    text: window.__paginateApp.state.text,
    notes: JSON.parse(JSON.stringify(window.__paginateApp.state.notes)),
    input: document.getElementById("source-input").value,
    pageCount: window.__paginationDebug.pageCount,
  }));
}

/** 在当前正文里，按源行列出 [^id] 的位置（用于逐字比对） */
function refCounts(text, id) {
  const re = /\[\^([^\]\r\n]+)\]/g;
  let m;
  let n = 0;
  const perLine = [];
  for (const line of text.split("\n")) {
    let c = 0;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      if (m[1].trim() === id) c++;
    }
    if (c) perLine.push(c);
    n += c;
  }
  return { total: n, perLine };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => { failures++; console.error("  ❌ 页面 JS 错误:", e.message); });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#pages .page", { timeout: 8000 });
  await page.waitForTimeout(400);

  // 干净起点：清空 localStorage 后重载，写入专用讲义
  await page.evaluate(() => localStorage.removeItem("nightschool-handout-v1"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#pages .page", { timeout: 8000 });
  await page.waitForTimeout(300);

  const TEXT = [
    "第一行讲手机挂号，这里引用同一条资料。[^1]",
    "第二行讲防骗，也引用这条资料：先是一次[^1]，接着第二次[^1]，后面还有第三次[^1]。",
    "第三行讲调大字体，不引用。",
    "第四行讲交水电费，同样引用。[^1]",
  ].join("\n");

  await setText(page, TEXT);
  await fillNote(page, "1", "旧释义：一条被多处复用的资料。");
  await page.waitForTimeout(200);

  // ---------------------------------------------------------------
  section("S1. 按原换行列出引用，同一行多处可分别勾选");
  await page.selectOption("#split-source", "1");
  await page.waitForTimeout(150);

  const listing = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll("#split-lines .split-line")).map((li) => ({
      head: li.querySelector(".split-line-head").textContent,
      occ: Array.from(li.querySelectorAll(".split-occ")).map((el) => ({
        context: el.querySelector(".split-occ-context").textContent,
        pos: el.querySelector(".split-occ-pos").textContent,
        checked: el.querySelector('input[type="checkbox"]').checked,
      })),
    }));
    return lines;
  });
  console.log("  列出:", JSON.stringify(listing.map((l) => [l.head, l.occ.length])));
  check("列出 3 个原行（第二行有 3 处，其余各 1 处）",
    listing.length === 3 && listing[0].occ.length === 1 && listing[1].occ.length === 3 && listing[2].occ.length === 1,
    listing.map((l) => l.occ.length));
  check("上下文包含正文原句与高亮标记",
    listing[0].occ[0].context.includes("手机挂号") && listing[0].occ[0].context.includes("[^1]"),
    listing[0].occ[0].context);
  check("同一行 3 处分别标为“本行第 1/2/3 处”",
    listing[1].occ.map((o) => o.pos).join("|") === "本行第 1 处|本行第 2 处|本行第 3 处",
    listing[1].occ.map((o) => o.pos));
  check("默认全部未勾选", listing.every((l) => l.occ.every((o) => !o.checked)));

  // 只勾选第二行的第 1、3 处（同一行内分别勾选）
  await page.evaluate(() => {
    const boxes = document.querySelectorAll("#split-lines .split-line")[1].querySelectorAll('input[type="checkbox"]');
    boxes[0].click();
    boxes[2].click();
  });
  await page.waitForTimeout(120);
  const countText = await page.textContent("#split-count");
  const checkedUi = await page.$$eval('#split-lines input[type="checkbox"]', (els) => els.map((e) => e.checked));
  check("勾选计数为 2 / 5", countText.includes("已勾选 2 / 5"), countText);
  check("同一行内第 1、3 处被勾选、第 2 处未选",
    JSON.stringify(checkedUi) === JSON.stringify([false, true, false, true, false]), checkedUi);

  await page.screenshot({ path: path.join(SHOT_DIR, "split-panel.png"), fullPage: false });

  // ---------------------------------------------------------------
  section("S2. 确认拆注：只改勾选处、新增脚注、预览刷新");
  const before = await snapshot(page);
  await page.fill("#split-new-id", "5");
  await page.fill("#split-new-note", "新释义：这里说的是另一件事。");
  await page.click("#split-confirm");
  await page.waitForTimeout(350);

  const after = await snapshot(page);
  const countsAfter = refCounts(after.text, "1");
  const countsNew = refCounts(after.text, "5");
  console.log("  拆注后 [^1] 各处:", JSON.stringify(countsAfter.perLine), " [^5]:", JSON.stringify(countsNew.perLine));

  check("原号 [^1] 只剩未勾选的 3 处", countsAfter.total === 3, countsAfter);
  check("[^5] 恰好新增 2 处，且都在第二行同一行内", countsNew.total === 2 && countsNew.perLine.length === 1 && countsNew.perLine[0] === 2, countsNew);
  check("第一行与第四行仍保留 [^1]",
    after.text.split("\n")[0].includes("[^1]") && after.text.split("\n")[3].includes("[^1]"));
  check("第二行内未勾选的中间那处仍是 [^1]",
    after.text.split("\n")[1].indexOf("[^1]") !== -1 && after.text.split("\n")[1].includes("[^5]"));
  check("新脚注已加入已保存脚注", after.notes["5"] === "新释义：这里说的是另一件事。", after.notes["5"]);
  check("原脚注内容未被改动", after.notes["1"] === before.notes["1"]);
  check("新脚注输入框已出现在②区", await page.$('.note-field[data-id="5"] textarea') !== null);
  check("预览已刷新且总行/页数仍合理", after.pageCount >= 1, after.pageCount);
  const statusAfter = await page.textContent("#split-status");
  check("成功提示说明改了 2 处", /已把 2 处/.test(statusAfter), statusAfter);

  // 页底脚注：勾选后该页应同时有 [1] 与 [5]
  const fnIds = await page.evaluate(() => Array.from(document.querySelectorAll("#pages .page")).map((pg) =>
    Array.from(pg.querySelectorAll(".page-footnotes .fn-item")).map((e) => e.dataset.id)));
  check("预览页底出现新注号 [5]", fnIds.some((ids) => ids.includes("5")), fnIds);
  const body5 = await page.$$eval('#pages .page-body .fn-ref[data-ref="5"]', (e) => e.length);
  check("正文中有 2 个 [5] 引用标记", body5 === 2, body5);

  // ---------------------------------------------------------------
  section("S3. 勾选后移动原行：仍可拆注");
  const moveText = [
    "第四条先放到最前面，同样引用。这里是最后一行。[^1]",
    "开头的新段落，不引用任何脚注。",
    "第一行讲手机挂号，这里引用同一条资料。[^1]",
    "第二行讲防骗，也引用这条资料。[^1]",
  ].join("\n");
  await setText(page, moveText);
  await page.evaluate(() => window.__paginateApp.split.open("1"));
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    // 勾选第二行（原“第一行讲手机挂号”）
    const lines = document.querySelectorAll("#split-lines .split-line");
    const target = Array.from(lines).find((li) => li.querySelector(".split-line-head").textContent.includes("第 3 行"));
    target.querySelector('input[type="checkbox"]').click();
  });
  await page.waitForTimeout(100);

  // 编辑讲义：把被勾选的原行整行从第 3 行移到第 1 行（行内容逐字不变）
  const movedText = [
    "第一行讲手机挂号，这里引用同一条资料。[^1]",
    "第四条先放到最前面，同样引用。这里是最后一行。[^1]",
    "开头的新段落，不引用任何脚注。",
    "第二行讲防骗，也引用这条资料。[^1]",
  ].join("\n");
  await page.fill("#source-input", movedText);
  await page.waitForTimeout(300);
  const dirtyVisible = await page.isVisible("#split-dirty-hint");
  check("编辑正文后显示“正文已改动”提示", dirtyVisible === true);

  await page.fill("#split-new-id", "6");
  await page.fill("#split-new-note", "移动行后的新注。");
  await page.click("#split-confirm");
  await page.waitForTimeout(350);

  const moved = await snapshot(page);
  const movedLines = moved.text.split("\n");
  console.log("  移动后拆注结果:", JSON.stringify(movedLines));
  check("移动后的原行（现第一行）改成了 [^6]", movedLines[0].includes("[^6]") && !movedLines[0].includes("[^1]"));
  check("其余三行保持原样", movedLines[1].includes("[^1]") && movedLines[2] === "开头的新段落，不引用任何脚注。" && movedLines[3].includes("[^1]"));
  check("新脚注 [6] 已保存", moved.notes["6"] === "移动行后的新注。");
  check("原文中第 2/4 行的 [^1] 未被误改",
    refCounts(moved.text, "1").total === 2, refCounts(moved.text, "1"));

  // ---------------------------------------------------------------
  section("S4. 撞号：当前正文里未填写的引用占号");
  // [^9] 只在正文出现、脚注未填
  const collideText = [
    "第一处。[^1]",
    "这里有一个还没填写的引用。[^9]",
    "第二处。[^1]",
  ].join("\n");
  await setText(page, collideText);
  await page.evaluate(() => window.__paginateApp.split.open("1"));
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    document.querySelectorAll('#split-lines input[type="checkbox"]')[0].click();
  });
  await page.fill("#split-new-id", "9");
  await page.fill("#split-new-note", "不该写入的脚注。");
  const beforeCollide = await snapshot(page);
  await page.click("#split-confirm");
  await page.waitForTimeout(250);
  const afterCollide = await snapshot(page);
  const collideMsg = await page.textContent("#split-status");
  check("拒绝使用被未填引用占用的 [9]", /不能使用/.test(collideMsg) && /未被引用|未填写|已经引用/.test(collideMsg), collideMsg);
  check("失败后正文保持确认前", afterCollide.input === beforeCollide.input, afterCollide.input);
  check("失败后脚注保持确认前（未写入 9）", afterCollide.notes["9"] === undefined && afterCollide.notes["1"] === beforeCollide.notes["1"], afterCollide.notes);
  check("失败提示说明了原因", collideMsg.length > 10);

  // ---------------------------------------------------------------
  section("S5. 撞号：未被引用的已保存脚注也占号");
  // 先载入示例（含 1..4 号），再改成只引用 [1]，4 号变成“未被引用”但仍占号
  await page.click("#load-sample-btn");
  await page.waitForTimeout(300);
  await setText(page, "只有一处引用。[^1]");
  await page.evaluate(() => window.__paginateApp.split.open("1"));
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    document.querySelectorAll('#split-lines input[type="checkbox"]')[0].click();
  });
  await page.fill("#split-new-id", "4");
  await page.fill("#split-new-note", "也不该写入。");
  const beforeUnref = await snapshot(page);
  await page.click("#split-confirm");
  await page.waitForTimeout(250);
  const afterUnref = await snapshot(page);
  const unrefMsg = await page.textContent("#split-status");
  check("未被引用的已保存脚注 [4] 仍占号，拒绝", /不能使用/.test(unrefMsg) && /已保存脚注/.test(unrefMsg), unrefMsg);
  check("失败后正文与脚注保持不变",
    afterUnref.input === beforeUnref.input && JSON.stringify(afterUnref.notes) === JSON.stringify(beforeUnref.notes));

  // ---------------------------------------------------------------
  section("S6. 新号非法 / 与原号相同");
  await setText(page, "甲处。[^1]\n乙处。[^1]");
  await page.evaluate(() => window.__paginateApp.split.open("1"));
  await page.waitForTimeout(120);
  await page.evaluate(() => document.querySelectorAll('#split-lines input[type="checkbox"]')[0].click());

  await page.fill("#split-new-id", "1");
  await page.fill("#split-new-note", "x");
  const beforeSame = await snapshot(page);
  await page.click("#split-confirm");
  await page.waitForTimeout(150);
  let msg = await page.textContent("#split-status");
  check("新号与原号相同 -> 拒绝", /不能使用/.test(msg) && /原号相同/.test(msg), msg);
  check("拒绝后正文不变", (await snapshot(page)).input === beforeSame.input);

  await page.fill("#split-new-id", "c[2]");
  await page.fill("#split-new-note", "x");
  await page.click("#split-confirm");
  await page.waitForTimeout(150);
  msg = await page.textContent("#split-status");
  check("新号含 [ ] -> 拒绝", /不能包含/.test(msg), msg);

  await page.fill("#split-new-id", "   ");
  await page.fill("#split-new-note", "x");
  await page.click("#split-confirm");
  await page.waitForTimeout(150);
  msg = await page.textContent("#split-status");
  check("新号为空 -> 拒绝", /不能为空|请填写新脚注号/.test(msg), msg);

  await page.fill("#split-new-id", "11");
  await page.fill("#split-new-note", "   ");
  await page.click("#split-confirm");
  await page.waitForTimeout(150);
  msg = await page.textContent("#split-status");
  check("新释义为空 -> 拒绝", /请填写新脚注的释义/.test(msg), msg);
  check("释义为空时正文与脚注不变",
    (await snapshot(page)).input === beforeSame.input && (await snapshot(page)).notes["11"] === undefined);

  // ---------------------------------------------------------------
  section("S7. 原行在当前正文出现多次 -> 无法唯一定位");
  const dupText = ["重复行，引用。[^1]", "中间行。", "重复行，引用。[^1]", "另一行。[^1]"].join("\n");
  await setText(page, dupText);
  await page.evaluate(() => window.__paginateApp.split.open("1"));
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    // 一次勾选两处外观相同（但位于不同源行）的引用，二者都定位不到唯一行
    const lines = document.querySelectorAll("#split-lines .split-line");
    lines[0].querySelector('input[type="checkbox"]').click();
    lines[1].querySelector('input[type="checkbox"]').click();
  });
  await page.fill("#split-new-id", "8");
  await page.fill("#split-new-note", "重复行不能确定位置。");
  const beforeDup = await snapshot(page);
  await page.click("#split-confirm");
  await page.waitForTimeout(250);
  const afterDup = await snapshot(page);
  msg = await page.textContent("#split-status");
  check("重复原行 -> 提示无法唯一定位", /无法唯一定位/.test(msg), msg);
  check("重复行失败后正文不变", afterDup.input === beforeDup.input);
  check("重复行失败后脚注不变", JSON.stringify(afterDup.notes) === JSON.stringify(beforeDup.notes));

  // 打开时有两行逐字相同，编辑后只剩一行 -> 两组勾选会落到同一当前行，仍须拒绝
  await page.evaluate(() => window.__paginateApp.split.open("1"));
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    const lines = document.querySelectorAll("#split-lines .split-line");
    lines[0].querySelector('input[type="checkbox"]').click();
    lines[1].querySelector('input[type="checkbox"]').click();
  });
  await page.fill("#split-new-id", "13");
  await page.fill("#split-new-note", "同一行不能放两处。");
  await page.fill("#source-input", ["重复行，引用。[^1]", "中间行改了。", "另一行也改了。[^1]"].join("\n"));
  await page.waitForTimeout(300);
  const beforeCollapse = await snapshot(page);
  await page.click("#split-confirm");
  await page.waitForTimeout(250);
  msg = await page.textContent("#split-status");
  check("两处勾选落到同一当前行 -> 拒绝", /都只能对应到当前正文的同一行/.test(msg), msg);
  check("合并冲突后正文与脚注不变",
    (await snapshot(page)).input === beforeCollapse.input &&
    JSON.stringify((await snapshot(page)).notes) === JSON.stringify(beforeCollapse.notes));
  await page.evaluate(() => window.__paginateApp.split.open("1"));
  await page.waitForTimeout(120);

  // 原行被改字后再确认 -> 无法逐字匹配
  await setText(page, "会被改字的行。[^1]\n保留行。[^1]");
  await page.evaluate(() => window.__paginateApp.split.open("1"));
  await page.waitForTimeout(120);
  await page.evaluate(() => document.querySelectorAll('#split-lines input[type="checkbox"]')[0].click());
  await page.fill("#split-new-id", "12");
  await page.fill("#split-new-note", "改字后不该拆。");
  await page.fill("#source-input", "被改成了别的字。[^1]\n保留行。[^1]");
  await page.waitForTimeout(300);
  const beforeEdited = await snapshot(page);
  await page.click("#split-confirm");
  await page.waitForTimeout(250);
  const afterEdited = await snapshot(page);
  msg = await page.textContent("#split-status");
  check("原行被改字 -> 提示找不到（无法逐字匹配）", /已找不到/.test(msg) && /无法逐字匹配/.test(msg), msg);
  check("改字后失败仍保持确认前正文与脚注",
    afterEdited.input === beforeEdited.input && JSON.stringify(afterEdited.notes) === JSON.stringify(beforeEdited.notes));

  // ---------------------------------------------------------------
  section("S8. 保存失败 -> 回滚并保持确认前正文和脚注");
  await setText(page, "保存失败测试行。[^1]\n另一处。[^1]");
  await page.evaluate(() => window.__paginateApp.split.open("1"));
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    document.querySelectorAll('#split-lines input[type="checkbox"]')[0].click();
  });
  await page.fill("#split-new-id", "7");
  await page.fill("#split-new-note", "保存失败时不应留下。");
  const beforeFail = await snapshot(page);

  await page.evaluate(() => {
    window.__origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new Error("模拟保存失败"); };
  });
  await page.click("#split-confirm");
  await page.waitForTimeout(300);
  const afterFail = await snapshot(page);
  await page.evaluate(() => {
    Storage.prototype.setItem = window.__origSetItem;
    delete window.__origSetItem;
  });

  msg = await page.textContent("#split-status");
  check("提示保存失败并说明原因", /保存失败/.test(msg) && /模拟保存失败/.test(msg), msg);
  check("保存失败后正文回滚", afterFail.input === beforeFail.input, afterFail.input);
  check("保存失败后脚注回滚（7 未写入）", afterFail.notes["7"] === undefined &&
    JSON.stringify(afterFail.notes) === JSON.stringify(beforeFail.notes));
  check("保存失败后预览仍是原内容", (await page.$$eval('#pages .page-body .fn-ref[data-ref="7"]', (e) => e.length)) === 0);

  // ---------------------------------------------------------------
  section("S9. 成功后持久化：刷新页面仍是拆分后的内容");
  await setText(page, "持久化甲行。[^1]\n持久化乙行。[^1]");
  await page.evaluate(() => window.__paginateApp.split.open("1"));
  await page.waitForTimeout(120);
  await page.evaluate(() => document.querySelectorAll('#split-lines input[type="checkbox"]')[1].click());
  await page.fill("#split-new-id", "10");
  await page.fill("#split-new-note", "刷新后应仍在的脚注。");
  await page.click("#split-confirm");
  await page.waitForTimeout(350);
  const persistedExpected = await snapshot(page);
  check("确认成功", persistedExpected.text.split("\n")[1].includes("[^10]"), persistedExpected.text);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#pages .page", { timeout: 8000 });
  await page.waitForTimeout(400);
  const reloaded = await snapshot(page);
  check("刷新后正文保持拆分结果", reloaded.text === persistedExpected.text, reloaded.text);
  check("刷新后新脚注仍在", reloaded.notes["10"] === "刷新后应仍在的脚注。", reloaded.notes["10"]);

  await page.screenshot({ path: path.join(SHOT_DIR, "split-after-confirm.png") });

  await browser.close();

  console.log("\n========================================");
  if (failures === 0) {
    console.log("拆注功能核对全部通过 ✅  截图: " + SHOT_DIR);
  } else {
    console.error("共有 " + failures + " 项核对失败 ❌");
    process.exitCode = 1;
  }
})().catch((e) => {
  console.error("验证脚本异常：", e);
  process.exit(2);
});
