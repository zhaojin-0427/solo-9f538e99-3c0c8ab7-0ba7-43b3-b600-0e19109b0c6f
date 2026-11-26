/* ============================================================
 * 夜校大字讲义排版台 —— 真实换行测量 + 贪心整行分页引擎
 *
 * 思路：
 * 1. 把纯文本按源码换行切成“源行”，每个字符包成 inline <span>，
 *    [^编号] 包成 <sup class="fn-ref">。字符 span 不改变浏览器
 *    的换行结果（已在 Chromium 实测验证）。
 * 2. 在与真实 A5 页同宽同样式的离屏测量台里，读取每个字符 span
 *    的 getBoundingClientRect().top，按行聚类，得到浏览器真实
 *    排出的“视觉整行”，并确定每行包含哪些脚注编号。
 * 3. 逐页贪心：按顺序逐行加入，每次都真实渲染“正文行 + 本页
 *    去重后的脚注 + 页脚”，测量自适应高度是否超过 A5。一旦加
 *    下一行超高，当前页即为能放入最多连续整行的一页。
 * 4. 空白页也放不下的行 → 记为阻断问题，UI 标红并停用打印。
 * 5. 预览 / 打印是同一批 .page DOM，打印 CSS 只隐藏编辑区，
 *    因此打印分页与预览天然一致。
 * ============================================================ */

(function () {
  "use strict";

  /** 脚注标记：[^1]、[^note-a] 等，编号不含 ] 与换行 */
  const REF_SOURCE = "\\[\\^([^\\]\\r\\n]+)\\]";

  /** 高度判定容差（px）。getBoundingClientRect 为浮点，给 1px 余量。 */
  const FIT_TOLERANCE_PX = 1;

  const STORAGE_KEY = "nightschool-handout-v1";

  // ---------------- DOM 句柄 ----------------

  const sourceInput = document.getElementById("source-input");
  const noteFieldsEl = document.getElementById("note-fields");
  const noteEmptyHint = document.getElementById("note-empty-hint");
  const fontSizeInput = document.getElementById("font-size");
  const fontSizeValue = document.getElementById("font-size-value");
  const printBtn = document.getElementById("print-btn");
  const repaginateBtn = document.getElementById("repaginate-btn");
  const loadSampleBtn = document.getElementById("load-sample-btn");
  const clearBtn = document.getElementById("clear-btn");
  const statusPill = document.getElementById("status-pill");
  const pagesEl = document.getElementById("pages");
  const previewEmpty = document.getElementById("preview-empty");
  const issuesCard = document.getElementById("issues-card");
  const issuesList = document.getElementById("issues-list");

  const measurePage = document.getElementById("measure-page");
  const measureBody = document.getElementById("measure-body");
  // 测量时 #measure-body 同时充当“字符化换行镜像”和“试排容器”
  const mirrorBody = measureBody;
  const measureFootnotes = document.getElementById("measure-footnotes");
  const a5Ruler = document.getElementById("a5-ruler");
  const pageTemplate = document.getElementById("tpl-page");

  // ---------------- 示例讲义 ----------------

  const SAMPLE_TEXT = [
    "各位叔叔阿姨晚上好，欢迎来到社区夜校“智能手机实用课”第三讲。今天我们一起练习怎么用手机挂号、看新闻，以及识破常见的诈骗短信。[^1]",
    "",
    "先说说为什么要开这门课。根据统计，我国六十岁以上的网民已经超过一亿五千万，但还有很多长辈在扫码、支付、就医挂号时遇到困难。[^2] 学会这些操作，不是为了赶时髦，而是让日常生活更方便、更安全。",
    "",
    "第一步，我们把字体调大。打开“设置”，找到“显示与亮度”，点“字体大小”，拖动滑块到自己看着清楚的位置。今天讲义也统一用了大字排版，大家翻到哪一页，低头就能在本页底部看到这一页词语的注释。",
    "",
    "第二步，练习线上挂号。打开医院的公众号或者政务服务软件，选择“预约挂号”，再选科室、医生和时间。收到预约成功的短信后，按提示时间到医院，在自助机上取号即可。具体步骤也可以请子女帮忙把流程截图存到相册。[^4]",
    "",
    "第三步，也是最重要的安全课。凡是收到“中奖、退税、涉案、安全账户”这类字眼的短信和电话，一律先停下来，不要转账，不要告诉对方验证码。[^3] 拿不准的时候，先挂断，再打给社区的反诈宣传员，或者直接拨打一一〇核实。",
    "",
    "我们来回顾一下今天的三句话：字小就去设置里调大；挂号认准医院官方渠道；谈到钱和验证码就要格外小心。[^1] 下节课我们学习怎么用手机交水电费和出示公交码，请大家带上手机，提前充好电。",
    "",
    "课后作业：在手机上把字体调到自己最舒服的大小；在家人陪同下完成一次模拟挂号；把班级整理的防骗清单读给一位老朋友听。[^3] 谢谢大家，我们下周三晚上七点再见。[^1]",
  ].join("\n");

  const SAMPLE_NOTES = {
    "1": "工业和信息化部：《互联网应用适老化及无障碍改造专项行动方案》，2020 年。讲义中多处引用同一条文件，同一页只在页底排一次。",
    "2": "中国互联网络信息中心：《第53次中国互联网络发展状况统计报告》，2024 年。",
    "3": "社区夜校智能手机课教研组：《常见养老诈骗话术与应对清单》，2025 年整理，可在班级共享文件夹领取。",
    "4": "参见国务院办公厅：《关于切实解决老年人运用智能技术困难的实施方案》，2020 年。",
  };

  // ---------------- 应用状态 ----------------

  const state = {
    text: SAMPLE_TEXT,
    notes: Object.assign({}, SAMPLE_NOTES),
    fontSizePt: 18,
  };

  /** 最近一次分页结果，供按钮定位与自动化测试读取 */
  let lastResult = null;
  let lastLines = [];
  let lastHorizontalIssues = [];
  let runHandle = 0;

  // ============================================================
  // 持久化
  // ============================================================

  function loadPersisted() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (typeof saved.text === "string") state.text = saved.text;
      if (saved.notes && typeof saved.notes === "object") state.notes = saved.notes;
      const size = Number(saved.fontSizePt);
      if (Number.isFinite(size) && size >= 12 && size <= 32) state.fontSizePt = size;
    } catch (err) {
      console.warn("读取本地草稿失败：", err);
    }
  }

  function persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          text: state.text,
          notes: state.notes,
          fontSizePt: state.fontSizePt,
        })
      );
    } catch (err) {
      console.warn("保存本地草稿失败：", err);
    }
  }

  // ============================================================
  // 解析
  // ============================================================

  /** 脚注编号归一化：去掉编号外侧空白（[^ 1 ] 与 [^1] 视为同一个） */
  function normId(id) {
    return String(id).trim();
  }

  /** 按出现顺序返回正文里引用过的全部脚注编号（去重） */
  function extractIds(text) {
    const re = new RegExp(REF_SOURCE, "g");
    const ids = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const id = normId(m[1]);
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  // ============================================================
  // 第一步：构建字符化测量镜像，并枚举出浏览器真实视觉行
  // ============================================================

  /**
   * 把一条源码行（可能为 ""）字符化后挂到 mirrorBody。
   * 返回对应的 .mblock 元素。
   */
  function buildMirrorBlock(doc, lineText) {
    const block = doc.createElement("div");
    block.className = "mblock";

    const appendChars = (s) => {
      // for...of 按码点遍历，emoji / 扩展字符也不会被拆成代理对
      for (const ch of s) {
        const span = doc.createElement("span");
        span.className = "tok";
        span.textContent = ch;
        block.appendChild(span);
      }
    };

    if (lineText === "") {
      block.dataset.blank = "1";
      appendChars("\u00A0");
      mirrorBody.appendChild(block);
      return block;
    }

    let last = 0;
    const re = new RegExp(REF_SOURCE, "g");
    let m;
    while ((m = re.exec(lineText)) !== null) {
      appendChars(lineText.slice(last, m.index));
      const refId = normId(m[1]);
      const ref = doc.createElement("sup");
      ref.className = "fn-ref";
      ref.dataset.ref = refId;
      ref.textContent = refId;
      block.appendChild(ref);
      last = m.index + m[0].length;
    }
    appendChars(lineText.slice(last));

    mirrorBody.appendChild(block);
    return block;
  }

  /**
   * 读取一个 .mblock，把其中的字符 / 引用按真实纵向位置聚成视觉行。
   * 返回行描述符数组：
   *   { blank, items:[Node...], refIds:[id...], text:string }
   * 注意 items 中保存的是镜像里的原始节点，渲染时 cloneNode。
   */
  function enumerateBlock(block, sourceLine) {
    if (block.dataset.blank === "1") {
      return [
        {
          blank: true,
          items: [],
          refIds: [],
          text: "",
        },
      ];
    }

    const tokNodes = Array.from(block.querySelectorAll(".tok"));
    const bodyCs = getComputedStyle(measureBody);
    const lineHeightPx =
      parseFloat(bodyCs.lineHeight) ||
      parseFloat(bodyCs.fontSize) * 1.4;

    // ---- 由“字符行 top + 块总高”还原完整行带 ----
    // 只按字符 span 聚类会漏掉“整行只有脚注标记”的行，因此用
    // block 高度 / 行高推导真实行数，再按首行 top 算术展开。
    const blockRect = block.getBoundingClientRect();
    let firstTop = null;
    for (const tok of tokNodes) {
      const t = tok.getBoundingClientRect().top;
      if (firstTop === null || t < firstTop) firstTop = t;
    }
    if (firstTop === null) {
      // 整块只有脚注标记：用块顶代替（误差仅半行距，不影响就近归属）
      firstTop = blockRect.top;
    }

    let tokClusterCount = 0;
    let lastClusterTop = null;
    for (const tok of tokNodes) {
      const t = tok.getBoundingClientRect().top;
      if (lastClusterTop === null || Math.abs(t - lastClusterTop) > lineHeightPx * 0.5) {
        tokClusterCount += 1;
        lastClusterTop = t;
      }
    }

    const linesFromHeight = Math.max(1, Math.round(blockRect.height / lineHeightPx));
    const lineCount = Math.max(tokClusterCount, linesFromHeight, 1);

    /** 每个视觉行的参考 top（算术行带） */
    const bandTops = [];
    for (let k = 0; k < lineCount; k++) bandTops.push(firstTop + k * lineHeightPx);

    const nearestBand = (top) => {
      let best = 0;
      let bestDist = Infinity;
      bandTops.forEach((bt, i) => {
        const d = Math.abs(top - bt);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      return best;
    };

    const lines = bandTops.map(() => ({ blank: false, items: [], refIds: [], text: "" }));

    // ---- 按 DOM 顺序把字符与引用放进所属行，保证行内次序 ----
    for (const child of Array.from(block.children)) {
      if (child.classList.contains("tok")) {
        const idx = nearestBand(child.getBoundingClientRect().top);
        lines[idx].items.push(child);
        lines[idx].text += child.textContent;
      } else if (child.classList.contains("fn-ref")) {
        const idx = nearestBand(child.getBoundingClientRect().top);
        lines[idx].items.push(child);
        if (!lines[idx].refIds.includes(child.dataset.ref)) {
          lines[idx].refIds.push(child.dataset.ref);
        }
        lines[idx].text += `[^${child.dataset.ref}]`;
      }
    }

    // 算术行带可能多出“幽灵空行”；没有任何 item 的行带删除。
    // （真正的标记独占行已在上面分到 item，不会被删。）
    void sourceLine;
    return lines.filter((l) => l.items.length > 0 || l.refIds.length > 0);
  }

  /** 完整执行第一步：纯文本 → 有序视觉行描述符 */
  function measureLines(text) {
    measureBody.replaceChildren();
    const sourceLines = text.replace(/\r\n?/g, "\n").split("\n");
    const descriptors = [];
    for (const line of sourceLines) {
      const block = buildMirrorBlock(document, line);
      const visualLines = enumerateBlock(block, line);
      for (const v of visualLines) descriptors.push(v);
    }
    return descriptors;
  }

  // ============================================================
  // 脚注渲染（测量台与真实页共用）
  // ============================================================

  function renderFootnotes(aside, ids) {
    aside.replaceChildren();
    if (!ids || ids.length === 0) {
      aside.classList.remove("has-notes");
      return;
    }
    aside.classList.add("has-notes");

    for (const id of ids) {
      const item = document.createElement("div");
      item.className = "fn-item";
      item.dataset.id = id;

      const marker = document.createElement("span");
      marker.className = "fn-marker";
      marker.textContent = id;

      const p = document.createElement("p");
      p.className = "fn-text";
      const value = state.notes[id] != null ? String(state.notes[id]) : "";
      p.textContent = value;
      if (value.trim() === "") p.classList.add("is-empty");

      item.appendChild(marker);
      item.appendChild(p);
      aside.appendChild(item);
    }
  }

  // ============================================================
  // 第二步：构造单行 DOM + 试排测高 + 贪心分页
  // ============================================================

  function buildLineElement(desc, globalIndex) {
    const lineEl = document.createElement("div");
    lineEl.className = "body-line" + (desc.blank ? " is-blank" : "");
    lineEl.dataset.lineIndex = String(globalIndex);

    if (desc.blank || desc.items.length === 0) {
      lineEl.textContent = "\u00A0";
      return lineEl;
    }
    for (const node of desc.items) {
      lineEl.appendChild(node.cloneNode(true));
    }
    return lineEl;
  }

  /**
   * 试排：把 lines[start..end) 放进测量页，脚注用 refIds，
   * 返回测量页 border-box 高度（px，自适应高度 = 所需最小高度）。
   */
  function trialHeight(lines, start, end, refIds) {
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      frag.appendChild(buildLineElement(lines[i], i));
    }
    measureBody.replaceChildren(frag);
    renderFootnotes(measureFootnotes, refIds);
    return measurePage.getBoundingClientRect().height;
  }

  function unionIds(a, b) {
    const out = a.slice();
    for (const id of b) if (!out.includes(id)) out.push(id);
    return out;
  }

  /** A5 纸高（px），每次分页重新读，防止字号 / 缩放变化 */
  function a5HeightPx() {
    return a5Ruler.getBoundingClientRect().height;
  }

  /**
   * 贪心分页。
   * 返回 { pages, issues }：
   *  page = { start, end, refOrder, invalidLine? }
   *  issue = { type:"vertical", lineIndex, pageIndex, refIds, heightPx, a5Px }
   */
  function paginate(lines) {
    const a5Px = a5HeightPx();
    const pages = [];
    const issues = [];

    let i = 0;
    while (i < lines.length) {
      const refOrder = [];
      let end = i;
      let reject = null;
      let acceptedHeightPx = null;

      // 逐行加入；高度关于“加入的行 / 脚注集合”单调不减，
      // 所以第一次失败处就是本页可容纳的最大连续前缀。
      while (end < lines.length) {
        const candidateIds = unionIds(refOrder, lines[end].refIds);
        const h = trialHeight(lines, i, end + 1, candidateIds);

        if (h <= a5Px + FIT_TOLERANCE_PX) {
          acceptedHeightPx = h;
          for (const id of lines[end].refIds) {
            if (!refOrder.includes(id)) refOrder.push(id);
          }
          end += 1;
        } else {
          reject = { index: end, heightPx: h, candidateIds: candidateIds.slice() };
          break;
        }
      }

      if (end === i) {
        // 连第一行（连同它引用的脚注）在空白 A5 页都超高
        const badIds = reject ? reject.candidateIds : lines[i].refIds.slice();
        const pageIndex = pages.length;
        issues.push({
          type: "vertical",
          lineIndex: i,
          pageIndex,
          refIds: badIds,
          heightPx: reject ? reject.heightPx : null,
          a5Px,
        });
        pages.push({
          start: i,
          end: i + 1,
          refOrder: badIds,
          invalidLine: i,
          rejectHeightPx: reject ? reject.heightPx : null,
        });
        i += 1;
      } else {
        pages.push({
          start: i,
          end,
          refOrder: refOrder.slice(),
          acceptedHeightPx,
          rejectHeightPx: reject ? reject.heightPx : null,
        });
        i = end;
      }
    }

    return { pages, issues, a5Px };
  }

  // ============================================================
  // 第三步：把分页结果渲染成真实 A5 页
  // ============================================================

  function renderPages(lines, result) {
    pagesEl.replaceChildren();
    const frag = document.createDocumentFragment();

    result.pages.forEach((page, pageIndex) => {
      const node = pageTemplate.content.firstElementChild.cloneNode(true);
      node.dataset.pageIndex = String(pageIndex);

      const body = node.querySelector(".page-body");
      for (let li = page.start; li < page.end; li++) {
        body.appendChild(buildLineElement(lines[li], li));
      }

      renderFootnotes(node.querySelector(".page-footnotes"), page.refOrder);
      node.querySelector(".page-num").textContent = String(pageIndex + 1);

      if (page.invalidLine != null) {
        node.classList.add("is-invalid");
        const warn = document.createElement("div");
        warn.className = "page-warning";
        warn.textContent = "⚠ 这一行连同它引用的脚注，即使单独放在空白 A5 页也排不下；打印已停用。";
        node.insertBefore(warn, body);
        const bad = body.querySelector('[data-line-index="' + page.invalidLine + '"]');
        if (bad) bad.classList.add("line-bad");
      }

      frag.appendChild(node);
    });

    pagesEl.appendChild(frag);
  }

  /**
   * 渲染后检查每一行是否有横向溢出（正常情况下不会；
   * 一旦出现说明切分 / 超长 token 有问题或打印会被裁切）。
   */
  function detectHorizontalOverflow() {
    const found = [];
    const lineEls = pagesEl.querySelectorAll(".body-line");
    lineEls.forEach((el) => {
      // +2px 容忍亚像素取整
      if (el.scrollWidth > el.clientWidth + 2) {
        found.push({
          type: "horizontal",
          lineIndex: Number(el.dataset.lineIndex),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        });
      }
    });
    return found;
  }

  // ============================================================
  // 脚注输入框列表
  // ============================================================

  let renderedIdSignature = "";

  function renderNoteFields(ids) {
    const signature = ids.join("|");
    noteEmptyHint.hidden = ids.length !== 0;
    if (signature === renderedIdSignature) return;
    renderedIdSignature = signature;

    noteFieldsEl.replaceChildren();

    for (const id of ids) {
      const wrap = document.createElement("div");
      wrap.className = "note-field";
      wrap.dataset.id = id;

      const head = document.createElement("div");
      head.className = "note-field-head";
      const badge = document.createElement("span");
      badge.className = "note-badge";
      badge.textContent = id;
      head.appendChild(badge);

      const missing = document.createElement("span");
      missing.className = "note-missing-tag";
      missing.textContent = "尚未填写内容";
      missing.hidden = (state.notes[id] || "").trim() !== "";
      head.appendChild(missing);
      wrap.appendChild(head);

      const ta = document.createElement("textarea");
      ta.value = state.notes[id] || "";
      ta.rows = 2;
      ta.setAttribute("aria-label", "脚注 " + id + " 的内容");
      ta.placeholder = "填写编号 " + id + " 对应的脚注全文…";
      ta.addEventListener("input", () => {
        state.notes[id] = ta.value;
        wrap.classList.toggle("is-missing", ta.value.trim() === "");
        missing.hidden = ta.value.trim() !== "";
        scheduleRun();
        persist();
      });
      wrap.classList.toggle("is-missing", ta.value.trim() === "");

      wrap.appendChild(ta);
      noteFieldsEl.appendChild(wrap);
    }
  }

  // ============================================================
  // 问题面板 / 状态条
  // ============================================================

  function linePreviewText(idx) {
    const l = lastLines[idx];
    if (!l) return "";
    const t = (l.text || "").trim();
    return t.length > 80 ? t.slice(0, 80) + "…" : t;
  }

  function renderIssues(result, horizontal, missingIds) {
    issuesList.replaceChildren();
    const totalBlocking = result.issues.length + horizontal.length;

    if (totalBlocking === 0 && missingIds.length === 0) {
      issuesCard.hidden = true;
      return;
    }
    issuesCard.hidden = false;

    for (const issue of result.issues) {
      const box = document.createElement("div");
      box.className = "issue-item";
      const ids = issue.refIds.length ? "（脚注 " + issue.refIds.map((x) => "[" + x + "]").join("、") + "）" : "";
      box.appendChild(
        document.createTextNode(
          "第 " + (issue.lineIndex + 1) + " 个正文整行连同其脚注" + ids +
          "，即使单独放在空白 A5 页也排不下。请调小正文字号，或缩短对应脚注。"
        )
      );
      const preview = document.createElement("span");
      preview.className = "issue-line-text";
      preview.textContent = linePreviewText(issue.lineIndex) || "（空白行）";
      box.appendChild(preview);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "在预览中标出 →";
      btn.addEventListener("click", () => locateLine(issue.lineIndex));
      box.appendChild(document.createElement("br"));
      box.appendChild(btn);
      issuesList.appendChild(box);
    }

    for (const h of horizontal) {
      const box = document.createElement("div");
      box.className = "issue-item";
      box.appendChild(
        document.createTextNode(
          "第 " + (h.lineIndex + 1) + " 个正文整行宽于 A5 正文区（可能含过长的英文词或网址），打印可能被裁切。"
        )
      );
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "在预览中标出 →";
      btn.addEventListener("click", () => locateLine(h.lineIndex));
      box.appendChild(btn);
      issuesList.appendChild(box);
    }

    for (const id of missingIds) {
      const w = document.createElement("div");
      w.className = "warn-item";
      w.textContent = "脚注 [" + id + "] 已在正文引用，但还没有填写内容；预览与打印中会显示“未填写”提示。";
      issuesList.appendChild(w);
    }
  }

  function locateLine(lineIndex) {
    const el = pagesEl.querySelector('[data-line-index="' + lineIndex + '"]');
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.animate(
      [{ boxShadow: "0 0 0 0 rgba(192,57,43,0.7)" }, { boxShadow: "0 0 0 6px rgba(192,57,43,0)" }],
      { duration: 900, iterations: 2 }
    );
  }

  function renderStatus(result, horizontal, missingIds) {
    const pageCount = result.pages.length;
    const blocking = result.issues.length + horizontal.length;
    const blocked = blocking > 0 || pageCount === 0;

    printBtn.disabled = blocked;
    // 让 Ctrl/Cmd+P 与浏览器菜单打印也只能得到“已停用”说明页
    document.body.classList.toggle("print-blocked", blocking > 0);

    statusPill.classList.remove("is-error", "is-ok");
    if (pageCount === 0) {
      statusPill.textContent = "没有可排版的正文";
      return;
    }
    if (blocking > 0) {
      statusPill.classList.add("is-error");
      statusPill.textContent =
        "共 " + pageCount + " 页 · " + blocking + " 行排不下，打印已停用";
      return;
    }
    statusPill.classList.add("is-ok");
    statusPill.textContent =
      "共 " + pageCount + " 页 · " + lastLines.length + " 个整行" +
      (missingIds.length ? " · " + missingIds.length + " 条脚注未填" : " · 可打印");
  }

  // ============================================================
  // 主流程
  // ============================================================

  function runNow() {
    window.clearTimeout(runHandle);

    const ids = extractIds(state.text);
    renderNoteFields(ids);

    const hasText = state.text.trim() !== "";
    previewEmpty.hidden = hasText;
    pagesEl.hidden = !hasText;

    if (!hasText) {
      lastLines = [];
      lastResult = { pages: [], issues: [], a5Px: a5HeightPx() };
      lastHorizontalIssues = [];
      pagesEl.replaceChildren();
      issuesCard.hidden = true;
      printBtn.disabled = true;
      document.body.classList.remove("print-blocked");
      statusPill.classList.remove("is-ok", "is-error");
      statusPill.textContent = "请输入讲义内容";
      emitDebug();
      return;
    }

    // 1) 真实换行测量
    const lines = measureLines(state.text);
    lastLines = lines;

    // 2) 贪心分页（测量台试排）
    const result = paginate(lines);
    lastResult = result;

    // 3) 渲染真实页
    renderPages(lines, result);

    // 4) 横向溢出检查
    lastHorizontalIssues = detectHorizontalOverflow();

    const missingIds = ids.filter((id) => (state.notes[id] || "").trim() === "");
    renderIssues(result, lastHorizontalIssues, missingIds);
    renderStatus(result, lastHorizontalIssues, missingIds);

    emitDebug({ ids, missingIds });
  }

  function scheduleRun() {
    window.clearTimeout(runHandle);
    runHandle = window.setTimeout(() => {
      try {
        runNow();
      } catch (err) {
        console.error("分页失败：", err);
        statusPill.classList.remove("is-ok");
        statusPill.classList.add("is-error");
        statusPill.textContent = "分页脚本出错：" + err.message;
      }
    }, 120);
  }

  function emitDebug(extra) {
    const debug = {
      ranAt: new Date().toISOString(),
      lineCount: lastLines.length,
      pageCount: lastResult ? lastResult.pages.length : 0,
      a5HeightPx: lastResult ? Math.round(lastResult.a5Px * 100) / 100 : null,
      verticalIssues: lastResult ? lastResult.issues : [],
      horizontalIssues: lastHorizontalIssues,
      pages: lastResult
        ? lastResult.pages.map((p, i) => ({
            page: i + 1,
            startLine: p.start + 1,
            endLine: p.end,
            lineCount: p.end - p.start,
            footnoteIds: p.refOrder.slice(),
            invalidLine: p.invalidLine != null ? p.invalidLine + 1 : null,
            acceptedHeightPx: p.acceptedHeightPx != null ? Math.round(p.acceptedHeightPx * 100) / 100 : null,
            rejectHeightPx: p.rejectHeightPx != null ? Math.round(p.rejectHeightPx * 100) / 100 : null,
          }))
        : [],
      ...(extra || {}),
    };
    window.__paginationDebug = debug;
    document.dispatchEvent(new CustomEvent("pagination:done", { detail: debug }));
  }

  // ============================================================
  // 控件事件
  // ============================================================

  sourceInput.addEventListener("input", () => {
    state.text = sourceInput.value;
    scheduleRun();
    persist();
  });

  fontSizeInput.addEventListener("input", () => {
    const size = Number(fontSizeInput.value);
    state.fontSizePt = size;
    fontSizeValue.textContent = size + " pt";
    document.documentElement.style.setProperty("--body-size", size + "pt");
    updateChips(size);
    scheduleRun();
    persist();
  });

  function updateChips(size) {
    document.querySelectorAll(".chip[data-size]").forEach((chip) => {
      chip.classList.toggle("is-active", Number(chip.dataset.size) === size);
    });
  }

  document.querySelectorAll(".chip[data-size]").forEach((chip) => {
    chip.addEventListener("click", () => {
      fontSizeInput.value = chip.dataset.size;
      fontSizeInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });

  repaginateBtn.addEventListener("click", () => runNow());

  printBtn.addEventListener("click", () => {
    if (printBtn.disabled) return;
    window.print();
  });

  // 阻断状态下拦截 Ctrl/Cmd+P（浏览器菜单打印由 print-blocked 样式兜底）
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "p" || e.key === "P")) {
      if (document.body.classList.contains("print-blocked")) {
        e.preventDefault();
        statusPill.classList.add("is-error");
        statusPill.textContent = "存在排不下的超限行，打印已停用；请先调小字号或缩短脚注";
      }
    }
  });

  loadSampleBtn.addEventListener("click", () => {
    state.text = SAMPLE_TEXT;
    state.notes = Object.assign({}, SAMPLE_NOTES);
    sourceInput.value = state.text;
    renderedIdSignature = ""; // 强制重建脚注输入框
    runNow();
    persist();
  });

  clearBtn.addEventListener("click", () => {
    state.text = "";
    sourceInput.value = "";
    scheduleRun();
    persist();
    sourceInput.focus();
  });

  // 字体晚到（如系统字体异步加载）后重排一次
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => scheduleRun());
  }
  window.addEventListener("load", () => scheduleRun());

  // ============================================================
  // 启动
  // ============================================================

  loadPersisted();
  sourceInput.value = state.text;
  fontSizeInput.value = String(state.fontSizePt);
  fontSizeValue.textContent = state.fontSizePt + " pt";
  document.documentElement.style.setProperty("--body-size", state.fontSizePt + "pt");
  updateChips(state.fontSizePt);

  // 暴露给自动化测试 / 控制台
  window.__paginateApp = {
    runNow,
    scheduleRun,
    state,
    getLastResult: () => lastResult,
    getLines: () => lastLines,
  };

  runNow();
})();
