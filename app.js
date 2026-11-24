'use strict';
(() => {
  const CFG = window.APP_CONFIG || {};
  // Read-only: the app can never change or delete anything in your Drive.
  const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';
  const API = 'https://www.googleapis.com/drive/v3';
  const CONFIGURED = !!CFG.CLIENT_ID && !CFG.CLIENT_ID.startsWith('YOUR_');
  const VERIFIER_PLAINTEXT = 'tonote-vault-verifier-v1';
  const CHECK_EVERY_MS = 2 * 60_000;

  // ---------- small persistence (localStorage, best effort) ----------
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem('tr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; }
    },
    set(k, v) { try { localStorage.setItem('tr.' + k, JSON.stringify(v)); } catch { /* full or blocked */ } },
    del(k) { try { localStorage.removeItem('tr.' + k); } catch { /* ignore */ } },
  };

  // ---------- IndexedDB: holds the open document (can be bigger than localStorage allows) ----------
  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('rove-tonote-reader', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
    const run = (mode, fn) => open().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    }));
    return {
      get: (k) => run('readonly', (s) => s.get(k)).catch(() => undefined),
      set: (k, v) => run('readwrite', (s) => s.put(v, k)).catch((e) => console.warn('IndexedDB write failed', e)),
      del: (k) => run('readwrite', (s) => s.delete(k)).catch(() => {}),
    };
  })();

  // ---------- state ----------
  const state = {
    // {source: 'drive'|'local', id?, name, modifiedTime?, checkedAt?}
    meta: null,
    doc: null,            // parsed ToNote document
    byId: new Map(),      // id -> note
    childrenOf: new Map(),// parentId|'' -> [note] sorted
    key: null,            // CryptoKey while unlocked (memory only)
    plain: new Map(),     // id -> decrypted content while unlocked (memory only)
    expanded: new Set(store.get('expanded', [])),
    filter: '',
    showPasswords: false,
    fileHandle: null,
  };
  let token = store.get('token', null); // {value, exp}

  const $ = (s) => document.querySelector(s);
  const els = {
    tree: $('#tree'), filter: $('#filter'), count: $('#count'), detail: $('#detail'),
    status: $('#status'), syncBtn: $('#sync-btn'), docBtn: $('#doc-btn'), docName: $('#doc-name'),
    picker: $('#picker'), pickerBody: $('#picker-body'), fileInput: $('#file-input'),
    lockBtn: $('#lock-btn'), expandBtn: $('#expand-btn'), collapseBtn: $('#collapse-btn'),
  };

  // ---------- helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const sanitize = (html) => (window.DOMPurify ? DOMPurify.sanitize(html) : esc(html));
  const linkify = (text) => esc(text).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g,
    (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  }
  const svg = (inner, cls = 'ico', size = 18) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size); s.setAttribute('height', size);
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = inner;
    return s;
  };
  const ICONS = {
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    folderOpen: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1H8.5a2 2 0 0 0-1.9 1.4L4 19"/><path d="M4 19h13.5a2 2 0 0 0 1.9-1.4L22 10H8.5"/>',
    markdown: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
    todo: '<rect x="3" y="4" width="6" height="6" rx="1"/><path d="m4.5 15.5 1.5 1.5 3-3M13 7h8M13 16h8"/>',
    'password-grid': '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M17 6l2.5 2.5M14.5 8.5 17 11"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
  };
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  function toast(msg) {
    document.querySelector('.toast')?.remove();
    document.body.append(el('div', { class: 'toast', role: 'status' }, msg));
    setTimeout(() => document.querySelector('.toast')?.remove(), 1900);
  }

  // ---------- ToNote document format ----------
  function parseDocument(raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('This file is not valid JSON.'); }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.notes) || !('formatVersion' in parsed)) {
      throw new Error('This file is not a Rove ToNote document.');
    }
    if (parsed.formatVersion !== 1) throw new Error(`Unsupported ToNote format version: ${parsed.formatVersion}`);
    parsed.notes = parsed.notes.filter((n) => n && typeof n.id === 'string' && !n.deletedAt);
    return parsed;
  }

  function indexDocument() {
    state.byId = new Map(state.doc.notes.map((n) => [n.id, n]));
    state.childrenOf = new Map();
    for (const n of state.doc.notes) {
      const p = n.parentId && state.byId.has(n.parentId) ? n.parentId : '';
      if (!state.childrenOf.has(p)) state.childrenOf.set(p, []);
      state.childrenOf.get(p).push(n);
    }
    for (const list of state.childrenOf.values()) list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }
  const kids = (id) => state.childrenOf.get(id || '') || [];
  function ancestors(note) {
    const out = [];
    const seen = new Set();
    let p = note.parentId && state.byId.get(note.parentId);
    while (p && !seen.has(p.id)) { seen.add(p.id); out.unshift(p); p = p.parentId && state.byId.get(p.parentId); }
    return out;
  }

  // Readable content of a note, or null if it's encrypted and locked.
  function contentOf(note) {
    if (!note.isEncrypted) return note.content || '';
    return state.plain.has(note.id) ? state.plain.get(note.id) : null;
  }

  // To-do lists: GFM task items with tonote metadata in HTML comments.
  const META_RE = /^<!--\s*tonote:todo meta v1 sortMode="(manual|priority|alphabetical)"\s*-->\s*$/;
  const ITEM_RE = /^- \[([ xX])]\s*(.*?)\s*<!--\s*tonote:item id="([^"]+)"\s*priority="(high|medium|low|none)"(?:\s*completedAt="([^"]*)")?\s*-->\s*$/;
  const NOTE_RE = /^ {2}- <!--\s*tonote:note id="([^"]+)"\s*-->\s?(.*)$/;
  const CONT_RE = /^ {4,}(.*)$/;
  function parseTodo(content) {
    let sortMode = 'manual';
    const items = [];
    let item = null, note = null;
    for (const line of content.split(/\r?\n/)) {
      let m;
      if ((m = line.match(META_RE))) { sortMode = m[1]; item = note = null; continue; }
      if ((m = line.match(ITEM_RE))) {
        item = { text: m[2], checked: m[1].toLowerCase() === 'x', priority: m[4], completedAt: m[5] || '', notes: [] };
        items.push(item); note = null; continue;
      }
      if ((m = line.match(NOTE_RE)) && item) { note = { text: m[2] }; item.notes.push(note); continue; }
      if ((m = line.match(CONT_RE)) && note) { note.text += (note.text ? '\n' : '') + m[1]; continue; }
      // Plain GFM task lines with no tonote metadata (e.g. edited elsewhere).
      if ((m = line.match(/^- \[([ xX])]\s+(.*)$/))) {
        item = { text: m[2], checked: m[1].toLowerCase() === 'x', priority: 'none', completedAt: '', notes: [] };
        items.push(item); note = null;
      }
    }
    for (const i of items) i.notes = i.notes.filter((n) => n.text.trim());
    return { sortMode, items };
  }
  const RANK = { high: 0, medium: 1, low: 2, none: 3 };
  function sortTodo(items, mode) {
    if (mode === 'manual') return items;
    const c = [...items];
    if (mode === 'priority') c.sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.text.localeCompare(b.text));
    else c.sort((a, b) => a.text.localeCompare(b.text));
    return c;
  }

  function parsePasswordGrid(content) {
    try {
      const p = JSON.parse(content || '{}');
      if (!Array.isArray(p.entries)) return [];
      return p.entries.filter((e) => e && typeof e === 'object').map((e) => ({
        name: String(e.name ?? ''), username: String(e.username ?? ''),
        password: String(e.password ?? ''), note: String(e.note ?? ''),
      })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    } catch { return []; }
  }

  // Text used by the tree filter (todo/password metadata stripped out).
  const searchCache = new Map();
  function searchText(note) {
    const content = contentOf(note);
    if (content == null) return '';
    const key = note.id + '|' + note.updatedAt + '|' + content.length;
    let v = searchCache.get(key);
    if (v == null) {
      let t = content;
      if (note.type === 'todo') t = parseTodo(content).items.map((i) => [i.text, ...i.notes.map((n) => n.text)].join(' ')).join(' ');
      else if (note.type === 'password-grid') t = parsePasswordGrid(content).map((e) => `${e.name} ${e.username} ${e.note}`).join(' ');
      v = norm(t);
      searchCache.set(key, v);
    }
    return v;
  }

  // ---------- encryption (PBKDF2-SHA256 + AES-256-GCM, same as Rove ToNote) ----------
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  async function deriveKey(password, vault) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: fromB64(vault.salt), iterations: vault.kdfIterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }
  async function decrypt(key, env) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv) }, key, fromB64(env.ciphertext));
    return new TextDecoder().decode(pt);
  }
  async function unlock(password) {
    const vault = state.doc?.vault;
    if (!vault) throw new Error('This document has no password set.');
    const key = await deriveKey(password, vault);
    try {
      const v = await decrypt(key, { iv: vault.verifierIv, ciphertext: vault.verifierCiphertext });
      if (v !== VERIFIER_PLAINTEXT) throw new Error();
    } catch { throw new Error('Wrong password.'); }
    state.key = key;
    await decryptAll();
  }
  async function decryptAll() {
    state.plain = new Map();
    if (!state.key) return;
    for (const n of state.doc.notes) {
      if (!n.isEncrypted) continue;
      try { state.plain.set(n.id, await decrypt(state.key, JSON.parse(n.content))); }
      catch (e) { console.warn('Could not decrypt note', n.title, e); }
    }
  }
  function lock() {
    state.key = null;
    state.plain = new Map();
    state.showPasswords = false;
    searchCache.clear();
    render(true);
  }
  const hasEncrypted = () => !!state.doc?.notes.some((n) => n.isEncrypted);

  // ---------- Google auth ----------
  class AuthError extends Error {}
  let tokenClient = null;
  const tokenValid = () => !!token && token.exp > Date.now() + 60_000;

  function initTokenClient() {
    if (tokenClient || !CONFIGURED || !window.google?.accounts?.oauth2) return;
    tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CFG.CLIENT_ID, scope: SCOPES, callback: () => {} });
    renderAuth();
  }
  if (window.__gisLoaded) initTokenClient();
  else window.addEventListener('gis-loaded', initTokenClient);

  // Must be called synchronously from a user gesture (it may open a popup).
  function getToken() {
    if (tokenValid()) return Promise.resolve(token.value);
    return new Promise((resolve, reject) => {
      if (!CONFIGURED) return reject(new Error('Not configured: set CLIENT_ID in config.js'));
      if (!tokenClient) return reject(new Error('Google sign-in is still loading (or you are offline)'));
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(new AuthError(resp.error_description || resp.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPES)) {
          return reject(new AuthError('Google Drive access was not allowed. Sign in again and allow it.'));
        }
        token = { value: resp.access_token, exp: Date.now() + Number(resp.expires_in) * 1000 };
        store.set('token', token);
        store.set('signedInOnce', true);
        renderAuth();
        resolve(token.value);
      };
      tokenClient.error_callback = (err) => reject(new AuthError(
        err?.type === 'popup_closed' ? 'Sign-in window was closed' : (err?.message || 'Sign-in failed')));
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  // ---------- Drive API ----------
  async function api(url) {
    if (!tokenValid()) throw new AuthError('Sign in to Google Drive');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token.value}` } });
    if (res.status === 401) {
      token = null; store.del('token'); renderAuth();
      throw new AuthError('Google session expired. Sign in again.');
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error?.message || msg; } catch { /* not JSON */ }
      const e = new Error(msg); e.status = res.status; throw e;
    }
    return res;
  }
  const FILE_FIELDS = 'id,name,modifiedTime,size,parents';
  async function listFiles(q) {
    const out = [];
    let pageToken;
    do {
      const p = new URLSearchParams({
        q, fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: '1000', orderBy: 'modifiedTime desc',
        supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
      });
      if (pageToken) p.set('pageToken', pageToken);
      const j = await (await api(`${API}/files?${p}`)).json();
      out.push(...j.files);
      pageToken = j.nextPageToken;
    } while (pageToken);
    return out;
  }
  // Every .tonote file in My Drive's root, plus any others Drive's name search finds.
  async function listToNoteFiles() {
    const [root, named] = await Promise.all([
      listFiles("'root' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'"),
      listFiles("name contains 'tonote' and trashed=false").catch(() => []),
    ]);
    const byId = new Map();
    for (const f of [...root, ...named]) if (/\.tonote$/i.test(f.name)) byId.set(f.id, f);
    return [...byId.values()].sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
  }
  const fileMeta = async (id) => (await api(`${API}/files/${id}?fields=${FILE_FIELDS}&supportsAllDrives=true`)).json();
  const fileText = async (id) => (await api(`${API}/files/${id}?alt=media&supportsAllDrives=true`)).text();

  // ---------- loading documents ----------
  async function setDocument(raw, meta, { keepNote = false } = {}) {
    const doc = parseDocument(raw);
    const sameDoc = state.meta && meta.source === state.meta.source && meta.id === state.meta.id && meta.name === state.meta.name;
    state.doc = doc;
    state.meta = meta;
    indexDocument();
    searchCache.clear();
    if (sameDoc && state.key) await decryptAll();
    else { state.key = null; state.plain = new Map(); state.showPasswords = false; }
    await idb.set('doc', { raw, meta });
    store.set('meta', meta);
    if (!sameDoc && !keepNote) {
      // Open the document's first non-folder note, or nothing.
      const remembered = store.get('lastNote:' + docKey(meta));
      if (remembered && state.byId.has(remembered)) location.hash = 'n=' + remembered;
      else history.replaceState(null, '', location.pathname + location.search);
    }
    render(true);
  }
  const docKey = (meta) => meta ? `${meta.source}:${meta.id || meta.name}` : '';

  async function openDriveFile(f) {
    setStatus(`Opening ${f.name}…`);
    const raw = await fileText(f.id);
    await setDocument(raw, { source: 'drive', id: f.id, name: f.name, modifiedTime: f.modifiedTime, checkedAt: Date.now() });
    setStatus(`Opened ${f.name}`);
  }

  async function openLocalFile(file, handle = null) {
    const raw = await file.text();
    state.fileHandle = handle;
    if (handle) idb.set('handle', handle); else idb.del('handle');
    await setDocument(raw, { source: 'local', name: file.name, modifiedTime: new Date(file.lastModified).toISOString(), checkedAt: Date.now() });
    setStatus(`Opened ${file.name}`);
  }

  // Checks Drive for a newer copy of the open document.
  let checking = null;
  function refresh() {
    if (!checking) checking = doRefresh().finally(() => { checking = null; renderAuth(); });
    return checking;
  }
  async function doRefresh() {
    const meta = state.meta;
    if (!meta) return;
    if (meta.source === 'local') {
      if (!state.fileHandle) return;
      try {
        if ((await state.fileHandle.queryPermission?.({ mode: 'read' })) === 'denied') return;
        const file = await state.fileHandle.getFile();
        const mt = new Date(file.lastModified).toISOString();
        if (mt !== meta.modifiedTime) { await openLocalFile(file, state.fileHandle); setStatus('Reloaded: the file changed'); }
      } catch (e) { console.warn(e); }
      return;
    }
    if (!navigator.onLine) { setStatus('Offline: showing the saved copy'); return; }
    if (!tokenValid()) { renderAuth(); return; }
    renderAuth();
    try {
      const f = await fileMeta(meta.id);
      if (f.modifiedTime !== meta.modifiedTime || f.name !== meta.name) {
        setStatus('Downloading the newer version…');
        const raw = await fileText(f.id);
        await setDocument(raw, { source: 'drive', id: f.id, name: f.name, modifiedTime: f.modifiedTime, checkedAt: Date.now() }, { keepNote: true });
        setStatus('Updated from Drive');
      } else {
        state.meta.checkedAt = Date.now();
        store.set('meta', state.meta);
        idb.get('doc').then((d) => { if (d && docKey(d.meta) === docKey(state.meta)) idb.set('doc', { ...d, meta: state.meta }); });
        setStatus('Up to date');
      }
    } catch (e) {
      if (e.status === 404) setStatus('This file is no longer on Drive. Showing the saved copy.', true);
      else handleError(e);
    }
  }

  function handleError(e) {
    console.error(e);
    if (e instanceof AuthError) { renderAuth(); setStatus(e.message, true); }
    else if (!navigator.onLine) setStatus('Offline: showing the saved copy', true);
    else if (e instanceof TypeError && /fetch|network/i.test(e.message)) setStatus('Network error', true);
    else setStatus(e.message, true);
  }

  // ---------- status & auth button ----------
  let statusTimer = null;
  function setStatus(msg, isError = false) {
    els.status.textContent = msg || '';
    els.status.classList.toggle('error', !!isError);
    clearTimeout(statusTimer);
    if (msg && !msg.endsWith('…')) statusTimer = setTimeout(() => { els.status.textContent = ''; els.status.classList.remove('error'); }, isError ? 8000 : 3500);
  }
  function renderAuth() {
    const btn = els.syncBtn;
    const signedIn = tokenValid() || store.get('signedInOnce', false);
    btn.hidden = !CONFIGURED || (state.meta?.source === 'local' && !state.fileHandle);
    btn.disabled = !!checking;
    btn.textContent = checking ? 'Checking…' : !signedIn && state.meta?.source !== 'local' ? 'Sign in' : 'Refresh';
    btn.title = state.meta ? 'Check for a newer version of this document' : '';
  }
  els.syncBtn.addEventListener('click', async () => {
    if (state.meta?.source === 'local') {
      try { await state.fileHandle?.requestPermission?.({ mode: 'read' }); } catch { /* ignore */ }
      return refresh();
    }
    getToken().then(() => (state.meta ? refresh() : openPicker())).catch(handleError);
  });

  // ---------- document picker ----------
  async function openPicker() {
    if (!els.picker.open) els.picker.showModal();
    const body = els.pickerBody;
    if (!CONFIGURED) {
      body.replaceChildren(el('p', { class: 'muted' }, 'Google Drive is not set up (see README.md). You can still open a file on this device.'));
      return;
    }
    if (!tokenValid()) {
      const b = el('button', { class: 'btn primary', type: 'button' }, 'Sign in to Google Drive');
      b.addEventListener('click', () => getToken().then(openPicker).catch((e) => { handleError(e); body.prepend(el('p', { class: 'muted' }, e.message)); }));
      body.replaceChildren(el('p', {}, 'Sign in to see the .tonote files in your Google Drive.'), el('p', {}, b));
      return;
    }
    body.replaceChildren(el('p', { class: 'muted' }, 'Looking for .tonote files…'));
    try {
      const files = await listToNoteFiles();
      if (!files.length) {
        body.replaceChildren(el('p', { class: 'muted' }, 'No .tonote files found in your Drive. In Rove ToNote, use File → Save a Copy to Google Drive.'));
        return;
      }
      const list = el('ul', { class: 'picker-list' });
      for (const f of files) {
        const isCurrent = state.meta?.source === 'drive' && state.meta.id === f.id;
        const size = f.size ? ` · ${Math.max(1, Math.round(f.size / 1024))} KB` : '';
        list.append(el('li', {}, el('button', {
          type: 'button', class: isCurrent ? 'current' : null,
          onclick: () => { els.picker.close(); openDriveFile(f).catch(handleError); },
        }, svg(ICONS.markdown, 'ico', 22), el('span', {},
          el('div', { class: 'pname' }, f.name.replace(/\.tonote$/i, '')),
          el('div', { class: 'pmeta' }, `Modified ${fmtDate(f.modifiedTime)}${size}`)))));
      }
      body.replaceChildren(list);
    } catch (e) {
      handleError(e);
      body.replaceChildren(el('p', { class: 'muted' }, `Couldn't list files: ${e.message}`));
    }
  }
  els.docBtn.addEventListener('click', () => openPicker());
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files[0];
    els.fileInput.value = '';
    if (!file) return;
    els.picker.close();
    openLocalFile(file).catch(handleError);
  });
  els.picker.addEventListener('click', (e) => { if (e.target === els.picker) els.picker.close(); });

  // Installed app opened from a .tonote file (file_handlers in the manifest).
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      const h = params.files?.[0];
      if (h) { try { await openLocalFile(await h.getFile(), h); } catch (e) { handleError(e); } }
    });
  }

  // ---------- routing ----------
  const currentId = () => {
    const m = location.hash.match(/^#n=(.+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  const currentNote = () => { const id = currentId(); return id ? state.byId.get(id) || null : null; };

  // Must match the narrow-layout media query in styles.css.
  const NARROW_QUERY = '(max-width: 799px), (max-width: 1100px) and (orientation: portrait)';
  const isNarrow = () => matchMedia(NARROW_QUERY).matches;
  function setDrawer(open) {
    document.body.classList.toggle('drawer-open', open);
    for (const b of document.querySelectorAll('.toolbar .back')) b.setAttribute('aria-expanded', String(open));
    if (open) els.tree.querySelector('.row.active')?.scrollIntoView({ block: 'nearest' });
  }

  // ---------- tree ----------
  function saveExpanded() { store.set('expanded', [...state.expanded]); }
  function toggle(id, open = !state.expanded.has(id)) {
    if (open) state.expanded.add(id); else state.expanded.delete(id);
    saveExpanded();
    renderTree();
  }
  function revealNote(note) {
    let changed = false;
    for (const a of ancestors(note)) if (!state.expanded.has(a.id)) { state.expanded.add(a.id); changed = true; }
    if (changed) saveExpanded();
  }

  function highlight(text, terms) {
    if (!terms.length) return esc(text);
    const n = norm(text);
    const marks = new Array(text.length).fill(false);
    // norm() keeps the same length for most text; fall back to plain text if not.
    if (n.length !== text.length) return esc(text);
    for (const t of terms) { let i = 0; while ((i = n.indexOf(t, i)) !== -1) { marks.fill(true, i, i + t.length); i += t.length; } }
    let out = '', open = false;
    for (let i = 0; i < text.length; i++) {
      if (marks[i] !== open) { out += marks[i] ? '<mark>' : '</mark>'; open = marks[i]; }
      out += esc(text[i]);
    }
    return out + (open ? '</mark>' : '');
  }

  function renderTree() {
    const frag = document.createDocumentFragment();
    if (!state.doc) {
      els.tree.replaceChildren(el('li', { class: 'empty muted' }, 'No document open.'));
      els.count.textContent = '';
      return;
    }
    const terms = norm(state.filter).split(/\s+/).filter(Boolean);
    const activeId = currentId();
    let shown = 0;

    // With a filter: a note is shown if it matches, or if something under it matches.
    const visible = new Set();
    let matched = 0;
    if (terms.length) {
      const matches = (n) => { const t = norm(n.title || '') + ' ' + searchText(n); return terms.every((w) => t.includes(w)); };
      for (const n of state.doc.notes) {
        if (!matches(n)) continue;
        matched++;
        visible.add(n.id);
        for (const a of ancestors(n)) visible.add(a.id);
      }
    }

    const walk = (list, depth, parentUl) => {
      for (const n of list) {
        if (terms.length && !visible.has(n.id)) continue;
        shown++;
        const children = kids(n.id);
        const hasKids = children.length > 0;
        const open = terms.length ? true : state.expanded.has(n.id);
        const li = el('li', { role: 'none' });
        const twisty = el('span', {
          class: 'twisty' + (hasKids ? '' : ' blank'), 'aria-expanded': hasKids ? String(open) : null,
          'aria-label': hasKids ? (open ? 'Collapse' : 'Expand') : null, role: hasKids ? 'button' : null,
          'data-toggle': hasKids ? n.id : null,
        }, svg(ICONS.chevron, '', 14));
        const icon = n.type === 'folder' ? (open && hasKids ? ICONS.folderOpen : ICONS.folder) : (ICONS[n.type] || ICONS.markdown);
        const a = el('a', {
          class: 'row' + (n.id === activeId ? ' active' : ''), href: '#n=' + encodeURIComponent(n.id),
          role: 'treeitem', 'aria-level': depth + 1, 'aria-expanded': hasKids ? String(open) : null,
          'aria-current': n.id === activeId ? 'page' : null, style: `--depth:${depth}`, 'data-id': n.id,
        }, twisty, svg(icon), el('span', { class: 'row-title', html: highlight(n.title || 'Untitled', terms) }),
        n.isEncrypted && !state.plain.has(n.id) ? svg(ICONS.lock, 'row-lock', 14) : null);
        li.append(a);
        if (hasKids && open) {
          const ul = el('ul', { role: 'group' });
          walk(children, depth + 1, ul);
          li.append(ul);
        }
        parentUl.append(li);
      }
    };
    walk(kids(''), 0, frag);
    els.tree.replaceChildren(frag);
    const total = state.doc.notes.length;
    els.count.textContent = terms.length ? `${matched} match${matched === 1 ? '' : 'es'}` : `${total} note${total === 1 ? '' : 's'}`;
    if (!shown) els.tree.append(el('li', { class: 'empty muted' }, total ? 'No notes match.' : 'This document has no notes.'));
    els.lockBtn.hidden = !state.key;
  }

  els.tree.addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) { e.preventDefault(); e.stopPropagation(); if (!state.filter) toggle(t.dataset.toggle); return; }
    const row = e.target.closest('a.row');
    if (!row) return;
    const note = state.byId.get(row.dataset.id);
    // Folders: on a phone, a tap just opens/closes the folder (the drawer stays put).
    // On a wide screen, a click selects it and opens it; clicking it again closes it.
    if (note?.type === 'folder' && kids(note.id).length && !state.filter) {
      if (isNarrow()) { e.preventDefault(); toggle(note.id); }
      else if (note.id === currentId()) { e.preventDefault(); toggle(note.id); }
      else toggle(note.id, true);
      return;
    }
    if (row.dataset.id === currentId()) setDrawer(false);
  });

  // Arrow-key navigation in the tree.
  els.tree.addEventListener('keydown', (e) => {
    const row = e.target.closest('a.row');
    if (!row) return;
    const rows = [...els.tree.querySelectorAll('a.row')];
    const i = rows.indexOf(row);
    const id = row.dataset.id;
    const hasKids = kids(id).length > 0;
    if (e.key === 'ArrowDown') rows[i + 1]?.focus();
    else if (e.key === 'ArrowUp') rows[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && hasKids && !state.expanded.has(id)) { toggle(id, true); els.tree.querySelector(`a.row[data-id="${CSS.escape(id)}"]`)?.focus(); }
    else if (e.key === 'ArrowLeft') {
      if (hasKids && state.expanded.has(id)) { toggle(id, false); els.tree.querySelector(`a.row[data-id="${CSS.escape(id)}"]`)?.focus(); }
      else { const p = state.byId.get(id)?.parentId; if (p) els.tree.querySelector(`a.row[data-id="${CSS.escape(p)}"]`)?.focus(); }
    } else return;
    e.preventDefault();
  });

  els.expandBtn.addEventListener('click', () => {
    for (const n of state.doc?.notes || []) if (kids(n.id).length) state.expanded.add(n.id);
    saveExpanded(); renderTree();
  });
  els.collapseBtn.addEventListener('click', () => { state.expanded.clear(); saveExpanded(); renderTree(); });
  els.lockBtn.addEventListener('click', lock);

  // ---------- note view ----------
  let renderedKey = null;

  function render(force = false) {
    if (force) renderedKey = null;
    els.docName.textContent = state.meta ? state.meta.name.replace(/\.tonote$/i, '') : 'Open a document';
    document.title = state.meta ? `${state.meta.name.replace(/\.tonote$/i, '')} · ToNote Reader` : 'Rove ToNote Reader';
    renderTree();
    renderDetail();
    renderAuth();
  }

  function renderDetail() {
    const note = currentNote();
    document.body.classList.toggle('has-note', !!note);
    const key = note ? `${note.id}|${note.updatedAt}|${state.plain.has(note.id)}|${state.showPasswords}|${state.doc && state.doc.notes.length}`
      : `empty|${docKey(state.meta)}|${tokenValid()}`;
    if (key === renderedKey) return;
    renderedKey = key;
    els.detail.replaceChildren(note ? buildNote(note) : buildPlaceholder());
    els.detail.scrollTop = 0;
  }

  function toolbar(note) {
    const back = el('button', { class: 'btn small back', type: 'button', 'aria-controls': 'sidebar', 'aria-expanded': 'false' }, '☰ Notes');
    back.addEventListener('click', () => setDrawer(!document.body.classList.contains('drawer-open')));
    const crumbs = el('div', { class: 'crumbs' });
    if (note) {
      const path = ancestors(note);
      path.forEach((a, i) => {
        if (i) crumbs.append(' › ');
        crumbs.append(el('a', { href: '#n=' + encodeURIComponent(a.id) }, a.title || 'Untitled'));
      });
    }
    return el('div', { class: 'toolbar' }, back, crumbs);
  }

  function buildPlaceholder() {
    const div = el('div', { class: 'placeholder' });
    if (!state.doc) {
      div.classList.add('standalone');
      div.append(
        el('img', { src: 'icons/icon.svg', alt: '', width: 72, height: 72 }),
        el('h2', {}, 'Rove ToNote Reader'),
        el('p', { class: 'muted' }, 'A read-only viewer for your Rove ToNote documents.'),
        el('p', {},
          el('button', { class: 'btn primary', type: 'button', onclick: () => {
            if (CONFIGURED && !tokenValid()) getToken().then(openPicker).catch(handleError); else openPicker();
          } }, CONFIGURED ? 'Open from Google Drive' : 'Open a document'),
          el('label', { class: 'btn' }, 'Open a file on this device', el('input', {
            type: 'file', accept: '.tonote,application/json', hidden: true,
            onchange: (e) => { const f = e.target.files[0]; if (f) openLocalFile(f).catch(handleError); },
          }))));
      return div;
    }
    div.append(el('p', { class: 'muted' }, state.doc.notes.length ? 'Pick a note.' : 'This document has no notes.'));
    return div;
  }

  function buildNote(note) {
    const frag = document.createDocumentFragment();
    frag.append(toolbar(note));
    const art = el('article', { class: 'note' });
    const meta = [];
    if (note.updatedAt) meta.push('Updated ' + fmtDate(note.updatedAt));
    if (note.isEncrypted) meta.push('Encrypted');
    art.append(el('header', { class: 'note-head' },
      el('h1', { class: 'note-title' }, note.title || 'Untitled'),
      meta.length ? el('div', { class: 'note-meta' }, meta.join(' · ')) : null));

    const content = contentOf(note);
    if (note.type === 'folder') art.append(buildFolder(note));
    else if (content == null) art.append(buildUnlock());
    else if (note.type === 'todo') art.append(buildTodo(content));
    else if (note.type === 'password-grid') art.append(buildPasswords(content));
    else art.append(buildMarkdown(content, note.title));
    frag.append(art);
    return frag;
  }

  function buildMarkdown(content, title) {
    const div = el('div', { class: 'md' });
    if (!content.trim()) { div.append(el('p', { class: 'muted' }, 'This note is empty.')); return div; }
    const html = window.marked ? marked.parse(content, { gfm: true, breaks: false }) : esc(content);
    div.innerHTML = sanitize(html);
    for (const a of div.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener'; }
    for (const cb of div.querySelectorAll('input[type="checkbox"]')) cb.disabled = true;
    for (const t of div.querySelectorAll('table')) { const w = el('div', { class: 'table-wrap' }); t.replaceWith(w); w.append(t); }
    // Don't show the title twice when the note starts with the same heading.
    const first = div.firstElementChild;
    if (first?.tagName === 'H1' && norm(first.textContent.trim()) === norm((title || '').trim())) first.remove();
    return div;
  }

  function buildFolder(note) {
    const list = kids(note.id);
    if (!list.length) return el('p', { class: 'muted' }, 'This folder is empty.');
    return el('ul', { class: 'children' }, list.map((n) => el('li', {}, el('a', { href: '#n=' + encodeURIComponent(n.id) },
      svg(n.type === 'folder' ? ICONS.folder : (ICONS[n.type] || ICONS.markdown)),
      el('span', {}, n.title || 'Untitled'),
      n.isEncrypted && !state.plain.has(n.id) ? svg(ICONS.lock, 'row-lock', 14) : null))));
  }

  function inlineMd(text) {
    const html = window.marked ? marked.parseInline(text) : esc(text);
    return sanitize(html);
  }
  function buildTodo(content) {
    const { sortMode, items } = parseTodo(content);
    const wrap = el('div', {});
    if (!items.length) { wrap.append(el('p', { class: 'muted' }, 'This list is empty.')); return wrap; }
    const row = (i) => el('li', { class: 'todo-item' + (i.checked ? ' done' : '') },
      el('span', { class: 'todo-check', 'aria-label': i.checked ? 'Done' : 'Not done', role: 'img' }, i.checked ? svg(ICONS.check, '', 14) : null),
      el('div', { class: 'todo-body' },
        el('div', { class: 'todo-text', html: inlineMd(i.text) }),
        i.notes.length ? el('ul', { class: 'todo-notes' }, i.notes.map((n) => el('li', { html: linkify(n.text) }))) : null),
      i.priority !== 'none' ? el('span', { class: 'todo-prio ' + i.priority, title: i.priority[0].toUpperCase() + i.priority.slice(1) + ' priority' }) : null);
    const active = sortTodo(items.filter((i) => !i.checked), sortMode);
    const done = sortTodo(items.filter((i) => i.checked), sortMode);
    if (sortMode !== 'manual') wrap.append(el('div', { class: 'todo-sort' }, `Sorted by ${sortMode === 'priority' ? 'priority' : 'name'}`));
    wrap.append(active.length ? el('ul', { class: 'todo' }, active.map(row)) : el('p', { class: 'muted' }, 'Everything is done.'));
    if (done.length) {
      wrap.append(el('details', { class: 'completed' },
        el('summary', {}, `Completed (${done.length})`),
        el('ul', { class: 'todo' }, done.map(row))));
    }
    for (const a of wrap.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener'; }
    return wrap;
  }

  async function copyText(text, btn, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1200);
    } catch { toast("Couldn't copy"); }
  }
  function buildPasswords(content) {
    const entries = parsePasswordGrid(content);
    const wrap = el('div', {});
    if (!entries.length) { wrap.append(el('p', { class: 'muted' }, 'This grid is empty.')); return wrap; }
    const filter = el('input', { class: 'pw-filter', type: 'search', placeholder: 'Filter…', 'aria-label': 'Filter entries', autocomplete: 'off', spellcheck: 'false' });
    const show = el('button', { class: 'link-btn', type: 'button' }, state.showPasswords ? 'Hide passwords' : 'Show passwords');
    show.addEventListener('click', () => { state.showPasswords = !state.showPasswords; render(true); });
    const tbody = el('tbody');
    const copyBtn = (value, what, mask) => value ? el('button', {
      class: 'copy', type: 'button', title: `Copy ${what.toLowerCase()}`,
      onclick: (e) => copyText(value, e.currentTarget, what),
    }, mask ? '•'.repeat(Math.min(12, Math.max(8, value.length))) : value) : '';
    const rows = entries.map((e) => {
      const tr = el('tr', {},
        el('td', { class: 'pw-name' }, e.name),
        el('td', {}, e.username ? el('span', { class: 'pw-label' }, 'Username') : null, copyBtn(e.username, 'Username')),
        el('td', {}, e.password ? el('span', { class: 'pw-label' }, 'Password') : null, copyBtn(e.password, 'Password', !state.showPasswords)),
        el('td', { class: 'pw-note' }, e.note ? el('span', { class: 'pw-label' }, 'Note') : null, e.note ? el('span', { html: linkify(e.note) }) : null));
      tr.dataset.search = norm(`${e.name} ${e.username} ${e.note}`);
      return tr;
    });
    tbody.append(...rows);
    filter.addEventListener('input', () => {
      const terms = norm(filter.value).split(/\s+/).filter(Boolean);
      for (const tr of rows) tr.hidden = !terms.every((t) => tr.dataset.search.includes(t));
    });
    wrap.append(el('div', { class: 'pw-tools' }, filter, show),
      el('table', { class: 'pw-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Username'), el('th', {}, 'Password'), el('th', {}, 'Note'))),
        tbody));
    return wrap;
  }

  function buildUnlock() {
    const err = el('div', { class: 'error', role: 'alert' });
    const input = el('input', { type: 'password', placeholder: 'Document password', autocomplete: 'current-password', 'aria-label': 'Document password' });
    const btn = el('button', { class: 'btn primary', type: 'submit' }, 'Unlock');
    const form = el('form', {}, input, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value) return;
      btn.disabled = true; err.textContent = '';
      try { await unlock(input.value); searchCache.clear(); render(true); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; input.select(); }
    });
    setTimeout(() => { if (!isNarrow()) input.focus(); }, 0);
    return el('div', { class: 'unlock' }, svg(ICONS.lock, '', 36),
      el('p', {}, 'This note is encrypted. Enter the document password to read it.'),
      el('p', { class: 'muted', style: 'font-size:0.85rem' }, 'The password is kept in memory only, until you lock or close the app.'),
      form, err);
  }

  // ---------- wiring ----------
  els.filter.addEventListener('input', () => { state.filter = els.filter.value; renderTree(); });
  els.filter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.filter.value) {
      e.stopPropagation();
      els.filter.value = ''; state.filter = ''; renderTree();
    } else if (e.key === 'Enter') {
      const first = [...els.tree.querySelectorAll('a.row')].find((r) => state.byId.get(r.dataset.id)?.type !== 'folder');
      if (first) location.hash = 'n=' + encodeURIComponent(first.dataset.id);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault(); els.tree.querySelector('a.row')?.focus();
    }
  });
  $('#scrim').addEventListener('click', () => setDrawer(false));

  window.addEventListener('hashchange', () => {
    const note = currentNote();
    if (note) { revealNote(note); if (state.meta) store.set('lastNote:' + docKey(state.meta), note.id); }
    setDrawer(false);
    render();
    if (!isNarrow()) els.tree.querySelector('.row.active')?.scrollIntoView({ block: 'nearest' });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) setDrawer(false);
    else if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) && !els.picker.open) {
      e.preventDefault();
      if (currentNote() && isNarrow()) setDrawer(true);
      els.filter.focus();
    }
  });

  const maybeRefresh = () => {
    if (document.visibilityState !== 'visible' || !state.meta) return;
    if (Date.now() - (state.meta.checkedAt || 0) < CHECK_EVERY_MS) return;
    if (state.meta.source === 'drive' && !tokenValid()) return;
    refresh();
  };
  document.addEventListener('visibilitychange', maybeRefresh);
  setInterval(maybeRefresh, 30_000);
  window.addEventListener('online', () => { if (state.meta) refresh(); });
  window.addEventListener('offline', () => setStatus('Offline: showing the saved copy'));

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(console.error));
  }
  document.getElementById('version').textContent = 'v' + (window.APP_VERSION ?? '?');

  // ---------- start: show the saved copy right away, then check Drive ----------
  (async () => {
    const saved = await idb.get('doc');
    if (saved?.raw && saved.meta) {
      try {
        state.doc = parseDocument(saved.raw);
        state.meta = saved.meta;
        indexDocument();
        state.fileHandle = saved.meta.source === 'local' ? (await idb.get('handle')) || null : null;
      } catch (e) { console.warn('Saved document unreadable', e); state.doc = null; state.meta = null; }
    }
    const note = currentNote();
    if (note) revealNote(note);
    else if (state.meta && !currentId()) {
      const remembered = store.get('lastNote:' + docKey(state.meta));
      if (remembered && state.byId.has(remembered) && !isNarrow()) history.replaceState(null, '', '#n=' + encodeURIComponent(remembered));
    }
    render(true);
    if (state.meta) {
      state.meta.checkedAt = 0;
      if (state.meta.source === 'drive' && !tokenValid() && CONFIGURED) setStatus('Showing the saved copy. Tap Refresh to check Drive.');
      else refresh();
    }
  })();
})();
