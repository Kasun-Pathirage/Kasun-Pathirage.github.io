/*
 * Portfolio edit mode.
 * Loaded by every page via <script src=".../assets/edit-mode.js" id="__edit-loader">.
 * Only activates when the page is opened locally (file://, localhost) or with ?edit in the URL,
 * so visitors on the live site never see it.
 *
 * Features: inline text editing, drag/move/swap/resize/delete images, AI-tell highlighter,
 * first-pass rewrite suggestions (assets/suggestions/<page>.js), save straight back to the file
 * (Chrome/Edge File System Access API) with a timestamped backup, download fallback elsewhere.
 */
(function () {
  'use strict';
  if (window.__PORTFOLIO_EDITOR__) return;
  window.__PORTFOLIO_EDITOR__ = true;

  var LOCAL = location.protocol === 'file:' || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname) ||
    /[?&]edit\b/.test(location.search);
  if (!LOCAL) return;

  var loaderEl = document.currentScript || document.getElementById('__edit-loader');
  var ASSETS = loaderEl.src.replace(/edit-mode\.js(\?.*)?$/, '');
  var parts = decodeURIComponent(location.pathname).split('/');
  var PAGE_FILE = parts.pop() || 'index.html';
  var PAGE_DIR = parts.pop() || '';
  var PAGE_STEM = PAGE_FILE.replace(/\.html?$/i, '');
  var IS_ROOT_PAGE = !/\.\.\//.test(loaderEl.getAttribute('src'));

  var root = document.querySelector('.container') || document.querySelector('main') || document.body;

  var ITEM_SEL = 'figure, .hero-image, .project-tile, .lecture-card';
  var GROUP_SEL = '.figure-grid, .projects-grid';
  var PROTECTED_SEL = '.viewer-tabs, .viewer-stage, .viewer-downloads, iframe, canvas, video, pre, code, script, style, svg';
  var LOCKED_GROUP_ITEMS = '.project-tile, .lecture-card'; // only reorder among siblings

  var editing = false, dirty = false, tellsOn = false;
  var undoStack = [];
  var suggestions = [];
  var hoverItem = null, hoverGroup = null;

  /* ------------------------------------------------------------------ utils */
  function $(sel, el) { return (el || document).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function setDirty(v) { dirty = v; updateStatus(); }
  function isUI(el) { return el && el.closest && el.closest('[data-ed-ui]'); }

  // tag protected (runtime-managed) nodes in original document order, so saving can restore their
  // pristine markup from the file on disk instead of whatever scripts rendered into them
  $$(PROTECTED_SEL, root).forEach(function (el, i) { el.setAttribute('data-ed-pid', i); });
  var PROTECTED_COUNT = $$(PROTECTED_SEL, root).length;
  // when this copy of the page was loaded; a file on disk newer than this (and not written by us) was changed elsewhere
  var LOADED_AT = Date.now(), lastWriteAt = 0;

  /* -------------------------------------------------------------- IndexedDB */
  function idb(op, key, val) {
    return new Promise(function (res) {
      try {
        var rq = indexedDB.open('portfolio-editor', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
        rq.onerror = function () { res(null); };
        rq.onsuccess = function () {
          try {
            var tx = rq.result.transaction('kv', op === 'get' ? 'readonly' : 'readwrite');
            var st = tx.objectStore('kv');
            var r = op === 'get' ? st.get(key) : st.put(val, key);
            r.onsuccess = function () { res(op === 'get' ? r.result : true); };
            r.onerror = function () { res(null); };
          } catch (e) { res(null); }
        };
      } catch (e) { res(null); }
    });
  }

  /* ------------------------------------------------------- folder handles */
  var FSA = typeof window.showDirectoryPicker === 'function';
  var pageDirHandle = null, rootDirHandle = null;

  async function hasEntry(dir, name, kind) {
    try { if (kind === 'dir') await dir.getDirectoryHandle(name); else await dir.getFileHandle(name); return true; }
    catch (e) { return false; }
  }
  async function ensurePerm(h) {
    if (!h) return false;
    try {
      var o = { mode: 'readwrite' };
      if ((await h.queryPermission(o)) === 'granted') return true;
      return (await h.requestPermission(o)) === 'granted';
    } catch (e) { return false; }
  }
  async function resolveFromRoot(r) {
    if (IS_ROOT_PAGE) return (await hasEntry(r, PAGE_FILE)) ? r : null;
    if (await hasEntry(r, PAGE_DIR, 'dir')) {
      var d = await r.getDirectoryHandle(PAGE_DIR);
      if (await hasEntry(d, PAGE_FILE)) return d;
    }
    return null;
  }
  async function getPageDir(interactive) {
    if (pageDirHandle && await ensurePerm(pageDirHandle)) return pageDirHandle;
    var r = await idb('get', 'rootDir');
    if (r && await ensurePerm(r)) {
      var d = await resolveFromRoot(r);
      if (d) { rootDirHandle = r; pageDirHandle = d; updateStatus(); return d; }
    }
    if (!interactive || !FSA) return null;
    try {
      var picked = await window.showDirectoryPicker({ id: 'portfolio-root', mode: 'readwrite' });
      var dd = await resolveFromRoot(picked);
      if (dd) { rootDirHandle = picked; await idb('put', 'rootDir', picked); }
      else if (await hasEntry(picked, PAGE_FILE)) { dd = picked; }
      if (!dd) { toast('That folder doesn’t contain ' + PAGE_FILE + '. Pick your Portfolio folder.', true); return null; }
      pageDirHandle = dd; updateStatus(); return dd;
    } catch (e) { return null; }
  }

  /* ---------------------------------------------------------------- UI shell */
  var host = document.createElement('div');
  host.setAttribute('data-ed-ui', '');
  host.setAttribute('contenteditable', 'false');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  var sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
    '.pe{pointer-events:auto}' +
    'button{font:600 12px/1 inherit;font-family:inherit;border:1px solid #d4d4d4;background:#fff;color:#1a1a1a;border-radius:6px;padding:7px 10px;cursor:pointer;white-space:nowrap}' +
    'button:hover{border-color:#e60000;color:#e60000}button.primary{background:#e60000;border-color:#e60000;color:#fff}button.primary:hover{background:#c00;color:#fff}' +
    'button.on{background:#1a1a1a;color:#fff;border-color:#1a1a1a}' +
    '#fab{position:fixed;right:20px;bottom:20px;border-radius:20px;padding:10px 16px;font-size:13px;box-shadow:0 2px 10px rgba(0,0,0,.18)}' +
    '#bar{position:fixed;left:0;right:0;margin:0 auto;width:max-content;bottom:16px;display:none;gap:6px;align-items:center;background:#fff;border:1px solid #ddd;border-radius:10px;padding:6px;box-shadow:0 4px 20px rgba(0,0,0,.16);max-width:calc(100vw - 24px);flex-wrap:wrap;justify-content:center}' +
    '#bar.show{display:flex}#status{font:12px/1.2 inherit;color:#666;padding:0 6px;min-width:90px}#status.dirty{color:#c00}' +
    '.sep{width:1px;height:22px;background:#e2e2e2;margin:0 2px}' +
    '#ictl,#gctl{position:fixed;display:none;gap:3px;background:rgba(26,26,26,.88);padding:3px;border-radius:7px}' +
    '#ictl button,#gctl button{background:transparent;color:#fff;border:0;padding:5px 7px;font-size:11px}#ictl button:hover,#gctl button:hover{background:rgba(255,255,255,.18);color:#fff}' +
    '#gctl{background:rgba(0,90,200,.9)}.grab{cursor:grab}' +
    '#rsz{position:fixed;display:none;width:18px;height:18px;background:#e60000;border:2px solid #fff;border-radius:4px;box-shadow:0 1px 4px rgba(0,0,0,.35);cursor:nwse-resize;touch-action:none}' +
    '#rsz:after{content:"";position:absolute;right:2px;bottom:2px;width:7px;height:7px;border-right:2px solid #fff;border-bottom:2px solid #fff}' +
    '#rh{position:fixed;display:none;width:46px;height:12px;margin-left:-23px;background:rgba(0,90,200,.95);border:2px solid #fff;border-radius:7px;box-shadow:0 1px 4px rgba(0,0,0,.35);cursor:ns-resize;touch-action:none}' +
    '#rszlbl{position:fixed;display:none;background:#1a1a1a;color:#fff;font-size:11px;padding:3px 6px;border-radius:4px}' +
    '#line{position:fixed;display:none;background:#e60000;border-radius:2px;box-shadow:0 0 0 2px rgba(230,0,0,.2)}' +
    '#ghost{position:fixed;display:none;background:#1a1a1a;color:#fff;font-size:12px;padding:5px 8px;border-radius:5px;opacity:.9}' +
    '#pop{position:fixed;display:none;width:min(440px,calc(100vw - 24px));background:#fff;border:1px solid #ddd;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.2);padding:12px;font-size:13px;color:#222}' +
    '#pop .lbl{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#888;margin:2px 0 4px}' +
    '#pop .orig{background:#fff4f4;border-radius:6px;padding:8px;line-height:1.45;max-height:140px;overflow:auto}' +
    '#pop textarea{width:100%;min-height:80px;border:1px solid #ccc;border-radius:6px;padding:8px;font:13px/1.45 inherit;font-family:inherit;resize:vertical}' +
    '#pop .note{color:#666;font-size:12px;line-height:1.4;margin:6px 0 10px}#pop .row{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}' +
    '#modal{position:fixed;inset:0;display:none;background:rgba(0,0,0,.45);align-items:center;justify-content:center}' +
    '#modal .box{background:#fff;border-radius:12px;width:min(900px,calc(100vw - 32px));max-height:85vh;display:flex;flex-direction:column;overflow:hidden}' +
    '#modal .hd{display:flex;gap:8px;align-items:center;padding:12px;border-bottom:1px solid #eee;font-size:14px;font-weight:600}' +
    '#modal .hd span{flex:1}#modal .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;padding:12px;overflow:auto}' +
    '#modal .th{border:2px solid transparent;border-radius:8px;cursor:pointer;background:#f5f5f5;overflow:hidden}' +
    '#modal .th:hover{border-color:#e60000}#modal .th img{width:100%;height:100px;object-fit:cover;display:block}#modal .th div{font-size:11px;padding:4px 6px;color:#444;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '#modal .th.used div{color:#999}#modal .msg{padding:12px;font-size:13px;color:#555}' +
    '#toast{position:fixed;left:0;right:0;margin:0 auto;width:max-content;bottom:80px;background:#1a1a1a;color:#fff;font-size:13px;padding:9px 14px;border-radius:8px;display:none;max-width:90vw}' +
    '#toast.err{background:#b00}' +
    '#help{position:fixed;right:16px;bottom:72px;width:300px;background:#1a1a1a;color:#eee;font-size:12px;line-height:1.5;padding:12px 14px;border-radius:10px;display:none}' +
    '#help b{color:#fff}#help.show{display:block}' +
    '</style>' +
    '<button id="fab" class="pe">✎ Edit page</button>' +
    '<div id="bar" class="pe">' +
    '<button id="save" class="primary" title="Ctrl+S">Save</button>' +
    '<button id="undo" title="Undo last move / swap / delete / accept">Undo</button>' +
    '<span class="sep"></span>' +
    '<button id="sugg" title="Step through first-pass rewrite suggestions">Suggestions</button>' +
    '<button id="tells" title="Highlight phrases that often read as AI-written">AI tells</button>' +
    '<button id="addimg" title="Insert an image after the paragraph your cursor is in">+ Image</button>' +
    '<span class="sep"></span>' +
    '<span id="status"></span>' +
    '<button id="helpb">?</button>' +
    '<button id="done">Done</button>' +
    '</div>' +
    '<div id="ictl" class="pe"><button id="i-drag" class="grab" title="Drag to move">⠇ Move</button><button id="i-up" title="Move up">↑</button><button id="i-down" title="Move down">↓</button><button id="i-swap">Swap</button><button id="i-size" title="Cycle size">Size</button><button id="i-del" title="Delete">✕</button></div>' +
    '<div id="gctl" class="pe"><button id="g-drag" class="grab" title="Drag the whole row">⠇ Row</button><button id="g-cols" title="Cycle columns">Cols</button><button id="g-even" title="Size the images so they all have the same height">Even heights</button><button id="g-reset" title="Back to equal column widths">Reset widths</button><button id="g-split" title="Break the row into separate images">Split</button></div>' +
    '<div id="rsz" class="pe" title="Drag to resize. Double-click to reset."></div><div id="rh" class="pe" title="Drag up or down to change the row height. Double-click to reset."></div><div id="rszlbl"></div>' +
    '<div id="line"></div><div id="ghost"></div>' +
    '<div id="pop" class="pe"></div>' +
    '<div id="modal" class="pe"><div class="box"><div class="hd"><span id="m-title">Choose an image</span><button id="m-upload">Add new image…</button><button id="m-close">Cancel</button></div><div id="m-body"></div></div></div>' +
    '<div id="toast"></div>' +
    '<div id="help" class="pe"><b>Text</b>: click anywhere and type. Paste comes in as plain text.<br>' +
    '<b>Images</b>: hover one for Move / ↑↓ / Swap / Size / ✕. Drag onto the left or right edge of another image to put them side by side.<br>' +
    '<b>Resize</b>: drag the red corner square of an image. In a row it trades width with its neighbour; on its own it sets the image width. Double-click the square to reset.<br>' +
    '<b>Rows</b>: the blue bar moves a whole image row, changes its column count, or evens out the image heights. Drag the small blue handle under a row up or down to make the whole row shorter or taller (double-click it to reset).<br>' +
    '<b>Suggestions</b>: yellow underlines are my first-pass rewrites. Click one to accept, tweak, or skip.<br>' +
    '<b>AI tells</b>: red highlights are phrases worth a second look. Hover for why.<br>' +
    '<b>Save</b> (Ctrl+S) writes straight to the .html file and keeps a backup in _edit-backups/. First save asks you to pick your Portfolio folder once.</div>';
  document.body.appendChild(host);
  function U(id) { return sh.getElementById(id); }

  var pageCSS = document.createElement('style');
  pageCSS.setAttribute('data-ed-ui', '');
  pageCSS.textContent =
    'body[data-ed-on] ' + cssScope(root) + '{outline:2px dashed rgba(230,0,0,.3);outline-offset:8px}' +
    'body[data-ed-on] [data-ed-item-hover]{outline:2px solid rgba(230,0,0,.55);outline-offset:3px}' +
    'body[data-ed-on] [data-ed-group-hover]{outline:2px dashed rgba(0,90,200,.6);outline-offset:6px}' +
    'body[data-ed-on] [data-ed-dragging]{opacity:.35}' +
    'mark.__ed-sugg{background:rgba(255,214,0,.28);color:inherit;border-bottom:2px solid #e0b400;cursor:pointer;padding:0;border-radius:2px}' +
    'mark.__ed-sugg:hover,mark.__ed-sugg.__ed-active{background:rgba(255,214,0,.55)}' +
    'mark.__ed-tell{background:rgba(230,0,0,.13);color:inherit;border-bottom:1.5px dotted #e60000;padding:0}' +
    'body[data-ed-on] a{cursor:text}' +
    // 3D viewer captions: show every model's caption while editing, labelled with its tab name
    'body[data-ed-on] .viewer-caption [data-model]{display:block!important;margin:0 0 .7em}' +
    'body[data-ed-on] .viewer-caption [data-model]::before{content:attr(data-label);display:block;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#999;margin-bottom:2px}';
  document.head.appendChild(pageCSS);
  // Saved with the page whenever a row has custom widths. Phones (<=640px) still stack the images.
  var SIZING_CSS = '\n    /* Image rows with custom column widths, set by dragging in edit mode. Phones still stack them. */\n' +
    '    @media (min-width: 641px) {\n' +
    '        .figure-grid[style*="--cols"] { grid-template-columns: var(--cols) !important; }\n' +
    '        .figure-grid[style*="--cols"] > figure img, .figure-grid[style*="--cols"] > figure video { width: 100%; height: auto; max-height: none; }\n' +
    '    }\n' +
    '    /* Image rows with a height cap, set by dragging the handle under a row in edit mode. */\n' +
    '    .figure-grid[style*="--row-h"] > figure img, .figure-grid[style*="--row-h"] > figure video { max-height: var(--row-h) !important; width: auto !important; max-width: 100%; }\n';
  function ensureSizingCSS(doc) {
    var st = doc.getElementById('img-sizing');
    if (st) { if (st.textContent !== SIZING_CSS) st.textContent = SIZING_CSS; return; }
    st = doc.createElement('style'); st.id = 'img-sizing'; st.textContent = SIZING_CSS;
    doc.head.appendChild(st);
  }
  ensureSizingCSS(document);
  function cssScope(el) { return el === document.body ? 'main' : (el.id ? '#' + el.id : '.' + (el.className || '').split(/\s+/)[0]); }

  var toastT;
  function toast(msg, err) {
    var t = U('toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.style.display = 'block';
    clearTimeout(toastT); toastT = setTimeout(function () { t.style.display = 'none'; }, err ? 5000 : 2600);
  }
  function updateStatus() {
    var s = U('status');
    var left = $$('mark.__ed-sugg', root).length;
    U('sugg').textContent = 'Suggestions' + (suggestions.length ? ' (' + left + ')' : '');
    U('sugg').disabled = !left;
    s.className = dirty ? 'dirty' : '';
    s.textContent = dirty ? 'Unsaved changes' : (lastSaved ? 'Saved ' + lastSaved : (FSA ? (pageDirHandle ? 'Folder connected' : 'Not saved yet') : 'Save = download'));
  }
  var lastSaved = null;

  /* ---------------------------------------------------------------- undo */
  function snapshot() {
    undoStack.push(root.innerHTML);
    if (undoStack.length > 60) undoStack.shift();
    setDirty(true);
  }
  function restore(html) {
    var live = {};
    $$('[data-ed-pid]', root).forEach(function (el) { live[el.getAttribute('data-ed-pid')] = el; });
    root.innerHTML = html;
    $$('[data-ed-pid]', root).forEach(function (el) {
      var l = live[el.getAttribute('data-ed-pid')];
      if (l && l !== el) el.replaceWith(l);
    });
    hoverItem = hoverGroup = null; clearHover();
    $$('[data-ed-item-hover],[data-ed-group-hover],[data-ed-dragging]', root).forEach(function (e) {
      e.removeAttribute('data-ed-item-hover'); e.removeAttribute('data-ed-group-hover'); e.removeAttribute('data-ed-dragging');
    });
    if (editing) applyEditableAttrs();
    bindSuggestionMarks();
    updateStatus();
  }
  U('undo').onclick = function () {
    if (!undoStack.length) { toast('Nothing to undo (text edits: use Ctrl+Z)'); return; }
    restore(undoStack.pop()); setDirty(true);
  };

  /* --------------------------------------------------------- enter / exit */
  function applyEditableAttrs() {
    root.setAttribute('contenteditable', 'true');
    root.spellcheck = true;
    $$(PROTECTED_SEL, root).forEach(function (el) { el.setAttribute('contenteditable', 'false'); });
    $$('img', root).forEach(function (el) { el.setAttribute('draggable', 'false'); });
  }
  function enterEdit() {
    editing = true;
    document.body.setAttribute('data-ed-on', '');
    applyEditableAttrs();
    U('fab').style.display = 'none';
    U('bar').classList.add('show');
    loadSuggestions();
    updateStatus();
    getPageDir(false);
  }
  function exitEdit() {
    if (tellsOn) toggleTells();
    editing = false;
    document.body.removeAttribute('data-ed-on');
    root.removeAttribute('contenteditable');
    $$('[contenteditable="false"]', root).forEach(function (el) { el.removeAttribute('contenteditable'); });
    clearHover(); closePop();
    U('fab').style.display = '';
    U('fab').textContent = dirty ? '✎ Edit page • unsaved' : '✎ Edit page';
    U('bar').classList.remove('show'); U('help').classList.remove('show');
  }
  U('fab').onclick = enterEdit;
  U('done').onclick = exitEdit;
  U('helpb').onclick = function () { U('help').classList.toggle('show'); };

  root.addEventListener('input', function () { if (editing) setDirty(true); });
  root.addEventListener('paste', function (e) {
    if (!editing) return;
    e.preventDefault();
    var t = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, t);
  });
  root.addEventListener('click', function (e) {
    if (!editing) return;
    var a = e.target.closest('a');
    if (a && !(e.ctrlKey || e.metaKey)) e.preventDefault();
  }, true);
  root.addEventListener('dragstart', function (e) { if (editing) e.preventDefault(); });
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('keydown', function (e) {
    if (!editing) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { closePop(); closeModal(); }
  });

  /* ------------------------------------------------- hover controls */
  function clearHover() {
    if (hoverItem) hoverItem.removeAttribute('data-ed-item-hover');
    if (hoverGroup) hoverGroup.removeAttribute('data-ed-group-hover');
    hoverItem = hoverGroup = null;
    U('ictl').style.display = 'none'; U('gctl').style.display = 'none'; U('rsz').style.display = 'none'; U('rh').style.display = 'none';
  }
  function placeControls() {
    if (hoverItem) {
      var r = hoverItem.getBoundingClientRect(), c = U('ictl');
      c.style.display = 'flex';
      c.style.top = Math.max(4, r.top + 6) + 'px';
      c.style.left = Math.max(4, r.right - c.offsetWidth - 6) + 'px';
      var hasImg = !!hoverItem.querySelector('img');
      U('i-swap').style.display = hasImg ? '' : 'none';
      U('i-size').style.display = hasImg && !hoverItem.closest(GROUP_SEL) ? '' : 'none';
    } else U('ictl').style.display = 'none';
    if (hoverGroup && hoverGroup.matches('.figure-grid')) {
      var g = hoverGroup.getBoundingClientRect(), gc = U('gctl');
      gc.style.display = 'flex';
      gc.style.top = Math.max(4, g.top - 30) + 'px';
      gc.style.left = Math.max(4, g.left) + 'px';
      U('g-cols').textContent = 'Cols: ' + gridCols(hoverGroup);
    } else U('gctl').style.display = 'none';
    var m = resizable(hoverItem);
    if (m) {
      var mr = m.getBoundingClientRect(), h = U('rsz');
      h.style.display = 'block';
      h.style.left = (mr.right - 13) + 'px'; h.style.top = (mr.bottom - 13) + 'px';
    } else U('rsz').style.display = 'none';
    var isGrid = hoverGroup && hoverGroup.matches('.figure-grid');
    var rb = isGrid ? rowBox(hoverGroup) : null;
    if (rb) { var hh = U('rh'); hh.style.display = 'block'; hh.style.left = rb.cx + 'px'; hh.style.top = (rb.bottom - 6) + 'px'; }
    else U('rh').style.display = 'none';
    U('g-reset').style.display = isGrid && hoverGroup.style.getPropertyValue('--cols') ? '' : 'none';
  }
  document.addEventListener('mousemove', function (e) {
    if (!editing || drag || rs || rh) return;
    if (isUI(e.target) || e.composedPath().indexOf(host) >= 0) return;
    var it = e.target.closest && e.target.closest(ITEM_SEL);
    if (it && !root.contains(it)) it = null;
    if (it && it.parentElement && it.parentElement.closest('figure')) it = it.parentElement.closest('figure');
    var gr = it ? it.closest(GROUP_SEL) : (e.target.closest && e.target.closest(GROUP_SEL));
    if (gr && !root.contains(gr)) gr = null;
    if (it !== hoverItem) {
      if (hoverItem) hoverItem.removeAttribute('data-ed-item-hover');
      hoverItem = it; if (it) it.setAttribute('data-ed-item-hover', '');
    }
    if (gr !== hoverGroup) {
      if (hoverGroup) hoverGroup.removeAttribute('data-ed-group-hover');
      hoverGroup = gr; if (gr) gr.setAttribute('data-ed-group-hover', '');
    }
    placeControls();
  });
  window.addEventListener('scroll', function () { if (editing && !drag && !rs && !rh) placeControls(); }, true);

  /* --------------------------------------------------- structure helpers */
  function gridCols(g) { var m = /cols-(\d)/.exec(g.className); return m ? +m[1] : 1; }
  function setCols(g, n) {
    g.className = g.className.replace(/\s*cols-\d/g, '') + (n > 1 ? ' cols-' + n : '');
    if (g.style && g.style.getPropertyValue('--cols')) { g.style.removeProperty('--cols'); if (!g.getAttribute('style')) g.removeAttribute('style'); }
  }
  function tidy() {
    $$('.figure-grid', root).forEach(function (g) {
      var n = $$(':scope > figure', g).length;
      if (!n) { g.remove(); return; }
      if (n === 1) { g.replaceWith(g.querySelector(':scope > figure')); return; }
      if (gridCols(g) > n) setCols(g, n);
    });
  }
  function topBlock(el) { // the ancestor that is a direct child of root
    while (el && el.parentElement !== root) el = el.parentElement;
    return el;
  }
  function moveStep(it, dir) {
    snapshot();
    var grid = it.parentElement.matches(GROUP_SEL) ? it.parentElement : null;
    var sib = dir < 0 ? it.previousElementSibling : it.nextElementSibling;
    if (grid && sib && sib.matches(ITEM_SEL)) {
      dir < 0 ? sib.before(it) : sib.after(it);
    } else if (grid && it.matches(LOCKED_GROUP_ITEMS)) {
      undoStack.pop(); return;
    } else {
      var blk = grid ? grid : it;
      var n = dir < 0 ? blk.previousElementSibling : blk.nextElementSibling;
      if (!n) { undoStack.pop(); return; }
      if (grid) { dir < 0 ? grid.before(it) : grid.after(it); }
      else { dir < 0 ? n.before(it) : n.after(it); }
    }
    tidy();
    it.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setTimeout(placeControls, 250);
  }
  U('i-up').onclick = function () { if (hoverItem) moveStep(hoverItem, -1); };
  U('i-down').onclick = function () { if (hoverItem) moveStep(hoverItem, 1); };
  U('i-del').onclick = function () {
    if (!hoverItem) return;
    snapshot(); var it = hoverItem; clearHover(); it.remove(); tidy(); toast('Deleted. Undo brings it back.');
  };
  var SIZES = ['', '85%', '65%', '45%'];
  U('i-size').onclick = function () {
    if (!hoverItem) return;
    var img = hoverItem.querySelector('img'); if (!img) return;
    snapshot();
    var cur = img.style.maxWidth || '', i = (SIZES.indexOf(cur) + 1) % SIZES.length;
    ['width', 'height', 'max-height'].forEach(function (p) { img.style.removeProperty(p); });
    img.style.maxWidth = SIZES[i];
    if (!SIZES[i]) { img.style.removeProperty('max-width'); if (!img.getAttribute('style')) img.removeAttribute('style'); }
    toast(SIZES[i] ? 'Width ' + SIZES[i] : 'Default width');
    placeControls();
  };
  U('g-cols').onclick = function () {
    if (!hoverGroup) return;
    snapshot();
    var n = $$(':scope > figure', hoverGroup).length, c = gridCols(hoverGroup);
    var next = c >= Math.min(3, n) ? 1 : c + 1;
    setCols(hoverGroup, next); placeControls();
  };
  U('g-split').onclick = function () {
    if (!hoverGroup) return;
    snapshot(); var g = hoverGroup; clearHover();
    $$(':scope > figure', g).forEach(function (f) { g.before(f); });
    g.remove();
  };


  /* ----------------------------------------------------------- resizing */
  var rs = null;
  function mediaOf(it) { return it && it.matches && it.matches('figure') ? it.querySelector('img, video') : null; }
  function gridTracks(g) {
    return getComputedStyle(g).gridTemplateColumns.split(/\s+/).map(parseFloat).filter(function (v) { return v > 0; });
  }
  function resizable(it) {
    var m = mediaOf(it); if (!m || !root.contains(it)) return null;
    var p = it.parentElement;
    if (p.matches('.projects-grid')) return null;
    if (p.matches('.figure-grid')) return gridTracks(p).length > 1 ? m : null; // stacked on a narrow window: nothing to trade
    return m;
  }
  function setTrackWidths(g, px) {
    var tot = px.reduce(function (a, b) { return a + b; }, 0), n = px.length;
    g.style.setProperty('--cols', px.map(function (v) { return (v / tot * n).toFixed(3).replace(/\.?0+$/, '') + 'fr'; }).join(' '));
  }
  function clearCols(g) {
    g.style.removeProperty('--cols');
    if (!g.getAttribute('style')) g.removeAttribute('style');
  }
  function clearWidth(m) {
    ['width', 'height', 'max-width', 'max-height'].forEach(function (p) { m.style.removeProperty(p); });
    if (!m.getAttribute('style')) m.removeAttribute('style');
  }
  function rsLabel(txt, e) {
    var l = U('rszlbl'); l.textContent = txt; l.style.display = 'block';
    l.style.left = e.clientX + 14 + 'px'; l.style.top = e.clientY + 12 + 'px';
  }
  U('rsz').addEventListener('pointerdown', function (e) {
    var it = hoverItem, m = resizable(it); if (!m) return;
    e.preventDefault(); e.stopPropagation();
    snapshot();
    var g = it.parentElement.matches('.figure-grid') ? it.parentElement : null;
    rs = { it: it, m: m, g: g, x: e.clientX };
    if (g) {
      rs.tracks = gridTracks(g);
      var idx = $$(':scope > figure', g).indexOf(it);
      rs.col = idx % rs.tracks.length;
      rs.nb = rs.col + 1 < rs.tracks.length ? rs.col + 1 : rs.col - 1;
    } else {
      rs.w = m.getBoundingClientRect().width;
      var cs = getComputedStyle(root);
      rs.max = root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    }
    U('ictl').style.display = 'none'; U('gctl').style.display = 'none';
    document.addEventListener('pointermove', onResize);
    document.addEventListener('pointerup', endResize, { once: true });
  });
  function onResize(e) {
    var dx = e.clientX - rs.x;
    if (rs.g) {
      var t = rs.tracks.slice(), pair = t[rs.col] + t[rs.nb], MIN = 70;
      var w = Math.max(MIN, Math.min(pair - MIN, t[rs.col] + dx));
      t[rs.col] = w; t[rs.nb] = pair - w;
      setTrackWidths(rs.g, t);
      var tot = t.reduce(function (a, b) { return a + b; }, 0);
      rsLabel(t.map(function (v) { return Math.round(v / tot * 100) + '%'; }).join(' / '), e);
    } else {
      // centred image: the corner moves half as far as the width changes
      var nw = Math.round(Math.max(80, Math.min(rs.max, rs.w + 2 * dx)));
      rs.m.style.width = nw + 'px'; rs.m.style.maxWidth = '100%'; rs.m.style.maxHeight = 'none'; rs.m.style.height = 'auto';
      rsLabel(nw + ' px', e);
    }
    var mr = rs.m.getBoundingClientRect(), h = U('rsz');
    h.style.left = (mr.right - 13) + 'px'; h.style.top = (mr.bottom - 13) + 'px';
  }
  function endResize() {
    document.removeEventListener('pointermove', onResize);
    U('rszlbl').style.display = 'none';
    if (rs && rs.g) ensureSizingCSS(document);
    rs = null; setDirty(true); placeControls();
  }
  U('rsz').addEventListener('dblclick', function (e) {
    var it = hoverItem, m = resizable(it); if (!m) return;
    e.preventDefault(); snapshot();
    var g = it.parentElement.matches('.figure-grid') ? it.parentElement : null;
    if (g) { clearCols(g); toast('Row back to equal widths'); }
    else { clearWidth(m); toast('Default size'); }
    placeControls();
  });
  function ratioOf(m) {
    var w = m.naturalWidth || m.videoWidth, h = m.naturalHeight || m.videoHeight;
    return w && h ? w / h : 0;
  }
  U('g-even').onclick = function () {
    var g = hoverGroup; if (!g || !g.matches('.figure-grid')) return;
    var n = gridTracks(g).length;
    if (n < 2) { toast('Widen the window: the row is stacked at this width.', true); return; }
    var sum = [], cnt = [];
    $$(':scope > figure', g).forEach(function (f, i) {
      var r = ratioOf(f.querySelector('img, video') || {}); if (!r) return;
      var c = i % n; sum[c] = (sum[c] || 0) + r; cnt[c] = (cnt[c] || 0) + 1;
    });
    var r = []; for (var c = 0; c < n; c++) { if (!cnt[c]) { toast('An image in this row has not loaded yet.', true); return; } r.push(sum[c] / cnt[c]); }
    snapshot(); setTrackWidths(g, r); ensureSizingCSS(document);
    toast('Widths set so the images share one height'); placeControls();
  };
  U('g-reset').onclick = function () {
    var g = hoverGroup; if (!g) return;
    snapshot(); clearCols(g); toast('Row back to equal widths'); placeControls();
  };

  /* -------------------------------------------------------- row height */
  var rh = null;
  function rowMedia(g) { return $$(':scope > figure img, :scope > figure video', g); }
  function rowBox(g) {
    var ms = rowMedia(g); if (!ms.length) return null;
    var gr = g.getBoundingClientRect(), bottom = 0, h = 0;
    ms.forEach(function (m) { var r = m.getBoundingClientRect(); if (r.bottom > bottom) bottom = r.bottom; if (r.height > h) h = r.height; });
    return { cx: gr.left + gr.width / 2, bottom: bottom, h: h };
  }
  function clearRowH(g) {
    g.style.removeProperty('--row-h');
    if (!g.getAttribute('style')) g.removeAttribute('style');
  }
  U('rh').addEventListener('pointerdown', function (e) {
    var g = hoverGroup; if (!g || !g.matches('.figure-grid')) return;
    var rb = rowBox(g); if (!rb) return;
    e.preventDefault(); e.stopPropagation();
    snapshot(); ensureSizingCSS(document);
    rh = { g: g, y: e.clientY, h: rb.h };
    U('ictl').style.display = 'none'; U('gctl').style.display = 'none'; U('rsz').style.display = 'none';
    document.addEventListener('pointermove', onRowH);
    document.addEventListener('pointerup', endRowH, { once: true });
  });
  function onRowH(e) {
    var h = Math.round(Math.max(80, Math.min(1400, rh.h + (e.clientY - rh.y))));
    rh.g.style.setProperty('--row-h', h + 'px');
    rsLabel('Row height ' + h + ' px', e);
    var rb = rowBox(rh.g), hh = U('rh');
    if (rb) { hh.style.left = rb.cx + 'px'; hh.style.top = (rb.bottom - 6) + 'px'; }
  }
  function endRowH() {
    document.removeEventListener('pointermove', onRowH);
    U('rszlbl').style.display = 'none';
    rh = null; setDirty(true); placeControls();
  }
  U('rh').addEventListener('dblclick', function (e) {
    var g = hoverGroup; if (!g) return;
    e.preventDefault(); snapshot(); clearRowH(g); toast('Row height back to default'); placeControls();
  });

  /* ------------------------------------------------------------- drag */
  var drag = null;
  function startDrag(kind, e) {
    var el = kind === 'item' ? hoverItem : hoverGroup;
    if (!el) return;
    e.preventDefault();
    drag = { kind: kind, el: el, target: null };
    el.setAttribute('data-ed-dragging', '');
    var g = U('ghost');
    g.textContent = kind === 'item' ? (el.querySelector('figcaption') ? el.querySelector('figcaption').textContent.slice(0, 40) : 'Moving item') : 'Moving image row';
    g.style.display = 'block';
    U('ictl').style.display = 'none'; U('gctl').style.display = 'none';
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd, { once: true });
    onDragMove(e);
  }
  U('i-drag').addEventListener('pointerdown', function (e) { startDrag('item', e); });
  U('g-drag').addEventListener('pointerdown', function (e) { startDrag('group', e); });

  function showLine(r, vertical) {
    var l = U('line'); l.style.display = 'block';
    if (vertical) { l.style.left = r.x - 2 + 'px'; l.style.top = r.top + 'px'; l.style.width = '4px'; l.style.height = r.h + 'px'; }
    else { l.style.left = r.left + 'px'; l.style.top = r.y - 2 + 'px'; l.style.width = r.w + 'px'; l.style.height = '4px'; }
  }
  function onDragMove(e) {
    var g = U('ghost'); g.style.left = e.clientX + 14 + 'px'; g.style.top = e.clientY + 10 + 'px';
    host.style.visibility = 'hidden';
    var el = document.elementFromPoint(e.clientX, e.clientY);
    host.style.visibility = '';
    drag.target = null; U('line').style.display = 'none';
    if (!el || !root.contains(el) || drag.el.contains(el)) return;
    var dEl = drag.el, isLocked = dEl.matches(LOCKED_GROUP_ITEMS);
    var it = el.closest(ITEM_SEL);
    if (it && !root.contains(it)) it = null;
    if (drag.kind === 'item' && it && it !== dEl) {
      var r = it.getBoundingClientRect();
      var inGroup = it.parentElement.matches(GROUP_SEL);
      if (isLocked && it.parentElement !== dEl.parentElement) return;
      if (inGroup) {
        var after = e.clientX > r.left + r.width / 2;
        drag.target = { mode: 'sibling', ref: it, after: after };
        showLine({ x: after ? r.right + 6 : r.left - 6, top: r.top, h: r.height }, true); return;
      }
      if (dEl.matches('figure') && it.matches('figure')) {
        var fx = (e.clientX - r.left) / r.width;
        if (fx < 0.25 || fx > 0.75) {
          drag.target = { mode: 'pair', ref: it, after: fx > 0.75 };
          showLine({ x: fx > 0.75 ? r.right + 6 : r.left - 6, top: r.top, h: r.height }, true); return;
        }
      }
    }
    if (isLocked) return;
    var blk = topBlock(el);
    if (!blk || blk === dEl) return;
    var br = blk.getBoundingClientRect(), rr = root.getBoundingClientRect();
    var below = e.clientY > br.top + br.height / 2;
    drag.target = { mode: 'block', ref: blk, after: below };
    showLine({ left: rr.left, w: rr.width, y: below ? br.bottom + 4 : br.top - 4 }, false);
  }
  function onDragEnd() {
    document.removeEventListener('pointermove', onDragMove);
    U('ghost').style.display = 'none'; U('line').style.display = 'none';
    var d = drag; drag = null;
    d.el.removeAttribute('data-ed-dragging');
    var t = d.target; if (!t) { clearHover(); return; }
    snapshot();
    var el = d.el;
    if (t.mode === 'sibling') { t.after ? t.ref.after(el) : t.ref.before(el); }
    else if (t.mode === 'pair') {
      var grid = document.createElement('div'); grid.className = 'figure-grid cols-2';
      t.ref.before(grid);
      if (t.after) { grid.appendChild(t.ref); grid.appendChild(el); } else { grid.appendChild(el); grid.appendChild(t.ref); }
      $$(':scope > figure', grid).forEach(function (f) { f.classList.remove('figure', 'figure-wide', 'figure-narrow'); if (!f.className) f.removeAttribute('class'); });
    } else {
      t.after ? t.ref.after(el) : t.ref.before(el);
    }
    tidy(); clearHover();
  }

  /* -------------------------------------------------------- image picker */
  var pickCb = null;
  function closeModal() { U('modal').style.display = 'none'; pickCb = null; }
  U('m-close').onclick = closeModal;
  U('modal').addEventListener('click', function (e) { if (e.target === U('modal')) closeModal(); });
  async function listImages() {
    var dir = await getPageDir(true);
    if (!dir) return null;
    var out = [];
    try {
      var imgDir = await dir.getDirectoryHandle('images', { create: true });
      for await (var entry of imgDir.values()) {
        if (entry.kind === 'file' && /\.(jpe?g|png|gif|webp|svg|avif)$/i.test(entry.name)) out.push(entry.name);
      }
    } catch (e) { return null; }
    return out.sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
  }
  async function openPicker(title, cb) {
    pickCb = cb;
    U('m-title').textContent = title;
    var body = U('m-body');
    body.className = 'msg'; body.textContent = 'Loading images…';
    U('modal').style.display = 'flex';
    var names = await listImages();
    if (!names) {
      body.textContent = FSA ? 'Pick your Portfolio folder to browse this project’s images.' :
        'This browser can’t browse folders. Use “Add new image…” and pick a file that is already in this project’s images folder.';
      return;
    }
    var used = {};
    $$('img', root).forEach(function (i) { used[(i.getAttribute('src') || '').split('/').pop()] = 1; });
    body.className = 'grid'; body.innerHTML = '';
    names.forEach(function (n) {
      var d = document.createElement('div'); d.className = 'th' + (used[n] ? ' used' : '');
      var im = document.createElement('img'); im.loading = 'lazy'; im.src = 'images/' + encodeURIComponent(n);
      var cap = document.createElement('div'); cap.textContent = (used[n] ? '✓ ' : '') + n;
      d.appendChild(im); d.appendChild(cap);
      d.onclick = function () { var c = pickCb; closeModal(); c && c('images/' + n); };
      body.appendChild(d);
    });
    if (!names.length) { body.className = 'msg'; body.textContent = 'No images yet. Use “Add new image…”.'; }
  }
  U('m-upload').onclick = function () {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async function () {
      var f = inp.files[0]; if (!f) return;
      var name = f.name.replace(/[^\w.\-]+/g, '-').toLowerCase();
      var dir = await getPageDir(true);
      if (dir) {
        try {
          var imgDir = await dir.getDirectoryHandle('images', { create: true });
          var fh = await imgDir.getFileHandle(name, { create: true });
          var w = await fh.createWritable(); await w.write(f); await w.close();
          toast('Copied into images/' + name);
        } catch (e) { toast('Could not copy the image: ' + e.message, true); return; }
      } else {
        toast('Linked as images/' + name + ' — make sure the file is in this project’s images folder.');
      }
      var c = pickCb; closeModal(); c && c('images/' + name);
    };
    inp.click();
  };
  U('i-swap').onclick = function () {
    var it = hoverItem; if (!it) return;
    var img = it.querySelector('img'); if (!img) return;
    openPicker('Swap image', function (src) {
      snapshot();
      img.setAttribute('src', src);
      img.removeAttribute('srcset');
      var a = img.closest('a'); if (a && /\.(jpe?g|png|gif|webp)$/i.test(a.getAttribute('href') || '')) a.setAttribute('href', src);
    });
  };
  var lastCaretBlock = null;
  document.addEventListener('selectionchange', function () {
    if (!editing) return;
    var s = document.getSelection(); if (!s || !s.anchorNode) return;
    var n = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
    if (n && root.contains(n) && n !== root) lastCaretBlock = topBlock(n);
  });
  U('addimg').onclick = function () {
    var after = lastCaretBlock && root.contains(lastCaretBlock) ? lastCaretBlock : null;
    if (!after) { toast('Click into the paragraph the image should follow, then press + Image.'); return; }
    openPicker('Insert image', function (src) {
      snapshot();
      var f = document.createElement('figure');
      f.innerHTML = '<img src="' + src.replace(/"/g, '&quot;') + '" alt="" loading="lazy"><figcaption>Caption…</figcaption>';
      after.after(f);
      applyEditableAttrs();
      f.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  };

  /* ------------------------------------------------------- text matching */
  // Build a whitespace-normalised view of root's editable text with a map back to DOM positions.
  var SKIP_TEXT = 'script,style,pre,code,[data-ed-ui],.viewer-box,svg';
  function textIndex(skipMarks) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (!p || p.closest(SKIP_TEXT)) return NodeFilter.FILTER_REJECT;
        if (skipMarks && p.closest('mark.__ed-sugg')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var str = '', map = [], prevSpace = true, n, prevBlk = null, prevNode = null;
    var BLK = 'p,li,h1,h2,h3,h4,h5,h6,figcaption,td,th,div,figure,ul,ol,table,blockquote';
    while ((n = walker.nextNode())) {
      // block boundaries count as whitespace
      var blk = n.parentElement && n.parentElement.closest(BLK);
      if (prevNode && blk !== prevBlk && !prevSpace) { str += ' '; map.push([prevNode, prevNode.nodeValue.length]); prevSpace = true; }
      prevBlk = blk; prevNode = n;
      var t = n.nodeValue;
      for (var i = 0; i < t.length; i++) {
        var ch = t[i];
        if (/[\s\u00a0]/.test(ch)) { if (prevSpace) continue; ch = ' '; prevSpace = true; }
        else prevSpace = false;
        str += ch; map.push([n, i]);
      }
    }
    return { str: str, map: map };
  }
  function norm(s) { return s.replace(/[\s ]+/g, ' ').trim(); }
  function rangeFor(idx, start, len) {
    var a = idx.map[start], b = idx.map[start + len - 1];
    if (!a || !b) return null;
    var r = document.createRange();
    r.setStart(a[0], a[1]); r.setEnd(b[0], Math.min(b[1] + 1, b[0].nodeValue.length));
    return r;
  }
  function wrapRange(r, cls, attrs) {
    var m = document.createElement('mark'); m.className = cls;
    for (var k in attrs) m.setAttribute(k, attrs[k]);
    try { r.surroundContents(m); }
    catch (e) { m.appendChild(r.extractContents()); r.insertNode(m); }
    return m;
  }
  function unwrap(m) {
    var p = m.parentNode; if (!p) return;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m); p.normalize();
  }

  /* ---------------------------------------------------------- suggestions */
  var SUGG_KEY = 'ed-skipped:' + PAGE_DIR + '/' + PAGE_FILE;
  var suggLoaded = false;
  function loadSuggestions() {
    if (suggLoaded) { updateStatus(); return; }
    suggLoaded = true;
    var s = document.createElement('script');
    s.src = ASSETS + 'suggestions/' + PAGE_STEM + '.js';
    s.setAttribute('data-ed-ui', '');
    s.onload = function () {
      suggestions = (window.__PORTFOLIO_SUGGESTIONS__ || {})[PAGE_STEM] || [];
      var skipped = lsGet(SUGG_KEY, []), miss = 0;
      suggestions.forEach(function (sg, i) {
        sg.id = i;
        if (skipped.indexOf(norm(sg.find)) >= 0) return;
        var idx = textIndex(true), needle = norm(sg.find), at = idx.str.indexOf(needle);
        if (at < 0) { miss++; return; }
        var r = rangeFor(idx, at, needle.length); if (!r) { miss++; return; }
        wrapRange(r, '__ed-sugg', { 'data-ed-sid': i });
      });
      bindSuggestionMarks(); updateStatus();
      var n = $$('mark.__ed-sugg', root).length;
      if (n) toast(n + ' suggestions on this page. Click a yellow underline or press Suggestions.');
      if (miss && window.console) console.info('[edit-mode] ' + miss + ' suggestion(s) no longer match the text (already edited?)');
    };
    s.onerror = function () { s.remove(); updateStatus(); };
    document.head.appendChild(s);
  }
  function bindSuggestionMarks() {
    $$('mark.__ed-sugg', root).forEach(function (m) {
      if (m.__edBound) return; m.__edBound = true;
      m.addEventListener('click', function (e) { if (!editing) return; e.preventDefault(); openPop(m); });
    });
  }
  var popMark = null;
  function closePop() {
    U('pop').style.display = 'none';
    if (popMark) popMark.classList.remove('__ed-active');
    popMark = null;
  }
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function openPop(m) {
    closePop();
    var sg = suggestions[+m.getAttribute('data-ed-sid')]; if (!sg) return;
    popMark = m; m.classList.add('__ed-active');
    var p = U('pop');
    p.innerHTML = '<div class="lbl">Current</div><div class="orig">' + esc(m.textContent) + '</div>' +
      '<div class="lbl" style="margin-top:10px">Suggested (edit freely)</div><textarea id="p-txt"></textarea>' +
      (sg.note ? '<div class="note">' + esc(sg.note) + '</div>' : '<div class="note"></div>') +
      '<div class="row"><button id="p-skip">Keep mine</button><button id="p-next">Later ›</button><button id="p-ok" class="primary">Accept</button></div>';
    sh.getElementById('p-txt').value = sg.replace;
    p.style.display = 'block';
    var r = m.getBoundingClientRect(), ph = p.offsetHeight, pw = p.offsetWidth;
    var top = r.bottom + 8; if (top + ph > innerHeight - 70) top = Math.max(8, r.top - ph - 8);
    p.style.top = top + 'px'; p.style.left = Math.min(Math.max(8, r.left), innerWidth - pw - 8) + 'px';
    sh.getElementById('p-ok').onclick = function () {
      snapshot();
      var v = sh.getElementById('p-txt').value;
      var tpl = document.createElement('template'); tpl.innerHTML = v;
      var mk = popMark; closePop();
      mk.replaceWith(tpl.content);
      root.normalize && root.normalize();
      updateStatus(); nextSugg(mk);
    };
    sh.getElementById('p-skip').onclick = function () {
      var sk = lsGet(SUGG_KEY, []); sk.push(norm(sg.find)); lsSet(SUGG_KEY, sk);
      var mk = popMark; closePop(); var after = mk.nextSibling; unwrap(mk); updateStatus(); nextSugg(null, after);
    };
    sh.getElementById('p-next').onclick = function () { var mk = popMark; closePop(); nextSugg(mk); };
  }
  function nextSugg(fromMark, fromNode) {
    var marks = $$('mark.__ed-sugg', root); if (!marks.length) { toast('No suggestions left on this page.'); return; }
    var ref = fromMark && fromMark.isConnected ? fromMark : fromNode;
    var nxt = marks[0];
    if (ref) {
      for (var i = 0; i < marks.length; i++) {
        if (marks[i] !== ref && (ref.compareDocumentPosition(marks[i]) & Node.DOCUMENT_POSITION_FOLLOWING)) { nxt = marks[i]; break; }
      }
    }
    nxt.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(function () { openPop(nxt); }, 380);
  }
  U('sugg').onclick = function () { nextSugg(popMark); };
  document.addEventListener('mousedown', function (e) {
    if (!popMark) return;
    if (e.composedPath().indexOf(U('pop')) >= 0) return;
    if (e.target.closest && e.target.closest('mark.__ed-sugg')) return;
    closePop();
  });

  /* ------------------------------------------------------------ AI tells */
  var TELLS = [
    [/\s?[—]\s?/g, 'Em dash. A few are fine; dozens per page is a strong AI tell. Try a period, comma, colon or parentheses.'],
    [/\bnot (just|only|merely|simply)\b[^.?!]{0,80}?\bbut( also)?\b/gi, '“Not just X, but Y” construction.'],
    [/\b(it|this|that)['’]?s not (about )?[^.?!,;]{1,50}[,;—]\s*(it|this|that)['’]?s\b/gi, '“It’s not X, it’s Y” construction.'],
    [/\b(the (result|answer|catch|fix|problem|twist|kicker|trick|culprit|verdict|takeaway|lesson|payoff|short version))\?/gi, 'Rhetorical question set-up (“The result?”).'],
    [/\b(here['’]s the (thing|catch|kicker|twist|trick)|that['’]s where|this is where|enter(s)? the)\b/gi, 'Stock transition phrase.'],
    [/\b(seamless(ly)?|robust(ly)?|leverag(e|ed|es|ing)|delv(e|es|ed|ing)|intricate|meticulous(ly)?|pivotal|crucial(ly)?|elevat(e|es|ed|ing)|harness(ed|ing)?|unlock(s|ed|ing)?|showcas(e|es|ed|ing)|testament|tapestry|realm|empower(s|ed|ing)?|cutting[- ]edge|game[- ]chang(er|ing)|streamlin(e|ed|es|ing)|holistic|synerg\w*|paradigm|bespoke|nuanced|navigat(e|es|ed|ing) the|landscape)\b/gi, 'Buzzword that reads as AI-written. Usually a plainer word works.'],
    [/\b(furthermore|moreover|additionally|notably|importantly|ultimately|essentially|in essence|in summary|in conclusion|overall,|it['’]?s worth (noting|mentioning)|it should be noted|needless to say)\b/gi, 'Filler connector.'],
    [/\b(a deep dive|deep[- ]dive|dive (into|deeper)|at its (core|heart)|the key (insight|takeaway|idea)|the real (challenge|problem|trick|question|story|work|lesson)|sweet spot|best of both worlds|the heavy lifting|under the hood|the magic happens|rabbit hole)\b/gi, 'Stock phrase.'],
    [/\b(elegant(ly)?|clever(ly)?|beautiful(ly)?|incredibly|remarkabl[ey]|surprisingly|genuinely|truly|perfectly)\b/gi, 'Self-praise or intensifier. Let the work speak.'],
    [/\b(\w+), (\w+),? and (\w+)\b(?=[.!])/g, 'List of three at the end of a sentence. Fine sometimes; a pattern if everywhere.']
  ];
  function toggleTells() {
    tellsOn = !tellsOn;
    U('tells').classList.toggle('on', tellsOn);
    if (!tellsOn) { $$('mark.__ed-tell', root).forEach(unwrap); return; }
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) { return n.parentElement && !n.parentElement.closest(SKIP_TEXT + ',mark.__ed-tell') ? 1 : 2; }
    });
    var nodes = [], n; while ((n = walker.nextNode())) nodes.push(n);
    var count = 0;
    nodes.forEach(function (node) {
      var hits = [];
      TELLS.forEach(function (t) {
        t[0].lastIndex = 0; var m;
        while ((m = t[0].exec(node.nodeValue))) { if (!m[0].length) { t[0].lastIndex++; continue; } hits.push([m.index, m.index + m[0].length, t[1]]); }
      });
      if (!hits.length) return;
      hits.sort(function (a, b) { return a[0] - b[0]; });
      var merged = []; hits.forEach(function (h) { var l = merged[merged.length - 1]; if (l && h[0] < l[1]) { l[1] = Math.max(l[1], h[1]); if (l[2].indexOf(h[2]) < 0) l[2] += '\n' + h[2]; } else merged.push(h.slice()); });
      for (var i = merged.length - 1; i >= 0; i--) {
        var h = merged[i], r = document.createRange();
        r.setStart(node, h[0]); r.setEnd(node, h[1]);
        wrapRange(r, '__ed-tell', { title: h[2] }); count++;
      }
    });
    toast(count + ' phrases flagged. Hover a red highlight to see why.');
  }
  U('tells').onclick = toggleTells;

  /* ------------------------------------------------------------- saving */
  function cleanClone() {
    var c = root.cloneNode(true);
    $$('[data-ed-ui]', c).forEach(function (e) { e.remove(); });
    $$('mark.__ed-sugg, mark.__ed-tell', c).forEach(unwrap);
    $$('[data-ed-item-hover],[data-ed-group-hover],[data-ed-dragging]', c).forEach(function (e) {
      e.removeAttribute('data-ed-item-hover'); e.removeAttribute('data-ed-group-hover'); e.removeAttribute('data-ed-dragging');
    });
    $$('[contenteditable]', c).forEach(function (e) { e.removeAttribute('contenteditable'); });
    $$('img[draggable]', c).forEach(function (e) { e.removeAttribute('draggable'); });
    c.removeAttribute('contenteditable'); c.removeAttribute('spellcheck');
    $$('[spellcheck]', c).forEach(function (e) { e.removeAttribute('spellcheck'); });
    $$('font', c).forEach(unwrap);
    // Chrome leaves a trailing &nbsp; when you type a space at the end of a paragraph; drop it
    $$('p,li,figcaption,h1,h2,h3,h4,h5,h6,td,th', c).forEach(function (b) {
      var t = b.lastChild;
      while (t && t.nodeType === 1 && t.lastChild && !/^(IMG|BR)$/.test(t.nodeName)) t = t.lastChild;
      if (t && t.nodeType === 3) t.nodeValue = t.nodeValue.replace(/[\u00a0 ]+$/, '');
    });
    return c;
  }
  function serialize(doc) {
    var dt = doc.doctype ? '<!DOCTYPE ' + doc.doctype.name + '>\n' : '<!DOCTYPE html>\n';
    return dt + doc.documentElement.outerHTML + '\n';
  }
  async function buildHTML(originalText) {
    var clean = cleanClone();
    if (originalText) {
      var doc = new DOMParser().parseFromString(originalText, 'text/html');
      var origRoot = root === document.body ? doc.body :
        doc.querySelector(root.id ? '#' + root.id : '.' + root.className.split(/\s+/)[0]);
      if (origRoot) {
        var origProt = $$(PROTECTED_SEL, origRoot);
        if (origProt.length !== PROTECTED_COUNT) throw new Error('the file on disk no longer matches this page (code blocks or viewers changed). Reload the page, then redo your edit.');
        $$('[data-ed-pid]', clean).forEach(function (el) {
          var o = origProt[+el.getAttribute('data-ed-pid')];
          if (o) el.replaceWith(o.cloneNode(true)); else el.removeAttribute('data-ed-pid');
        });
        origRoot.innerHTML = clean.innerHTML;
        if (origRoot.querySelector('[style*="--cols"], [style*="--row-h"]')) ensureSizingCSS(doc);
        // keep the root's own attributes from the file
        return serialize(doc);
      }
    }
    // fallback: live document, minus runtime artefacts
    $$('[data-ed-pid]', clean).forEach(function (el) { $$('canvas', el).forEach(function (cv) { cv.remove(); }); el.removeAttribute('data-ed-pid'); });
    var d2 = document.cloneNode(true);
    var r2 = root === document.body ? d2.body : d2.querySelector(root.id ? '#' + root.id : '.' + root.className.split(/\s+/)[0]);
    r2.innerHTML = clean.innerHTML;
    r2.removeAttribute('contenteditable'); r2.removeAttribute('spellcheck');
    $$('[data-ed-ui]', d2).forEach(function (e) { if (e.id !== '__edit-loader') e.remove(); });
    d2.body.removeAttribute('data-ed-on');
    return serialize(d2);
  }
  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  var backedUp = false, saving = false;
  async function save() {
    if (saving) return; saving = true;
    try {
      closePop();
      var dir = FSA ? await getPageDir(true) : null;
      if (dir) {
        var fh = await dir.getFileHandle(PAGE_FILE);
        var diskFile = await fh.getFile();
        if (diskFile.lastModified > Math.max(LOADED_AT, lastWriteAt) + 1500) {
          var go = window.confirm('This page was changed on disk after you opened it (for example by Claude, or in another tab).\n\n' +
            'Saving now would overwrite those changes with this older copy.\n\n' +
            'Click Cancel, copy anything you still need, and reload the page.\nClick OK only if you really want to overwrite the newer file.');
          if (!go) { toast('Not saved. Reload the page to get the latest version.', true); return; }
        }
        var original = await diskFile.text();
        var html = await buildHTML(original);
        if (!backedUp) {
          try {
            var bdirParent = rootDirHandle || dir;
            var bdir = await bdirParent.getDirectoryHandle('_edit-backups', { create: true });
            var bf = await bdir.getFileHandle(PAGE_STEM + '.' + stamp() + '.html', { create: true });
            var bw = await bf.createWritable(); await bw.write(original); await bw.close();
            backedUp = true;
          } catch (e) { console.warn('[edit-mode] backup failed', e); }
        }
        var w = await fh.createWritable(); await w.write(html); await w.close();
        try { lastWriteAt = (await fh.getFile()).lastModified; } catch (e) { lastWriteAt = Date.now(); }
        undoStack.length = 0;
        lastSaved = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        setDirty(false); toast('Saved to ' + (PAGE_DIR && !IS_ROOT_PAGE ? PAGE_DIR + '/' : '') + PAGE_FILE);
      } else {
        if (FSA) { toast('Not saved: no folder picked.', true); return; }
        var h2 = await buildHTML(null);
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([h2], { type: 'text/html' }));
        a.download = PAGE_FILE; document.body.appendChild(a); a.click(); a.remove();
        lastSaved = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        setDirty(false); toast('Downloaded ' + PAGE_FILE + '. Replace the file in your Portfolio folder with it.');
      }
    } catch (e) {
      console.error(e); toast('Save failed: ' + (e && e.message || e), true);
    } finally { saving = false; }
  }
  U('save').onclick = save;

  // test hook (used by automated checks; harmless otherwise)
  window.__portfolioEditor = { enter: enterEdit, exit: exitEdit, build: buildHTML, root: root, ui: sh, tells: toggleTells };
  updateStatus();
})();
