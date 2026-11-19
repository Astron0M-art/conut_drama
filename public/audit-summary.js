// 浏览器汇总与 Excel 导出共用的字数判定；只读取有效的最新逐本结果。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AuditSummary = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_BOOKS = 100;
  const LABELS = {
    queued: '排队中', running: '正在校验', rechecking: '修改后待重算',
    error: '处理失败', format_error: '格式未通过', no_episodes: '未识别到正文集数',
  };
  const integer = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

  function normalizeOptions(input) {
    const options = input || {};
    const min = options.min === undefined ? 550 : Number(options.min);
    const max = options.max === undefined ? 1000 : Number(options.max);
    if (!integer(min) || !integer(max) || max < min) throw new Error('合格区间必须为非负整数，且上限不能小于下限');
    return { min, max, incScene: options.incScene === true, incCast: options.incCast === true };
  }

  function verdict(n, options) {
    if (n === 0) return { kind: 'empty', label: '空集', diff: options.min };
    if (n < options.min) return { kind: 'short', label: '字数不足', diff: options.min - n };
    if (n > options.max) return { kind: 'long', label: '超过上限', diff: n - options.max };
    return { kind: 'ok', label: '合格', diff: 0 };
  }

  function summarizeBooks(books, inputOptions) {
    if (!Array.isArray(books) || books.length > MAX_BOOKS) throw new Error('每批最多支持100本剧本');
    const options = normalizeOptions(inputOptions);
    let totalEpisodes = 0;
    const rows = books.map((book, index) => {
      if (!book || typeof book !== 'object' || Array.isArray(book)) throw new Error('剧本数据格式错误');
      const row = { id: book.id === undefined ? index : book.id, name: String(book.name || '未命名剧本').slice(0, 250),
        status: book.status || 'queued', label: '', totalEpisodes: null, totalWords: null,
        qualifiedEpisodes: null, badEpisodes: [], issues: [], passed: null, unit: '字' };
      const result = book.res || book;
      const analysis = result.analysis;
      if (book.dirty || book.rechecking || row.status === 'rechecking') row.status = 'rechecking';
      else if (['queued', 'running', 'error'].includes(row.status)) { /* 未完成不读取旧分析 */ }
      else if (!result.format?.ok) row.status = 'format_error';
      else if (!analysis || !Array.isArray(analysis.episodes) || !analysis.episodes.length) row.status = 'no_episodes';
      else row.status = 'done';
      if (row.status !== 'done') {
        row.label = LABELS[row.status] || '等待统计';
        if (row.status === 'error' && book.error) row.issues.push({ type: 'error', text: String(book.error).slice(0, 600) });
        return row;
      }
      if (analysis.episodes.length > 10000) throw new Error('单本识别集数超过10000，请检查集号与格式');
      totalEpisodes += analysis.episodes.length;
      if (totalEpisodes > 100000) throw new Error('本次导出集数过多');
      row.unit = analysis.lang === 'en' ? '词' : '字';
      row.totalEpisodes = analysis.episodes.length;
      row.totalWords = 0;
      row.qualifiedEpisodes = 0;
      row.issues = (Array.isArray(analysis.issues) ? analysis.issues : []).map(issue => ({
        type: String(issue?.type || 'warning'), text: String(issue?.text || '').slice(0, 1000),
      })).filter(issue => issue.text);
      for (const episode of analysis.episodes) {
        if (!episode || !integer(episode.no) || episode.no < 1 || !integer(episode.counts?.pure)
            || !integer(episode.parts?.scene) || !integer(episode.parts?.cast)) throw new Error('逐集统计数据无效，请重新校验后导出');
        const n = episode.counts.pure + (options.incScene ? episode.parts.scene : 0) + (options.incCast ? episode.parts.cast : 0);
        if (!Number.isSafeInteger(n)) throw new Error('逐集统计字数无效');
        row.totalWords += n;
        const state = verdict(n, options);
        if (state.kind === 'ok') row.qualifiedEpisodes++;
        else row.badEpisodes.push({ no: episode.no, n, ...state });
      }
      row.passed = !row.badEpisodes.length && !row.issues.length;
      row.label = row.badEpisodes.length ? `需调整${row.badEpisodes.length}集` : row.issues.length ? '字数合格，需核对集数' : '全部合格';
      return row;
    });
    const totals = {
      books: rows.length,
      ready: rows.filter(row => row.status === 'done').length,
      pending: rows.filter(row => ['queued', 'running', 'rechecking'].includes(row.status)).length,
      formatErrors: rows.filter(row => row.status === 'format_error').length,
      errors: rows.filter(row => ['error', 'no_episodes'].includes(row.status)).length,
      qualified: rows.filter(row => row.passed === true).length,
      needsWork: rows.filter(row => row.status === 'done' && !row.passed).length,
    };
    return { options, books: rows, totals };
  }

  return { MAX_BOOKS, normalizeOptions, verdict, summarizeBooks };
});
