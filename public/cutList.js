// =============================================================
// cutList.js — per-board cut diagrams (browser rendering)
// =============================================================
// Moved verbatim out of optimize.html so the standalone planner shows the office
// the SAME picture they already read in the web app, without a second copy to
// keep in step. Grouping (which boards are "the same board", and therefore
// collapse to one diagram with a ×N badge) lives in src/ewp/cutListModel.js and
// is shared further still — the printed PDF sheets use it too.
//
// Load order matters: cutListModel.js must come first (it defines
// window.CutListModel), and this file must come before optimize-editor.js, which
// calls renderBoard() as a global.
//
// Board shape:
//   { size, category, cutFrom, stockLength, cuts: [{ cutLabel, requiredLength }] }
//
// The host page supplies the two things that differ per surface via
// CutList.configure(): the LVL drop threshold, and its own escape/format helpers.
// =============================================================

(function (root) {
  'use strict';

  var Model = root.CutListModel;
  if (!Model) throw new Error('cutList.js requires cutListModel.js to be loaded first');

  // Defaults are overridden by the host page; they exist so a bare page still
  // renders something sane rather than throwing.
  var cfg = {
    lvlThreshold: 8,
    esc: function (s) {
      return String(s).replace(/[&<>"]/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
      });
    },
    ftLabel: function (n) {
      return (n == null || n === '') ? '—' : (Math.round(Number(n) * 100) / 100) + '′';
    },
    editButton: false,   // the app shows "Edit cut list"; the planner has nothing to edit
  };

  function configure(o) {
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) cfg[k] = o[k];
  }

  // One board's diagram. For LVL, a remainder ≥ the configured drop threshold is
  // a reusable remnant ("return to stock"); shorter remainders, and every i-joist
  // remainder (the customer cuts those — RTW loses the offcut), are waste.
  // `count` > 1 stamps a ×N badge.
  function renderBoard(b, count) {
    var esc = cfg.esc, ftLabel = cfg.ftLabel;
    var used = b.cuts.reduce(function (s, c) { return s + (Number(c.requiredLength) || 0); }, 0);
    var leftover = Math.max(0, b.stockLength - used);
    var returnable = Model.isLvl(b.category) && leftover >= cfg.lvlThreshold - 1e-9;
    var srcCls = b.cutFrom === 'on-hand' ? 'onhand' : 'purchase';
    var srcLbl = b.cutFrom === 'on-hand' ? 'on-hand' : 'purchase';
    var segs = b.cuts.map(function (c) {
      var len = Number(c.requiredLength) || 0;
      return '<div class="seg" style="flex:' + len + ' 0 0" title="' + esc(c.cutLabel || '') +
             ' — ' + ftLabel(len) + '">' + esc(c.cutLabel || '') + '</div>';
    }).join('');
    if (leftover > 0.01) {
      segs += returnable
        ? '<div class="seg returnstock" style="flex:' + leftover + ' 0 0" title="return to stock — ' +
          ftLabel(leftover) + ' LVL remnant (≥ ' + ftLabel(cfg.lvlThreshold) + ')">↩ to stock</div>'
        : '<div class="seg waste" style="flex:' + leftover + ' 0 0" title="waste ' + ftLabel(leftover) + '">waste</div>';
    }
    var tail = leftover <= 0.01 ? '0′ waste'
      : returnable ? '<span class="stock">↩ ' + ftLabel(leftover) + ' to stock</span>'
      : ftLabel(leftover) + ' waste';
    var qty = '<span class="qty">×' + count + '</span> ';   // always show the count, incl. ×1
    // Line breaks and indentation are preserved verbatim from the copy that
    // lived in optimize.html, so the emitted markup is byte-for-byte what the
    // app produced before this was extracted.
    return '<div class="board">\n' +
      '    <div class="blabel">' + qty + '<b>' + esc(b.size) + '</b> · ' + ftLabel(b.stockLength) + ' board\n' +
      '      <span class="src ' + srcCls + '">' + srcLbl + '</span>\n' +
      '      <span class="waste">' + b.cuts.length + ' cut' + (b.cuts.length === 1 ? '' : 's') +
      ' · ' + ftLabel(used) + ' used · ' + tail + '</span></div>\n' +
      '    <div class="bar">' + segs + '</div></div>';
  }

  // Render one job's boards: material sections in design-note order, each with
  // identical boards collapsed to a single diagram + ×N.
  function renderJob(job) {
    var esc = cfg.esc;
    var count = job.boards.length;
    var html = '<div class="jobgroup"><h3>Job ' + esc(job.jobNumber) +
      ' <span class="hint">· ' + count + ' board' + (count === 1 ? '' : 's') +
      (job.jobName ? ' · ' + esc(job.jobName) : '') +
      (job.deliveryDate ? ' · delivery ' + esc(job.deliveryDate) : '') + '</span></h3>';
    Model.sectionsOf(job.boards).forEach(function (sec) {
      html += '<div class="matsection"><h4>' + esc(sec.label) + ' <span class="hint">· ' +
        sec.total + ' board' + (sec.total === 1 ? '' : 's') + '</span></h4>';
      sec.groups.forEach(function (g) { html += renderBoard(g.board, g.count); });
      html += '</div>';
    });
    return html + '</div>';
  }

  function legend() {
    return '<div class="legend"><span><span class="sw cut"></span>cut piece</span>' +
      '<span><span class="sw stock"></span>return to stock (LVL drop ≥ ' +
      cfg.ftLabel(cfg.lvlThreshold) + ')</span>' +
      '<span><span class="sw waste"></span>waste</span></div>';
  }

  // jobs: [{ jobNumber, jobName?, deliveryDate?, boards: [...] }]
  function renderJobs(jobs) {
    return jobs.map(renderJob).join('');
  }

  root.CutList = {
    configure: configure,
    renderBoard: renderBoard,
    renderJob: renderJob,
    renderJobs: renderJobs,
    legend: legend,
  };
  // optimize-editor.js calls renderBoard() as a bare global — keep it reachable.
  root.renderBoard = renderBoard;
})(typeof self !== 'undefined' ? self : this);
