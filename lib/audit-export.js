'use strict';

const { writeAll } = require('./format/zip');

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const HEADERS = ['剧本名称', '剧本总集数', '超标集', '超标集字数'];
const STATUS_LABELS = {
  pending: '等待统计', queued: '等待统计', loading: '读取中', reading: '读取中',
  validating: '校验中', processing: '处理中', running: '处理中', counting: '统计中',
  failed: '处理失败', error: '处理失败', invalid: '格式校验未通过',
  format_failed: '格式校验未通过', 'format-failed': '格式校验未通过',
  uncounted: '尚未统计', not_counted: '尚未统计',
};

function xmlEscape(value) {
  // XML 1.0 不允许控制字符或未配对代理项；保留正常中文和补充平面字符。
  const valid = Array.from(String(value ?? '')).filter((ch) => {
    const code = ch.codePointAt(0);
    return code === 9 || code === 10 || code === 13
      || (code >= 0x20 && code <= 0xd7ff)
      || (code >= 0xe000 && code <= 0xfffd)
      || (code >= 0x10000 && code <= 0x10ffff);
  }).join('');
  return valid.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function nonnegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function textCell(value, style = 0) {
  return { value: String(value ?? ''), style, numeric: false };
}

function numberCell(value) {
  return { value: nonnegativeNumber(value), style: 2, numeric: true };
}

function bookState(book, issues) {
  // passed 表示聚合结果，而不是单凭空的 badEpisodes 推断整本合格。
  if (book.passed === true) return issues.length ? '字数合格（存在识别提示）' : '全部合格';
  const label = String(book.label || '').trim();
  if (label) return label;
  if (STATUS_LABELS[book.status]) return STATUS_LABELS[book.status];
  return issues.length ? '存在识别提示，需核对' : '尚未统计';
}

function auditRows(summary) {
  const rows = [HEADERS.map((header) => textCell(header, 1))];
  for (const item of Array.isArray(summary.books) ? summary.books : []) {
    const book = item || {};
    const name = String(book.name ?? '未命名剧本');
    const total = nonnegativeNumber(book.totalEpisodes);
    const issues = (Array.isArray(book.issues) ? book.issues : []).filter(Boolean);
    const bad = (Array.isArray(book.badEpisodes) ? book.badEpisodes : []).filter(Boolean);
    const row = (label, count = null) => [textCell(name), numberCell(total), textCell(label), numberCell(count)];
    if (bad.length) {
      for (const episode of bad) {
        const kind = { empty: '空集', short: '字数不足', long: '超过上限' }[episode.kind]
          || String(episode.label || '需核对');
        rows.push(row(`第${episode.no}集（${kind}）`, episode.n));
      }
    } else {
      rows.push(row(bookState(book, issues)));
    }
    for (const issue of issues) {
      const detail = String(issue.text || issue.type || '正文识别异常');
      rows.push(row(`识别提示：${detail}`));
    }
  }
  return rows;
}

function rulesRows(summary, generatedAt) {
  const options = summary.options || {};
  const rows = [
    [textCell('项目', 1), textCell('统计口径', 1)],
    [textCell('生成时间（UTC）'), textCell(generatedAt)],
    [textCell('合格下限（含）'), numberCell(options.min)],
    [textCell('合格上限（含）'), numberCell(options.max)],
    [textCell('计入场次头'), textCell(options.incScene ? '是' : '否')],
    [textCell('计入人物行'), textCell(options.incCast ? '是' : '否')],
    [textCell('计数单位'), textCell('中文剧本使用“字”，英文剧本使用“词”；主表数值使用对应剧本的计数单位。')],
    [textCell('异常集'), textCell('字数不足：低于下限；超过上限：高于上限；空集：正文计数为 0。')],
    [textCell('未完成状态'), textCell('未统计或处理失败的剧本仍保留在主表；未知总集数留空。识别提示需核对，不代表整本审核通过。')],
  ];
  for (const book of Array.isArray(summary.books) ? summary.books : []) {
    if (!book) continue;
    rows.push([textCell(`剧本单位：${book.name ?? '未命名剧本'}`), textCell(book.unit === '词' ? '词' : '字')]);
  }
  return rows;
}

function columnName(index) {
  let name = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}

function worksheet(rows, widths) {
  const lastColumn = columnName(widths.length - 1);
  const range = `A1:${lastColumn}${rows.length}`;
  const body = rows.map((row, index) => {
    const cells = row.map((cell, column) => {
      const attributes = `r="${columnName(column)}${index + 1}" s="${cell.style}"`;
      if (cell.numeric) {
        return cell.value == null ? `<c ${attributes}/>` : `<c ${attributes} t="n"><v>${cell.value}</v></c>`;
      }
      // 所有文字均明确使用 inlineStr。即使剧本名以 =、+、-、@ 开头也不会成为公式。
      return `<c ${attributes} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.value)}</t></is></c>`;
    }).join('');
    return `<row r="${index + 1}"${index === 0 ? ' ht="28" customHeight="1"' : ''}>${cells}</row>`;
  }).join('');
  const columns = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('');
  return `${XML}<worksheet xmlns="${SHEET_NS}"><dimension ref="${range}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="22"/><cols>${columns}</cols><sheetData>${body}</sheetData><autoFilter ref="${range}"/><pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
}

function exportAuditXlsx(summary = {}) {
  if (!summary || typeof summary !== 'object') throw new TypeError('审核汇总必须是对象');
  const generatedAt = new Date().toISOString();
  const files = new Map();
  const add = (name, content) => files.set(name, Buffer.from(content, 'utf8'));
  add('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  add('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL_NS}/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  add('docProps/core.xml', `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>剧本审核统计</dc:title><dc:creator>StoryPlay</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${generatedAt}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${generatedAt}</dcterms:modified></cp:coreProperties>`);
  add('docProps/app.xml', `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>StoryPlay</Application></Properties>`);
  add('xl/workbook.xml', `${XML}<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><bookViews><workbookView/></bookViews><sheets><sheet name="审核统计" sheetId="1" r:id="rId1"/><sheet name="统计口径" sheetId="2" r:id="rId2"/></sheets></workbook>`);
  add('xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`);
  add('xl/styles.xml', `${XML}<styleSheet xmlns="${SHEET_NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2E9DD"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  add('xl/worksheets/sheet1.xml', worksheet(auditRows(summary), [48, 18, 48, 20]));
  add('xl/worksheets/sheet2.xml', worksheet(rulesRows(summary, generatedAt), [48, 96]));
  return writeAll(files);
}

module.exports = { exportAuditXlsx };
