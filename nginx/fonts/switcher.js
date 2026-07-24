// Font switcher — injected into LibreChat by nginx (see nginx/default.conf).
// The CSS bundle's `font-family: Inter` declarations are rewritten by nginx to
// `var(--app-font, ...)`, so changing that one variable restyles the whole app.
// Built-in fonts can be hidden, and arbitrary Google Fonts can be added by name
// (loaded straight from fonts.googleapis.com). Everything persists in localStorage.
(() => {
  'use strict';
  if (window.__lcFontSwitcher) return;
  window.__lcFontSwitcher = true;

  const FONT_KEY = 'lc-font-family';
  const SIZE_KEY = 'lc-font-size';
  const CUSTOM_KEY = 'lc-font-custom';
  const HIDDEN_KEY = 'lc-font-hidden';

  const BUILTINS = [
    { id: 'aleo',     label: 'Aleo',            stack: '"Aleo", Georgia, Charter, serif' },
    { id: 'inter',    label: 'Inter (default)', stack: 'Inter, sans-serif' },
    { id: 'georgia',  label: 'Georgia',         stack: 'Georgia, "Times New Roman", serif' },
    { id: 'palatino', label: 'Palatino',        stack: '"Palatino Linotype", Palatino, "Book Antiqua", serif' },
    { id: 'optima',   label: 'Optima',          stack: 'Optima, Candara, "Segoe UI", sans-serif' },
    { id: 'system',   label: 'System UI',       stack: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  ];
  const SIZES = [14, 15, 16, 17, 18];
  const DEFAULT_SIZE = 16;

  const readJson = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch { return fallback; }
  };
  let custom = readJson(CUSTOM_KEY, []);
  let hidden = readJson(HIDDEN_KEY, []);

  const visibleFonts = () =>
    BUILTINS.filter((f) => !hidden.includes(f.id)).concat(custom);
  const allFonts = () => BUILTINS.concat(custom);

  const sizeStyle = document.createElement('style');
  sizeStyle.id = 'lcfs-size';
  document.head.appendChild(sizeStyle);

  let panel = null;

  const attachGfLink = (font) => {
    if (document.querySelector('link[data-lcfs-font="' + font.id + '"]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = font.href;
    link.dataset.lcfsFont = font.id;
    document.head.appendChild(link);
  };
  custom.forEach(attachGfLink);

  const applyFont = (id) => {
    const f = allFonts().find((x) => x.id === id) || BUILTINS[0];
    document.documentElement.style.setProperty('--app-font', f.stack);
    localStorage.setItem(FONT_KEY, f.id);
    if (panel) {
      panel.querySelectorAll('[data-font]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.font === f.id));
      });
    }
  };

  const applySize = (px) => {
    const size = SIZES.includes(px) ? px : DEFAULT_SIZE;
    sizeStyle.textContent = size === DEFAULT_SIZE ? '' : 'html{font-size:' + size + 'px !important}';
    localStorage.setItem(SIZE_KEY, String(size));
    if (panel) {
      const label = panel.querySelector('.lcfs-size-val');
      if (label) label.textContent = size + 'px';
    }
  };

  applyFont(localStorage.getItem(FONT_KEY) || 'aleo');
  applySize(parseInt(localStorage.getItem(SIZE_KEY), 10) || DEFAULT_SIZE);

  // Try progressively simpler Google Fonts css2 specs: variable weight range,
  // then the common static weights, then bare family (regular only).
  const GF_SPECS = [':ital,wght@0,300..700;1,300..700', ':ital,wght@0,400;0,700;1,400;1,700', ''];
  const gfUrl = (name, spec) =>
    'https://fonts.googleapis.com/css2?family=' +
    encodeURIComponent(name).replace(/%20/g, '+') + spec + '&display=swap';

  const loadGoogleFont = (name) => new Promise((resolve, reject) => {
    const tryNext = (i) => {
      if (i >= GF_SPECS.length) return reject(new Error('not found'));
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = gfUrl(name, GF_SPECS[i]);
      link.onload = () => resolve(link);
      link.onerror = () => { link.remove(); tryNext(i + 1); };
      document.head.appendChild(link);
    };
    tryNext(0);
  });

  const slug = (name) => 'gf-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const titleCase = (s) => s.trim().replace(/\s+/g, ' ')
    .replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

  const addGoogleFont = async (rawName) => {
    const name = titleCase(rawName);
    const id = slug(name);
    const existing = allFonts().find((f) => f.id === id);
    if (existing) { applyFont(existing.id); return existing; }
    const link = await loadGoogleFont(name);
    link.dataset.lcfsFont = id;
    const font = { id, label: name, stack: '"' + name + '", "Aleo", Georgia, serif', href: link.href };
    custom.push(font);
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
    return font;
  };

  const removeFont = (id) => {
    if (custom.some((f) => f.id === id)) {
      custom = custom.filter((f) => f.id !== id);
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
      const link = document.querySelector('link[data-lcfs-font="' + id + '"]');
      if (link) link.remove();
    } else if (!hidden.includes(id)) {
      hidden.push(id);
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden));
    }
    if (localStorage.getItem(FONT_KEY) === id) {
      applyFont((visibleFonts()[0] || BUILTINS[0]).id);
    }
  };

  const resetList = () => {
    custom.forEach((f) => {
      const link = document.querySelector('link[data-lcfs-font="' + f.id + '"]');
      if (link) link.remove();
    });
    custom = [];
    hidden = [];
    localStorage.removeItem(CUSTOM_KEY);
    localStorage.removeItem(HIDDEN_KEY);
    if (!visibleFonts().some((f) => f.id === localStorage.getItem(FONT_KEY))) applyFont('aleo');
  };

  const css = `
    .lcfs-btn{position:fixed;bottom:14px;right:14px;z-index:2147483000;width:30px;height:30px;
      border-radius:50%;border:1px solid rgba(128,128,128,.35);background:rgba(40,40,44,.72);
      color:#e8e8e8;font:600 13px/1 Georgia,serif;cursor:pointer;backdrop-filter:blur(6px);
      opacity:.45;transition:opacity .15s;padding:0}
    .lcfs-btn:hover,.lcfs-btn:focus-visible,.lcfs-btn[aria-expanded="true"]{opacity:1}
    .lcfs-panel{position:fixed;bottom:52px;right:14px;z-index:2147483000;width:236px;
      max-height:min(70vh,520px);overflow-y:auto;border-radius:12px;
      border:1px solid rgba(128,128,128,.3);background:rgba(32,32,36,.94);
      color:#ececec;backdrop-filter:blur(10px);box-shadow:0 8px 28px rgba(0,0,0,.35);
      padding:10px;font-size:14px}
    .lcfs-panel h3{margin:2px 4px 8px;font:600 11px/1 system-ui,sans-serif;
      letter-spacing:.08em;text-transform:uppercase;color:#9a9aa0}
    .lcfs-row{display:flex;align-items:center;margin:2px 0}
    .lcfs-row [data-font]{flex:1;text-align:left;padding:7px 10px;border:0;border-radius:8px;
      background:none;color:inherit;cursor:pointer;font-size:15px;min-width:0;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .lcfs-row [data-font]:hover{background:rgba(255,255,255,.08)}
    .lcfs-row [data-font][aria-pressed="true"]{background:rgba(255,255,255,.14)}
    .lcfs-row [data-font][aria-pressed="true"]::after{content:" ✓";float:right;opacity:.7}
    .lcfs-x{width:22px;height:22px;margin-left:2px;border:0;border-radius:6px;background:none;
      color:#9a9aa0;cursor:pointer;font-size:14px;line-height:1;padding:0;flex:none;
      opacity:0;transition:opacity .1s}
    .lcfs-row:hover .lcfs-x,.lcfs-x:focus-visible{opacity:1}
    .lcfs-x:hover{background:rgba(255,80,80,.18);color:#ff8080}
    .lcfs-add-toggle{display:block;width:100%;text-align:left;padding:7px 10px;margin:6px 0 2px;
      border:0;border-radius:8px;background:none;color:#9a9aa0;cursor:pointer;
      font:500 13px system-ui,sans-serif}
    .lcfs-add-toggle:hover{background:rgba(255,255,255,.08);color:#ececec}
    .lcfs-add-form{display:flex;gap:6px;margin:4px 0 2px}
    .lcfs-add-form input{flex:1;min-width:0;padding:6px 9px;border-radius:8px;
      border:1px solid rgba(128,128,128,.35);background:rgba(0,0,0,.25);color:#ececec;
      font-size:13px;outline:none}
    .lcfs-add-form input:focus{border-color:rgba(160,160,255,.6)}
    .lcfs-add-form input.lcfs-err{border-color:rgba(255,90,90,.8)}
    .lcfs-add-form button{padding:6px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.35);
      background:rgba(255,255,255,.08);color:#ececec;cursor:pointer;font-size:13px;flex:none}
    .lcfs-add-form button:hover{background:rgba(255,255,255,.14)}
    .lcfs-hint{margin:2px 4px 0;font:400 11px system-ui,sans-serif;color:#9a9aa0;min-height:14px}
    .lcfs-hint.lcfs-err{color:#ff8080}
    .lcfs-sizes{display:flex;align-items:center;gap:8px;margin:8px 4px 2px;
      font:500 13px system-ui,sans-serif}
    .lcfs-sizes button{width:26px;height:26px;border-radius:7px;border:1px solid rgba(128,128,128,.35);
      background:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0}
    .lcfs-sizes button:hover{background:rgba(255,255,255,.08)}
    .lcfs-size-val{flex:1;text-align:center;color:#bdbdc2}
    .lcfs-reset{display:block;width:100%;margin:6px 0 0;padding:4px;border:0;background:none;
      color:#9a9aa0;cursor:pointer;font:400 11px system-ui,sans-serif;text-align:center}
    .lcfs-reset:hover{color:#ececec;text-decoration:underline}
    @media (max-width:767px){
      .lcfs-btn{bottom:120px;right:10px}
      .lcfs-panel{bottom:158px;right:10px;width:min(236px,calc(100vw - 20px))}
    }`;
  const uiStyle = document.createElement('style');
  uiStyle.textContent = css;
  document.head.appendChild(uiStyle);

  const btn = document.createElement('button');
  btn.className = 'lcfs-btn';
  btn.textContent = 'Aa';
  btn.setAttribute('aria-label', 'Font settings');
  btn.setAttribute('aria-expanded', 'false');

  let addFormOpen = false;

  const render = () => {
    if (!panel) return;
    panel.textContent = '';
    const h = document.createElement('h3');
    h.textContent = 'Font';
    panel.appendChild(h);

    const active = localStorage.getItem(FONT_KEY);
    visibleFonts().forEach((f) => {
      const row = document.createElement('div');
      row.className = 'lcfs-row';
      const b = document.createElement('button');
      b.dataset.font = f.id;
      b.textContent = f.label;
      b.style.fontFamily = f.stack;
      b.setAttribute('aria-pressed', String(active === f.id));
      b.addEventListener('click', () => applyFont(f.id));
      const x = document.createElement('button');
      x.className = 'lcfs-x';
      x.textContent = '×';
      x.setAttribute('aria-label', 'Remove ' + f.label + ' from list');
      x.addEventListener('click', (e) => { e.stopPropagation(); removeFont(f.id); render(); });
      row.append(b, x);
      panel.appendChild(row);
    });

    if (addFormOpen) {
      const form = document.createElement('div');
      form.className = 'lcfs-add-form';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Google Font name…';
      input.setAttribute('aria-label', 'Google Font name');
      const add = document.createElement('button');
      add.textContent = 'Add';
      const hint = document.createElement('div');
      hint.className = 'lcfs-hint';
      hint.textContent = 'e.g. Lora, Spectral, Fraunces';
      const submit = async () => {
        const name = input.value.trim();
        if (!name) return;
        input.classList.remove('lcfs-err');
        hint.classList.remove('lcfs-err');
        hint.textContent = 'Loading ' + name + '…';
        add.disabled = true;
        try {
          const font = await addGoogleFont(name);
          applyFont(font.id);
          addFormOpen = false;
          render();
        } catch {
          input.classList.add('lcfs-err');
          hint.classList.add('lcfs-err');
          hint.textContent = 'Not found on Google Fonts — check spelling.';
          add.disabled = false;
        }
      };
      add.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.stopPropagation(); submit(); }
        if (e.key === 'Escape') { e.stopPropagation(); addFormOpen = false; render(); }
      });
      form.append(input, add);
      panel.append(form, hint);
      requestAnimationFrame(() => input.focus());
    } else {
      const toggle = document.createElement('button');
      toggle.className = 'lcfs-add-toggle';
      toggle.textContent = '+ Add Google Font…';
      toggle.addEventListener('click', (e) => { e.stopPropagation(); addFormOpen = true; render(); });
      panel.appendChild(toggle);
    }

    const sizes = document.createElement('div');
    sizes.className = 'lcfs-sizes';
    const minus = document.createElement('button');
    minus.textContent = '−';
    minus.setAttribute('aria-label', 'Smaller text');
    const val = document.createElement('span');
    val.className = 'lcfs-size-val';
    val.textContent = (parseInt(localStorage.getItem(SIZE_KEY), 10) || DEFAULT_SIZE) + 'px';
    const plus = document.createElement('button');
    plus.textContent = '+';
    plus.setAttribute('aria-label', 'Larger text');
    const step = (dir) => {
      const cur = parseInt(localStorage.getItem(SIZE_KEY), 10) || DEFAULT_SIZE;
      const idx = Math.min(Math.max(SIZES.indexOf(cur) + dir, 0), SIZES.length - 1);
      applySize(SIZES[idx]);
    };
    minus.addEventListener('click', () => step(-1));
    plus.addEventListener('click', () => step(1));
    sizes.append(minus, val, plus);
    panel.appendChild(sizes);

    if (hidden.length || custom.length) {
      const reset = document.createElement('button');
      reset.className = 'lcfs-reset';
      reset.textContent = 'Restore default list';
      reset.addEventListener('click', () => { resetList(); render(); });
      panel.appendChild(reset);
    }
  };

  const toggle = (open) => {
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'lcfs-panel';
      panel.setAttribute('role', 'menu');
      panel.hidden = true;
      document.body.appendChild(panel);
      render();
    }
    const show = open !== undefined ? open : panel.hidden;
    if (show) { addFormOpen = false; render(); }
    panel.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
  };

  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener('click', (e) => {
    if (!e.target.isConnected) return;
    if (panel && !panel.hidden && !panel.contains(e.target) && e.target !== btn) toggle(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel && !panel.hidden) toggle(false);
  });

  const mount = () => document.body && document.body.appendChild(btn);
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
