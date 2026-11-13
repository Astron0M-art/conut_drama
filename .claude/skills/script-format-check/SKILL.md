---
name: script-format-check
description: 剧本上传的「先校验格式、再统计字数」流程。用户上传/修改/检查剧本 docx、问"格式哪里错了"、要自动修复或导出标准格式、或在统计字数前需要确认格式合规时使用。
---

# 剧本格式校验 → 修复 → 统计

**铁律：格式不通过，不统计字数。** 校验通过后才调用 `analyzeParagraphs` 出字数。

## 目标（只为统计字数）

格式校验只回答一件事：**能不能确定每一集的正文并统计**。字数只统计「正文内容」标题之后的部分，
梗概、人物小传、粗纲、集纲写成什么样都不管。

**错误（拦截统计）**——都是会让分集出错的：
- 找不到「正文内容」标题（别名：剧本正文/正文/剧本内容）或重复出现
- 正文里没有任何「第N集」/「N-M」场次
- 场次头出现但缺少对应的「第N集」标题（如写了 21-1 却没有第21集标题），可一键补标题
- 场次集号与所在集不一致（如第21集下写成 2-1、0-1、3-1），可一键改正
- 缺集、集号重复、集号倒退、某集下没有任何内容

**一律放过（无提示）**：场次头写法（ICU 括号、内/外合写…）、场次号不连续、集标题带标题、半角冒号、
`△` 后空格、缺「人物：」行、未识别行、`【闪回】`、独立成行的 `（中：…）` 译文、梗概/人物小传/大纲格式。

参考稿（`lib/format/reference.docx`）仍是「导出标准 docx」的版式依据。

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

## 需人工处理（不自动修）

缺「正文内容」标题、缺集、集下无内容、集号对不上又无法唯一判断的场次。
