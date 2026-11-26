# 夜校大字讲义排版台（Flask + A5 脚注分页）

社区夜校用的大字讲义排版页：老师粘贴带 `[^编号]` 的纯文本、填写脚注、选择正文字号，
即可预览 **A5（148mm × 210mm）** 版面。系统按**浏览器真实换行**测量，在“正文 + 本页脚注
都放得下”的前提下，为每一页排入**最多的连续正文整行**；页底完整排出本页引用的脚注，
**同一注号在同一页只排一次**，同一注号跨页时则在每个引用页分别排出。

- 后端：Flask 3（只负责提供页面/静态资源，排版全部在浏览器完成）
- 前端：原生 HTML/CSS/JS，无构建步骤、无前端依赖
- 部署：Docker Compose（gunicorn）

---

## 一、快速开始

### 方式 A：Docker Compose（推荐）

```bash
docker compose up --build
```

打开 <http://localhost:8000>。

### 方式 B：本地 Python 直接运行

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python app.py           # http://127.0.0.1:8000
```

或用 gunicorn（与容器入口一致）：

```bash
gunicorn --bind 0.0.0.0:8000 --workers 2 --threads 4 app:app
```

---

## 二、使用说明

1. 在 **① 讲义正文** 粘贴纯文本，脚注位置写成 `[^1]`、`[^note-a]` 等（编号不含 `]` 和换行；
   `[^ 1 ]` 会自动归一化为 `1`）。源码换行会被保留，空行作为段间空行。
2. **② 填写脚注** 中会按编号首次出现顺序自动出现输入框，逐条填写。
3. 在 **③ 正文字号** 拖动滑块（14–28 pt）或点常用字号；每次改动都会重新测量、重新分页。
4. 右侧即 A5 预览。顶部状态条显示总页数 / 整行数 / 问题数。
5. 点 **打印 / 另存 PDF**，在打印对话框把缩放设为 **100% / 实际大小**（纸张已由
   `@page { size: A5; margin: 0 }` 指定为 A5）。

草稿会自动保存在浏览器 `localStorage`，刷新不丢；“载入示例讲义”可随时恢复内置示例。

---

## 三、排版/分页原理（`static/js/paginate.js`）

所有判断都基于浏览器真实布局，而不是按字数估算：

1. **字符化镜像**：把每条源码行的每个字符包成 inline `<span class="tok">`，
   `[^id]` 包成 `<sup class="fn-ref">`，放进与真实 A5 页**同宽、同样式**的离屏测量页。
   实测确认：普通 inline 字符 span **不会改变** Chromium 对中文/英文/标点的换行结果
   （见 `tests/verify.cjs` 的设计依据，及开发期对照实验）。
2. **还原视觉整行**：读取每个字符 span 的 `getBoundingClientRect().top`，结合块高与
   `line-height` 还原完整行带（包括“脚注标记恰好独占一行”这种没有字符 span 的行），
   并按 DOM 顺序把字符/引用归入所属行，得到有序的“视觉整行”描述符（含本行引用编号）。
3. **贪心最大前缀**：对每一页从当前行开始逐行加入，每次都真实渲染
   “正文行 + 本页去重后的脚注块 + 页脚”，测量自适应高度的测量页是否超过 A5 纸高。
   高度随行数/脚注集合单调不减，因此**第一次加不下去的位置，就是本页能容纳的最多连续整行**。
4. **超限行**：若某一行单独放在空白 A5 页、带上它引用的全部脚注后仍然超高，
   记为阻断问题：该行加红色斜纹、问题页顶部显示警示条、问题面板可点击定位，
   打印按钮停用；并给 `<body>` 加 `print-blocked`，此时即使按 Ctrl/Cmd+P 或从菜单打印，
   打印样式也只输出一张“打印已停用”说明页，不会输出坏版面。
5. **打印一致性**：打印的就是预览里那批 `.page` DOM，打印 CSS 只隐藏编辑区/测量台，
   不重新排版；每张 `.page` 固定 `148mm × 210mm` 并 `break-after: page`。

---

## 四、自动化核对（Playwright + Chromium）

`tests/verify.cjs` 是端到端核对脚本，会启动真实 Chromium 访问
<http://127.0.0.1:8000>，并调用 Chromium 的 PDF 导出核对打印结果。

```bash
# 1) 先启动服务
pip install -r requirements.txt && python app.py &

# 2) 安装测试依赖（另一个目录或 tests/ 下）
cd tests && npm install
npx playwright install chromium

# 3) 运行
node verify.cjs
# 可选环境变量：BASE_URL、SHOT_DIR（默认 /tmp/shots）、PDF_PATH
```

### 本次完工前的实测结果（Chromium 159 / Playwright 1.65.1，Linux）

全部 **33 项断言通过**，覆盖：

- 内置示例：4 页 / 42 个视觉整行（18 pt），无纵向/横向溢出；
- **每页 DOM 审计**：页底脚注编号序列 == 该页正文引用“去重并按首次出现排序”的序列；
  同一页脚注无重复；
- **连续性**：各页 `[startLine, endLine]` 首尾相接、不重不漏覆盖全部整行；
- **最大性**：每个正常页采纳高度 ≤ A5，而加入首个被拒行后的试排高度 > A5；
- **同号跨页讲义**：专门构造 46 段、每段带 `[^1]` 的讲义，18 pt 下排成 13 页，
  编号 `1` 在全部 13 页页底各出现且仅出现一次；对应 PDF 也是 13 页；
- **超限行**：构造约 1600 字的脚注，使一行 + 脚注超过整页 → 报告 1 个纵向问题、
  打印按钮禁用、1 张标红问题页、问题面板有条目；阻断状态导出的 PDF 只有 1 页停用说明；
  把脚注缩短后问题消失、打印恢复；
- **改字号重排**：同一讲义 14 pt=3 页、18 pt=4 页、28 pt=9 页，页数随字号单调变化，
  14/28 pt 均无横向溢出；
- **打印一致**：`emulateMedia('print')` 下所有 `.page` 无溢出、测量台与顶栏被隐藏；
  示例导出 PDF 为 4 页、A5 尺寸（约 419.5×595.3 pt），与预览完全一致；
- **同页重复编号**：`[^7]…[^7]…[^ 7 ]` 在同一页有 3 个正文标记，页底只有 1 条脚注；
- **窄屏 390 px**：布局堆叠，document 无横向溢出（A5 在预览区内部滚动）。

截图保存在 `/tmp/shots`（`sample-page1.png`、`cross-boundary-b.png`、
`invalid-line.png`、`ui-overview.png`、`mobile-390.png` 等），导出的 PDF 在
`/tmp/handout.pdf`、`/tmp/cross-handout.pdf`、`/tmp/blocked.pdf`。
`tests/artifacts/` 内存有本次实测的一份副本（截图 + 三个 PDF），可直接打开核对。

> 开发环境是精简 Linux，缺少 Chromium 运行库且无 root，实测时通过下载 deb 包到
> `/tmp/sysroot` 并设置
> `LD_LIBRARY_PATH=/tmp/sysroot/usr/lib/x86_64-linux-gnu:/tmp/sysroot/lib/x86_64-linux-gnu`
> 运行；标准 Debian/Ubuntu 上用 `npx playwright install --with-deps chromium` 即可。

---

## 五、目录结构

```
/workspace
├── app.py                 # Flask 入口（/ 与 /api/health）
├── requirements.txt       # Flask + gunicorn
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── templates/
│   └── index.html         # 控制台 + A5 预览 + 离屏测量台 + 页模板
├── static/
│   ├── css/style.css      # A5 几何 / 屏幕布局 / 问题标记 / @page 打印
│   └── js/paginate.js     # 解析、真实换行测量、贪心分页、渲染、状态
└── tests/
    ├── verify.cjs         # Playwright + pdf-lib 端到端核对
    └── package.json
```

---

## 六、尚未覆盖 / 已知边界（如实说明）

1. **本环境没有 Docker 守护进程**，因此 `docker compose up --build` 没有在本机实际构建/启动；
   已做的替代验证：Compose YAML 通过解析、`requirements.txt` 在 venv 安装成功、
   容器所用的 gunicorn 命令实测可启动并返回 200。镜像构建过程本身未实测。
2. 浏览器实测只使用了 **Chromium**；几何 API 与 CSS（flex、mm 单位、`@page`、
   `break-*`）均为现代浏览器标准能力，但 Firefox / Safari 未跑自动化。
3. 打印对话框中需保持缩放为 **100%/实际大小**；若用户手动选“适应页面”，
   驱动/浏览器会整体缩放（这是打印对话框行为，CSS 无法完全强制）。
4. 源码中的单个换行按“强制换行”处理、空行是空行；没有实现 Markdown 的
   “单换行合并为空格”规则——这是为了让粘贴的纯文本所见即所得。
5. 没有实现服务端保存/多讲义管理/导出真正的 PDF 文件（PDF 由浏览器打印生成）；
   草稿仅存浏览器 localStorage。
6. 脚注文本按纯文本处理（`white-space: pre-line` 保留手敲换行），不解析脚注内的 Markdown。
