// =============================================================
// cutListModel — how a cut list is GROUPED (no rendering)
// =============================================================
// The rule that two physical boards are "the same board" — and therefore
// collapse to one diagram with a ×N badge — existed in three places before this
// module: public/optimize.html (the browser cut list), src/ewp/pdfDocs.js (the
// printed cut sheet), and it was about to be copied a third time for the
// standalone planner. All byte-identical, all free to drift apart.
//
// This is the single copy. Rendering stays per-surface, because the screen and
// the printed sheet genuinely differ (the PDF has density tiers and print-light
// CSS); the GROUPING must not.
//
// Loads in Node (`require`) and in the browser (`<script>` → window.CutListModel)
// with no build step.
// =============================================================

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CutListModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Material sections within a job, in design-note order (I-joists → LVL → Rim).
  var CUT_SECTIONS = [
    { key: 'ijoist', label: 'I-Joists',  test: function (c) { return /pji|tji|bci|lpi|i-?joist|i-?shape|joist/i.test(c); } },
    { key: 'lvl',    label: 'LVL',       test: function (c) { return isLvl(c); } },
    { key: 'rim',    label: 'Rim Board', test: function (c) { return /rim/i.test(c); } },
  ];

  function isLvl(cat) { return /lvl|rigidlam|rectangular/i.test(String(cat || '')); }

  function cutSection(cat) {
    for (var i = 0; i < CUT_SECTIONS.length; i++) {
      if (CUT_SECTIONS[i].test(String(cat || ''))) return CUT_SECTIONS[i].key;
    }
    return 'other';
  }

  // Two physical boards are "identical" (collapse to one diagram + ×N) when they
  // are the same size/category/source/length AND carry the same multiset of cuts.
  // Sorting the cut list is what makes it a MULTISET compare: two boards holding
  // J18+J14 and J14+J18 are the same board to a buyer and to the saw.
  function boardSig(b) {
    return [b.size, b.category, b.cutFrom, b.stockLength,
      b.cuts.map(function (c) { return c.cutLabel + '@' + c.requiredLength; }).sort().join(',')
    ].join('|');
  }

  function collapse(boards) {
    var m = new Map();
    for (var i = 0; i < boards.length; i++) {
      var sig = boardSig(boards[i]);
      if (!m.has(sig)) m.set(sig, { board: boards[i], count: 0 });
      m.get(sig).count++;
    }
    return Array.from(m.values());
  }

  // Committed rows (ONE PER CUT PIECE) → physical boards, keyed by
  // stockPieceNumber. Rows without one fall back to a synthetic key.
  //
  // DRIFT NOTE — the two copies this replaces disagreed on that fallback, and the
  // disagreement is preserved rather than silently "fixed":
  //   * the browser cut list used `_cutFrom_size_stockLength`, so unnumbered rows
  //     for the same product COLLAPSE into one board;
  //   * the PDF builder appended the running map size, giving each unnumbered row
  //     a fresh key, so they stay SEPARATE boards.
  // Which is right depends on the surface, and changing the PDF is not this
  // change's business — `splitUnnumbered` picks the behavior explicitly.
  function boardsFromRows(rows, splitUnnumbered) {
    var m = new Map();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var bk = (r.stockPieceNumber == null || r.stockPieceNumber === '')
        ? '_' + r.cutFrom + '_' + r.size + '_' + r.stockLength +
          (splitUnnumbered ? '_' + m.size : '')
        : String(r.stockPieceNumber);
      if (!m.has(bk)) {
        m.set(bk, {
          stockLength: Number(r.stockLength) || 0, cutFrom: r.cutFrom,
          size: r.size, depth: r.depth, category: r.category, cuts: [],
        });
      }
      m.get(bk).cuts.push({ cutLabel: r.cutLabel, requiredLength: Number(r.requiredLength) || 0 });
    }
    return Array.from(m.values());
  }

  // Bucket a job's boards into material sections, each already collapsed.
  // Returns [{ key, label, total, groups:[{board,count}] }] in CUT_SECTIONS
  // order, with any unrecognized category last under "Other".
  function sectionsOf(boards) {
    var buckets = new Map();
    for (var i = 0; i < boards.length; i++) {
      var sec = cutSection(boards[i].category);
      if (!buckets.has(sec)) buckets.set(sec, []);
      buckets.get(sec).push(boards[i]);
    }
    var order = CUT_SECTIONS.map(function (s) { return s.key; });
    Array.from(buckets.keys()).forEach(function (k) {
      if (order.indexOf(k) === -1) order.push(k);
    });
    var out = [];
    for (var j = 0; j < order.length; j++) {
      var list = buckets.get(order[j]);
      if (!list || !list.length) continue;
      var def = CUT_SECTIONS.filter(function (s) { return s.key === order[j]; })[0];
      var groups = collapse(list);
      out.push({
        key: order[j],
        label: def ? def.label : 'Other',
        total: groups.reduce(function (s, g) { return s + g.count; }, 0),
        groups: groups,
      });
    }
    return out;
  }

  return {
    CUT_SECTIONS: CUT_SECTIONS,
    isLvl: isLvl,
    cutSection: cutSection,
    boardSig: boardSig,
    collapse: collapse,
    boardsFromRows: boardsFromRows,
    sectionsOf: sectionsOf,
  };
});
