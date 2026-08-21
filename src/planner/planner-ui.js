/* =============================================================
   planner-ui.js — shared browser helpers for every planner tab.
   =============================================================
   Served at /planner-ui.js by src/planner/server.js and loaded by every page.
   The tabs used to each inline their own copy of file-reading, drag-and-drop
   wiring, escaping, number formatting, the warnings block and the stat bar —
   the same code four times, drifting apart. This is the one copy.

   It owns the SHELL (drop zones, stats, warnings), never a tab's result table.
   Each page still writes its own render() for its own data; it just calls
   PlannerUI.dropZones() for intake and PlannerUI.renderStats()/renderWarnings()
   for the two blocks that are identical everywhere.

   Exposes a single global: window.PlannerUI.
   ============================================================= */
(function () {
  'use strict';

  // HTML-escape for text interpolated into innerHTML.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Integer formatter ("1,234"); "—" for null/NaN.
  function fmtInt(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return Number(v).toLocaleString('en-US');
  }

  // Up-to-2-decimal formatter ("1,234.5"); "—" for null/NaN. For linear feet.
  function fmtNum(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  // Read one File to { name, text }.
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve({ name: file.name, text: String(r.result || '') });
      r.onerror = () => reject(r.error);
      r.readAsText(file);
    });
  }

  // The stat bar. items: [{ label, value, warn?:bool }]. Returns HTML.
  function renderStats(items) {
    return '<div class="stats">' + items.map((it) =>
      '<div class="stat"><div class="l">' + esc(it.label) + '</div>' +
      '<div class="v"' + (it.warn ? ' style="color:var(--warn)"' : '') + '>' +
      (it.html != null ? it.html : esc(it.value)) + '</div></div>'
    ).join('') + '</div>';
  }

  // The "Ingestion notices & warnings (N)" collapsible. Returns '' when empty,
  // so callers can concatenate unconditionally. `tone` picks the inner note
  // colour ('warn' default, or 'bad'). Kept tight against whatever follows it —
  // the old inline copies left a large gap above the stat cards.
  function renderWarnings(warnings, tone) {
    if (!warnings || !warnings.length) return '';
    const noteClass = tone === 'bad' ? 'note bad' : 'note';
    return '<details class="sec warnings">' +
      '<summary style="font-weight:500;font-size:13px;color:var(--muted)">' +
      'Ingestion notices &amp; warnings (' + warnings.length + ')</summary>' +
      '<div class="' + noteClass + '" style="margin-top:8px;font-size:12.5px;' +
      'max-height:220px;overflow-y:auto;line-height:1.6">' +
      warnings.map((w) => '<div>' + esc(w) + '</div>').join('') +
      '</div></details>';
  }

  /* ── Collapsible drop-zone component ───────────────────────────────────────
     Builds the whole intake panel into `mount` and manages its state. The panel
     starts COLLAPSED so the action button is visible without scrolling; the
     whole panel accepts drops even while collapsed, and it auto-collapses again
     once at least one job file has landed.

     config:
       mount        element to build into (required)
       jobsTitle    heading for the multi-file job zone
       jobsHint     sub-hint under it
       stockTitle   heading for the single stock zone
       stockHint    sub-hint under it
       isStockFile  (text) => bool  — routes a panel-level drop to jobs vs stock
       onChange     ()   => void    — fired after any add/remove/clear

     returns { getJobs(), getStock(), isEmpty(), clear(), expand(), collapse() }.
  */
  function dropZones(config) {
    const jobs = new Map();   // name -> { name, text }
    let stock = null;         // { name, text } | null
    let autoCollapsed = false;

    const mount = config.mount;
    mount.innerHTML =
      '<section class="drop" data-open="0">' +
        '<button type="button" class="drop-toggle" aria-expanded="false">' +
          '<span class="drop-caret">▸</span>' +
          '<span class="drop-title">Files</span>' +
          '<span class="drop-count"></span>' +
        '</button>' +
        '<div class="drop-body" hidden>' +
          '<div class="zones">' +
            '<div class="zone z-jobs">' +
              '<h3>' + esc(config.jobsTitle || 'Job material summaries') + '</h3>' +
              '<p class="sub-hint">' + esc(config.jobsHint || 'Drop several, or click to choose. One per job.') + '</p>' +
              '<div class="files files-jobs"></div>' +
            '</div>' +
            '<div class="zone z-stock">' +
              '<h3>' + esc(config.stockTitle || 'Stock CSV') + ' <span class="badge-opt">Optional</span></h3>' +
              '<p class="sub-hint">' + esc(config.stockHint || 'Drop your on-hand export to net against stock.') + '</p>' +
              '<div class="files files-stock"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<input type="file" class="pick-jobs" accept=".csv,text/csv" multiple hidden>' +
        '<input type="file" class="pick-stock" accept=".csv,text/csv" hidden>' +
      '</section>';

    const panel = mount.querySelector('.drop');
    const toggle = mount.querySelector('.drop-toggle');
    const body = mount.querySelector('.drop-body');
    const count = mount.querySelector('.drop-count');
    const zJobs = mount.querySelector('.z-jobs');
    const zStock = mount.querySelector('.z-stock');
    const flJobs = mount.querySelector('.files-jobs');
    const flStock = mount.querySelector('.files-stock');
    const pickJobs = mount.querySelector('.pick-jobs');
    const pickStock = mount.querySelector('.pick-stock');

    function isOpen() { return panel.dataset.open === '1'; }
    function setOpen(open) {
      panel.dataset.open = open ? '1' : '0';
      panel.classList.toggle('open', open);
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    function expand() { setOpen(true); }
    function collapse() { setOpen(false); }

    function summarize() {
      const j = jobs.size;
      if (!j && !stock) { count.textContent = 'Drop CSVs, or click to add'; return; }
      const parts = [];
      parts.push(j + (j === 1 ? ' job file' : ' job files'));
      if (stock) parts.push('stock ✓');
      count.textContent = parts.join('  ·  ');
    }

    function paintFiles() {
      flJobs.innerHTML = '';
      for (const [name] of jobs) {
        const row = document.createElement('div');
        row.innerHTML = '<span class="mono">' + esc(name) + '</span>' +
          '<button class="rm" data-job="' + esc(name) + '" title="Remove">×</button>';
        flJobs.appendChild(row);
      }
      flStock.innerHTML = '';
      if (stock) {
        const row = document.createElement('div');
        row.innerHTML = '<span class="mono">' + esc(stock.name) + '</span>' +
          '<button class="rm" data-stock="1" title="Remove">×</button>';
        flStock.appendChild(row);
      }
    }

    function changed() {
      paintFiles();
      summarize();
      if (typeof config.onChange === 'function') config.onChange();
    }

    // Add a list of File objects. `hint` forces routing ('jobs' | 'stock'); when
    // omitted, each file is sniffed with config.isStockFile.
    async function addFiles(fileList, hint) {
      let addedJob = false;
      for (const f of fileList) {
        if (!f.name.toLowerCase().endsWith('.csv')) continue;
        const parsed = await readFile(f);
        const toStock = hint === 'stock' ||
          (hint !== 'jobs' && typeof config.isStockFile === 'function' && config.isStockFile(parsed.text));
        if (toStock) {
          stock = parsed;
        } else {
          jobs.set(parsed.name, parsed);
          addedJob = true;
        }
      }
      changed();
      // Auto-collapse once, the first time a job file lands, so the results and
      // the action button aren't pushed down by the open panel.
      if (addedJob && !autoCollapsed) { autoCollapsed = true; collapse(); }
    }

    // Toggle open/closed on header click.
    toggle.addEventListener('click', () => setOpen(!isOpen()));

    // Click a zone (when open) to open its file picker; ignore clicks on the ×.
    zJobs.addEventListener('click', (e) => { if (!e.target.closest('.rm')) pickJobs.click(); });
    zStock.addEventListener('click', (e) => { if (!e.target.closest('.rm')) pickStock.click(); });

    pickJobs.addEventListener('change', () => { addFiles(pickJobs.files, 'jobs'); pickJobs.value = ''; });
    pickStock.addEventListener('change', () => { addFiles(pickStock.files, 'stock'); pickStock.value = ''; });

    // Remove buttons (event-delegated on the panel).
    mount.addEventListener('click', (e) => {
      const rm = e.target.closest('.rm');
      if (!rm) return;
      e.stopPropagation();
      if (rm.dataset.job) jobs.delete(rm.dataset.job);
      else if (rm.dataset.stock) stock = null;
      changed();
    });

    // Panel-level drag/drop (works collapsed OR open). Individual zones override
    // the routing hint when the panel is open and the drop lands on one of them.
    panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('over'); });
    panel.addEventListener('dragleave', (e) => {
      if (!panel.contains(e.relatedTarget)) panel.classList.remove('over');
    });
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      panel.classList.remove('over');
      let hint;
      if (isOpen() && e.target.closest('.z-stock')) hint = 'stock';
      else if (isOpen() && e.target.closest('.z-jobs')) hint = 'jobs';
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files, hint);
    });

    // Initial paint only — do NOT fire onChange here. The caller assigns the
    // returned handle (often referenced from inside onChange) only after this
    // returns, so calling onChange now would hit it in the temporal dead zone.
    paintFiles();
    summarize();
    return {
      getJobs: () => Array.from(jobs.values()),
      getStock: () => stock,
      isEmpty: () => jobs.size === 0,
      clear: () => { jobs.clear(); stock = null; autoCollapsed = false; changed(); },
      expand,
      collapse,
    };
  }

  window.PlannerUI = { esc, fmtInt, fmtNum, readFile, renderStats, renderWarnings, dropZones };
})();
