---
name: script-format-check
description: 剧本上传的「先校验格式、再统计字数」流程。用户上传/修改/检查剧本 docx、问"格式哪里错了"、要自动修复或导出标准格式、或在统计字数前需要确认格式合规时使用。
---

# 剧本格式校验 → 修复 → 统计

**铁律：格式不通过，不统计字数。** 校验通过后才调用 `analyzeParagraphs` 出字数。

## 标准（以 `lib/format/reference.docx` 为准）

```
《剧名》                          ← 书名号，居中大标题
故事梗概   短剧类型/目标受众/题材类型/核心设定/风格元素/世界观/核心亮点/核心梗概/人物目标/核心阻碍（全角冒号，人物目标可空）
人物小传   姓名：…（其后字段依次：年龄 定位 性别 性格 背景 外貌 标志性动作 随身物件与规则 人物行动线）
分集大纲·粗纲 / 分集大纲·集纲   不参与统计，只归类展示
正文内容
  第N集                          ← 单独成行，不带标题
  N-M 时间 内/外 地点             ← 集号必须等于当前集，M 从 1 连续递增
  人物：甲 乙 丙                  ← 紧跟场次头下一行，每场一行
  △动作     角色（情绪）：台词
```

只有「剧名、故事梗概、人物小传、正文内容」缺失/错误算**错误**；粗纲/集纲条数与正文是否一致**不检查**（参考稿本身就是 10 集纲 / 3 集正文）。

## 程序调用

```js
const f = require('./lib/format');
f.validateBuffer(buf, 'x.docx')      // → { format:{ok,errors,warns,fixable,issues,blocks}, paragraphs, analysis? }  ok 才有 analysis
f.validateParagraphs(paras)          // 手改后重验（同上）
f.fixParagraphs(paras)               // 反复「校验→应用可修复项」直到稳定（≤8 轮），返回 {…, applied}
f.exportDocx(paras)                  // Buffer，沿用参考稿样式表；传入必须已通过校验
```

HTTP（需登录）：`POST /api/validate`（原文件，头 `X-Filename`）、`/api/recheck`、`/api/fix`、`/api/export`（JSON `{name, paragraphs}`；export 未通过返回 422）。页面：`/type`。

issue 结构：`{id, level:'error'|'warn', code, para, message, fixable, fix?:{op:'set'|'insertBefore'|'delete', text?}}`。`para` 是逻辑段落下标（读入时已去空行、并合并软换行）。

## 验证流程（改规则后必须全跑）

1. `npm test`（含 `test/format.test.js`：参考稿 0 问题、每种错误能被检出、可修复项修后通过、导出版式与参考稿逐段一致）
2. `node scripts/check-dir.js lib/format/reference.docx <错误剧本目录>` 看每本的错误数；参考稿必须 PASS
3. 对每本错误剧本：`fixParagraphs` → 剩余错误应只是真正需要人判断的（缺章节、缺字段、缺人物行等）；通过后 `exportDocx` → 再 `validateBuffer` 必须 `ok` 且各集字数不变

## 新增规则的方法

1. 先拿真实错误稿复现，确认不是规则过严（参考稿必须仍 0 问题）
2. 在 `lib/format/check.js` 加检测；能确定唯一正确答案的给 `fix`，否则只报错
3. 在 `test/format.test.js` 用参考稿改一行造负样本，断言 code
4. 能自动改的，断言 `autoFix` 后 `report.ok`

## 已知需人工处理（不自动修）

缺章节/字段（如无「故事梗概」字段、无「姓名：」）、场次缺「人物：」、「人物：」不在场次头下一行（被【字幕】等隔开）、集号缺失、`内/外` 以外的场次头写法（如「同上场景」）。
