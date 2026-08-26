---
name: html-report
description: '构建自包含的 HTML 报告与仪表板交付物（图表、数据表、KPI 卡片）。当用户要求"做一份 HTML 汇报/报告/看板/dashboard"，或要求把 ACR、GTM、财务、运营等分析结果输出为网页时使用。涵盖 ECharts 图表内联、真实数据嵌入、渲染沙箱约束。触发词包括：HTML 报告、HTML 汇报、网页报告、dashboard、看板、可视化、图表、echarts、chart、visualize、报表页面。'
license: Internal Microsoft use only
---

# HTML Report

把分析结果输出为**单个自包含 HTML 文件**，可在交付物预览窗中直接渲染，也可下载
后离线打开或转发。

## 1. 渲染契约

交付的 HTML 在沙箱中渲染。先读懂约束，再写代码 —— 违反其中任何一条，页面都会
空白或缺图，而**不会**报错：

| 允许 | 不允许 |
| --- | --- |
| 页面内 `<script>`（内联脚本） | 外部脚本：CDN、`src="https://..."` |
| 内联 `<style>` 与 `style=` | 外部样式表、外部字体 |
| `data:` / `blob:` 图片 | 远程图片、`fetch`、`XMLHttpRequest` |
| 全部数据写死在页面里 | 运行时去任何地方取数据 |

页面**没有网络**。这是刻意的：能取数据的页面也能把它正在展示的内容发出去，而
报告里往往是内部数据。因此库和数据都必须随文件一起走。

不要引用 `https://cdn.jsdelivr.net/npm/echarts`、`unpkg.com` 或任何外链 —— 那是
页面空白最常见的原因。

## 2. 内联图表库

ECharts 已随镜像提供，路径在环境变量 `DIGIBUDDY_VENDOR_ROOT` 下：

```
$DIGIBUDDY_VENDOR_ROOT/echarts.min.js
```

用脚本把它读进来拼进页面，**不要**手工粘贴，也不要凭记忆重写库：

```python
import os
from pathlib import Path

vendor = Path(os.environ.get("DIGIBUDDY_VENDOR_ROOT", "/opt/digibuddy/vendor"))
echarts = (vendor / "echarts.min.js").read_text(encoding="utf-8")
html = TEMPLATE.replace("/*ECHARTS*/", echarts).replace("/*DATA*/", payload_json)
Path("deliverables/gcr_fy27_july_acr.html").write_text(html, encoding="utf-8")
```

用 `replace` 而不是 f-string 或 `%` 格式化：库里全是 `{`、`}` 和 `%`，格式化会
把它绞碎。

如果 `DIGIBUDDY_VENDOR_ROOT` 下没有需要的库，直接说明，然后退回纯 HTML/CSS 表格
和条形图（用 `<div>` 宽度百分比即可做出可读的条形）。不要因此交付空页面。

## 3. 数据必须是真的

报告最常见的失败不是难看，而是**没有内容**：只有骨架、占位符、`TODO`、示例数字
或"数据待补充"。这种交付物没有价值，且用户往往要点开预览才发现。

- 页面里的每个数字都来自本次会话真实取到的数据。取不到就不做这个图，并在页面
  上写明缺什么。
- 把数据作为一个 JSON 对象嵌进页面，图表从它读取；不要把数字散落在各处 HTML 里，
  那样无法核对。
- 报告至少包含：标题与口径说明（时间范围、维度定义、数据来源与发布版本）、
  关键结论、支撑图表、明细数据表。
- 保留对账信息。若存在未映射/未分类金额，必须在页面上显示其金额与占比，不要
  只显示能对上的部分。
- 交付前**自己检查一遍**：`grep` 页面里有没有 `TODO`、`占位`、`示例`、`lorem`、
  `NaN`、`undefined`；确认数据对象非空；确认每个 `setOption` 都拿到了非空数组。

## 4. 脚本必须能跑起来

页面的骨架是 HTML，内容是脚本注入的。所以脚本一旦没跑起来，用户看到的正是本节
要防的那种交付物：标题、卡片边框、表头都在，里面全是空的 —— 而且**控制台之外
没有任何提示**。

**把整段渲染脚本包进 IIFE。**

```html
<script>/*ECHARTS*/</script>
<script>
(function () {
  const DATA = /*DATA*/;
  // ... 所有渲染代码写在这里
})();
</script>
```

这一条不是风格问题。脚本的顶层就是全局作用域，`window` 上已经有一批同名属性，
顶层的 `const`/`let` 撞上它们会直接抛 `SyntaxError: Identifier 'x' has already
been declared`。这个错误发生在**整块脚本执行之前**，所以撞名那行之前的代码也
一行都不会跑，页面完全空白。真实事故：一份 43 行数据齐备的报告，因为写了
`const top = rows.slice(0, 15)` 而整页空白 —— `top` 是 `window.top`。

同类地雷（顶层不可用作 `const`/`let`/`function` 名）：

```
top  name  status  length  self  parent  frames  closed  origin  location
history  navigator  screen  event  external  menubar  toolbar  personalbar
```

包进 IIFE 后这些名字在函数作用域内都是安全的，无需逐个记忆；这正是要用 IIFE 而
不是靠改名的原因。

交付前用 `node --check` 之类的语法检查是**不够的**：`top` 冲突只在浏览器全局
作用域才出现，函数作用域里的同一段代码完全合法。所以靠的是 IIFE，不是检查。

## 5. 骨架

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>GCR FY27-Jul ACR 汇报</title>
<style>
  body { margin:0; padding:24px; background:#f5f6f8;
         font-family:'Segoe UI','Microsoft YaHei',sans-serif; color:#1b1b1b; }
  h1 { font-size:22px; margin:0 0 4px; }
  .caption { color:#5c5c5c; font-size:13px; margin-bottom:20px; }
  .cards { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:20px; }
  .card { background:#fff; border-radius:8px; padding:14px 18px; min-width:160px;
          box-shadow:0 1px 3px rgba(0,0,0,.08); }
  .card .k { color:#5c5c5c; font-size:12px; }
  .card .v { font-size:22px; font-weight:600; margin-top:4px; }
  .chart { background:#fff; border-radius:8px; height:360px; margin-bottom:20px;
           box-shadow:0 1px 3px rgba(0,0,0,.08); }
  table { background:#fff; border-collapse:collapse; width:100%; font-size:13px; }
  th, td { padding:8px 12px; border-bottom:1px solid #eaeaea; text-align:left; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
</style>
</head>
<body>
<h1>GCR FY27-Jul ACR 汇报</h1>
<div class="caption">口径：Strategic Pillar = Commercial AI / Non-AI ｜ 数据来源：finhub-asia-acr，release FY27-Jul</div>
<div class="cards" id="cards"></div>
<div class="chart" id="pillar"></div>
<table id="detail"></table>

<script>/*ECHARTS*/</script>
<script>
(function () {

const DATA = /*DATA*/;

document.getElementById('cards').innerHTML = DATA.kpis
  .map(k => `<div class="card"><div class="k">${k.label}</div><div class="v">${k.value}</div></div>`)
  .join('');

echarts.init(document.getElementById('pillar')).setOption({
  title: { text: 'ACR by Strategic Pillar', left: 12, top: 10,
           textStyle: { fontSize: 14 } },
  textStyle: { fontFamily: "'Segoe UI','Microsoft YaHei',sans-serif" },
  tooltip: { trigger: 'item', formatter: '{b}: ${c}M ({d}%)' },
  legend: { bottom: 10 },
  series: [{ type: 'pie', radius: ['45%', '68%'], data: DATA.pillars }]
});

document.getElementById('detail').innerHTML =
  '<tr>' + DATA.columns.map(c => `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('') + '</tr>' +
  DATA.rows.map(r => '<tr>' + r.map((v, i) =>
    `<td class="${DATA.columns[i].num ? 'num' : ''}">${v}</td>`).join('') + '</tr>').join('');

})();
</script>
</body>
</html>
```

对应的 `DATA` 形如：

```json
{
  "kpis": [
    { "label": "GCR ACR", "value": "$487.4M" },
    { "label": "Commercial AI", "value": "$282.9M (58.0%)" },
    { "label": "Sales Unit 未映射", "value": "$34.6M (7.1%)" }
  ],
  "pillars": [
    { "name": "Commercial AI", "value": 282.9 },
    { "name": "Non-AI", "value": 204.5 }
  ],
  "columns": [{ "label": "Sales Unit" }, { "label": "ACR ($M)", "num": true }],
  "rows": [["GCR.DN.EHG", "351.0"]]
}
```

## 6. 中文与货币

- 字体栈里必须有 `'Microsoft YaHei'`，否则中文在部分环境下会退回默认衬线字体。
- ECharts 的 `textStyle.fontFamily` 同样设为 `'Segoe UI','Microsoft YaHei',sans-serif`。
- 金额统一单位并在口径行写明（如"单位：$M"），不要在同一张表里混用 `$487.4M`
  和 `487400000`。

## 7. 交付

- 写到 `deliverables/`，文件名可读（`gcr_fy27_july_acr.html`，不要 UUID）。
- 一次交付一个文件。图表、数据、样式全在里面 —— 不要产出配套的 `.js`、`.css`
  或数据文件，它们不会随预览一起加载。
- 在回复中说明文件名、口径和关键结论；不要只丢一个文件名。

## 8. 不适用的东西

- **Express、Vite、Next 等服务端或构建框架用不上。** 交付物是一个静态文件，在无
  网络的沙箱里打开，没有进程为它服务。不要生成 `package.json`、`server.js`，也
  不要要求用户 `npm install`。
- **不要生成需要构建步骤的产物。** 用户拿到的就是最终文件。
