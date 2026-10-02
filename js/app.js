// Interface d'ArchiMap.
import { escapeHtml as h, formatBytes, formatNumber, dirname, basename } from './utils.js';
import { analyzeProject, analyzeTranslationDuplicates, analyzeHardcoded, DEFAULT_IGNORES } from './project.js';
import { DEFAULT_DUP_OPTIONS, keyId, buildMigrationPlan, indexTranslations } from './i18n.js';
import { entriesFromFileList, entriesFromDirectoryHandle, entriesFromDrop } from './loader.js';
import { renderGraph, buildGraphData } from './graph.js';
import { demoEntries } from './demo.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const store = {
  get(k, d) { try { const v = localStorage.getItem('archimap:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('archimap:' + k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};

const EXT_COLORS = {
  ts: '#3178c6', tsx: '#3178c6', js: '#e5b700', jsx: '#e5b700', mjs: '#e5b700', cjs: '#e5b700', vue: '#41b883', svelte: '#ff3e00',
  css: '#2965f1', scss: '#cd6799', sass: '#cd6799', less: '#1d365d', html: '#e34c26', json: '#8a8a8a', arb: '#9c36b5', yaml: '#cb171e',
  yml: '#cb171e', dart: '#00b4ab', py: '#3572a5', php: '#777bb4', md: '#868e96', svg: '#ffb13b', png: '#a0a0a0', jpg: '#a0a0a0',
};
const extColor = (ext) => EXT_COLORS[ext] || '#adb5bd';

const state = {
  project: null,
  tab: 'overview',
  dirHandle: null,
  lastSource: null,
  ignores: store.get('ignores', DEFAULT_IGNORES),
  selection: null,
  tree: { open: new Set(), query: '', kind: 'all' },
  graph: { mode: 'files', depth: 2, styles: false, translations: false, hideIsolated: true, search: '', scope: '' },
  graphView: null,
  i18n: { opts: { ...DEFAULT_DUP_OPTIONS, ...store.get('dupOpts', {}) }, locale: '', sub: 'dups', query: '', selected: new Set(), overrides: new Map(), limit: 60, showDynamic: false },
  dups: null,
  hardcoded: null,
};

/* ------------------------------------------------------------------ */
/* Chargement                                                          */
/* ------------------------------------------------------------------ */

function progress(done, total, scanning) {
  $('#progress').hidden = false;
  $('#progress-text').textContent = scanning ? `Recherche des fichiers… (${formatNumber(total)})` : `Lecture des fichiers… ${formatNumber(done)} / ${formatNumber(total)}`;
  $('#progress-fill').style.width = scanning ? '5%' : `${total ? Math.round((done / total) * 100) : 0}%`;
}

async function load(source) {
  try {
    progress(0, 0, true);
    const { name, entries } = await source();
    if (!entries.length) { toast('Aucun fichier trouvé dans ce dossier.'); return; }
    $('#progress-text').textContent = `Analyse de ${formatNumber(entries.length)} fichiers…`;
    $('#progress-fill').style.width = '100%';
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    const project = analyzeProject(entries, { name });
    setProject(project);
    state.lastSource = source;
    toast(`${formatNumber(entries.length)} fichiers analysés en ${Math.round(performance.now() - t0)} ms`);
  } catch (e) {
    if (e?.name !== 'AbortError') { console.error(e); toast('Erreur : ' + (e?.message || e)); }
  } finally {
    $('#progress').hidden = true;
  }
}

async function openFolder() {
  if (window.showDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      state.dirHandle = handle;
      await load(() => entriesFromDirectoryHandle(handle, state.ignores, progress));
      $('#btn-rescan').hidden = false;
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      // API non autorisée (iframe…) : on retombe sur l'input classique.
    }
  }
  $('#dir-input').click();
}

function setProject(project) {
  state.project = project;
  state.selection = null;
  state.tree.open = new Set(['', ...project.tree.children.filter((c) => c.type === 'dir').slice(0, 1).map((c) => c.path)]);
  if (project.tree.children.some((c) => c.path === 'src')) state.tree.open.add('src');
  state.tree.query = '';
  state.tree.kind = 'all';
  state.graph.scope = '';
  state.graph.search = '';
  const nodes = buildGraphData(project, { ...state.graph, mode: 'files' }).nodes.length;
  state.graph.mode = nodes > 350 ? 'folders' : 'files';
  state.i18n.selected = new Set();
  state.i18n.overrides = new Map();
  state.i18n.locale = pickDefaultLocale(project.i18n.locales);
  state.i18n.sub = 'dups';
  state.i18n.limit = 60;
  computeI18n();
  $('#welcome').hidden = true;
  $('#tabs').hidden = false;
  $('#project-name').textContent = project.name;
  closeDetails();
  updateTabCounts();
  for (const t of ['overview', 'tree', 'graph', 'i18n', 'insights']) $('#view-' + t).dataset.dirty = '1';
  switchTab(state.tab === 'graph' ? 'overview' : state.tab);
}

function pickDefaultLocale(locales) {
  const nav = (navigator.language || 'fr').slice(0, 2).toLowerCase();
  return locales.find((l) => l === nav) || locales.find((l) => l.startsWith(nav)) || locales.find((l) => l.startsWith('fr')) || locales[0] || '';
}

function computeI18n() {
  const p = state.project;
  state.dups = analyzeTranslationDuplicates(p, state.i18n.opts);
  state.hardcoded = analyzeHardcoded(p, state.i18n.opts);
}

function insightCount(p) {
  const i = p.insights;
  return i.cycles.length + i.orphans.length + i.duplicateFiles.length + i.sameNames.length + i.mutualCoupling.length;
}

function updateTabCounts() {
  const p = state.project;
  const dupCount = state.dups.filter((g) => !state.i18n.locale || g.locale === state.i18n.locale).length;
  $('#tab-i18n-count').textContent = dupCount || '';
  $('#tab-insights-count').textContent = insightCount(p) || '';
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

function switchTab(tab) {
  if (state.tab !== tab && matchMedia('(max-width: 900px)').matches) closeDetails();
  state.tab = tab;
  for (const b of $$('#tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const t of ['overview', 'tree', 'graph', 'i18n', 'insights']) $('#view-' + t).hidden = t !== tab;
  const view = $('#view-' + tab);
  if (view.dataset.dirty || tab === 'graph') {
    delete view.dataset.dirty;
    ({ overview: renderOverview, tree: renderTree, graph: renderGraphView, i18n: renderI18n, insights: renderInsights })[tab]();
  }
  window.scrollTo(0, 0);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3200);
}

function download(name, content, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: type + ';charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const plink = (path, label) => `<button class="plink" data-path="${h(path)}" title="${h(path)}">${h(label ?? path)}</button>`;
const dlink = (path, label) => `<button class="plink" data-dir="${h(path)}" title="${h(path)}">${h(label ?? (path || '(racine)'))}/</button>`;

function pathList(paths, max = 12) {
  if (!paths.length) return '<p class="muted">Aucun</p>';
  const items = (arr) => arr.map((p) => `<li>${plink(p)}</li>`).join('');
  return `<ul class="list">${items(paths.slice(0, max))}</ul>` +
    (paths.length > max ? `<details class="more"><summary>+ ${paths.length - max} autres</summary><ul class="list">${items(paths.slice(max))}</ul></details>` : '');
}

/* ------------------------------------------------------------------ */
/* Vue d'ensemble                                                      */
/* ------------------------------------------------------------------ */

function recommendations(p) {
  const i = p.insights;
  const dups = state.dups.filter((g) => !state.i18n.locale || g.locale === state.i18n.locale);
  const savings = dups.reduce((s, g) => s + g.savings, 0);
  const items = [];
  if (dups.length) items.push({ ic: '🌐', tab: 'i18n', title: `${dups.length} textes traduits en double`, desc: `${savings} clés pourraient être regroupées (ex. « ${h(dups[0].value)} » ×${dups[0].occurrences.length}).` });
  if (state.hardcoded.length) items.push({ ic: '✍️', tab: 'i18n', sub: 'hardcoded', title: `${state.hardcoded.length} textes écrits en dur`, desc: 'Ces textes existent déjà dans vos traductions : utilisez la clé.' });
  if (i.cycles.length) items.push({ ic: '🔁', tab: 'insights', title: `${i.cycles.length} dépendance(s) circulaire(s)`, desc: 'Des fichiers s\'importent mutuellement : source de bugs et de couplage.' });
  if (i.orphans.length) items.push({ ic: '🧹', tab: 'insights', title: `${i.orphans.length} fichier(s) potentiellement inutilisé(s)`, desc: 'Aucun autre fichier ne les importe.' });
  if (i.duplicateFiles.length) items.push({ ic: '📑', tab: 'insights', title: `${i.duplicateFiles.length} groupe(s) de fichiers identiques`, desc: 'Même contenu à plusieurs endroits.' });
  if (i.sameNames.length) items.push({ ic: '🏷️', tab: 'insights', title: `${i.sameNames.length} nom(s) de fichier en double`, desc: `ex. ${h(i.sameNames[0].name)} ×${i.sameNames[0].paths.length} — à fusionner ou renommer ?` });
  if (p.i18n.unusedCount) items.push({ ic: '🗑️', tab: 'i18n', sub: 'unused', title: `${p.i18n.unusedCount} clé(s) de traduction non trouvée(s) dans le code`, desc: 'Probablement supprimables (vérifiez les clés construites dynamiquement).' });
  if (p.i18n.missing.length) items.push({ ic: '❓', tab: 'i18n', sub: 'missing', title: 'Clés manquantes dans certaines langues', desc: p.i18n.missing.map((m) => `${m.locale} : ${m.missing.length}`).join(' · ') });
  if (i.mutualCoupling.length) items.push({ ic: '🔗', tab: 'insights', title: `${i.mutualCoupling.length} paire(s) de dossiers interdépendants`, desc: `${h(i.mutualCoupling[0].a)} ⇄ ${h(i.mutualCoupling[0].b)}` });
  return items;
}

function renderOverview() {
  const p = state.project;
  const dirs = (function count(n) { return n.children.filter((c) => c.type === 'dir').reduce((s, c) => s + 1 + count(c), 0); })(p.tree);
  const lines = p.files.reduce((s, f) => s + f.lines, 0);
  const dups = state.dups.filter((g) => !state.i18n.locale || g.locale === state.i18n.locale);
  const byExt = new Map();
  for (const f of p.files) byExt.set(f.ext || '(sans)', (byExt.get(f.ext || '(sans)') || 0) + 1);
  const exts = [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxExt = exts[0]?.[1] || 1;
  const topDirs = p.tree.children.filter((c) => c.type === 'dir').sort((a, b) => b.fileCount - a.fileCount).slice(0, 10);
  const maxDir = topDirs[0]?.fileCount || 1;
  const recos = recommendations(p);

  $('#view-overview').innerHTML = `
    <div class="grid stats">
      ${stat(formatNumber(p.files.length), 'fichiers')}
      ${stat(formatNumber(dirs), 'dossiers')}
      ${stat(formatNumber(lines), 'lignes')}
      ${stat(formatNumber(p.deps.edges.length), 'liens entre fichiers')}
      ${stat(formatNumber(p.deps.externals.length), 'paquets externes')}
      ${stat(p.i18n.locales.length ? p.i18n.locales.join(', ') : '—', 'langues')}
      ${stat(formatNumber(p.i18n.keyCount), 'clés de traduction')}
      ${stat(formatNumber(dups.length), 'textes en double', dups.length ? 'warn' : '')}
      ${stat(formatNumber(p.insights.cycles.length), 'cycles', p.insights.cycles.length ? 'danger' : '')}
    </div>
    <div class="grid cols-2">
      <div class="card">
        <h2>Pistes d'optimisation</h2>
        ${recos.length ? `<div class="reco">${recos.map((r) => `<div class="reco-item" data-goto="${r.tab}" ${r.sub ? `data-sub="${r.sub}"` : ''}><span class="ic">${r.ic}</span><div><b>${r.title}</b><span>${r.desc}</span></div></div>`).join('')}</div>` : '<p class="muted">Rien à signaler, bravo ✨</p>'}
      </div>
      <div class="card">
        <h2>Structure</h2>
        <div class="bars">${topDirs.map((d) => bar(dlink(d.path, d.name), d.fileCount, maxDir)).join('') || '<p class="muted">Tous les fichiers sont à la racine.</p>'}</div>
        <h2 style="margin-top:18px">Types de fichiers</h2>
        <div class="bars">${exts.map(([e, n]) => bar(`<span class="mono" style="color:${extColor(e)}">.${h(e)}</span>`, n, maxExt)).join('')}</div>
      </div>
      <div class="card">
        <h2>Fichiers les plus utilisés</h2>
        <ul class="list">${p.insights.hubs.filter((x) => x.count > 1).slice(0, 10).map((x) => `<li>${plink(x.path)}<span class="tag ok">${x.count} imports</span></li>`).join('') || '<li class="muted">Aucun lien détecté</li>'}</ul>
      </div>
      <div class="card">
        <h2>Paquets externes</h2>
        <ul class="list">${p.deps.externals.slice(0, 12).map((x) => `<li><span class="mono">${h(x.name)}</span><span class="tag">${x.count} fichier(s)</span></li>`).join('') || '<li class="muted">Aucun</li>'}</ul>
      </div>
    </div>`;
}

const stat = (v, l, cls = '') => `<div class="stat ${cls}"><div class="v">${h(v)}</div><div class="l">${h(l)}</div></div>`;
const bar = (label, n, max) => `<div class="bar-row"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (n / max) * 100)}%"></div></div><div class="n">${formatNumber(n)}</div></div>`;

/* ------------------------------------------------------------------ */
/* Arborescence                                                        */
/* ------------------------------------------------------------------ */

function treeFilter() {
  const p = state.project;
  const q = state.tree.query.trim().toLowerCase();
  const kind = state.tree.kind;
  if (!q && kind === 'all') return null;
  const cycle = new Set(p.insights.cycles.flat());
  const orphans = new Set(p.insights.orphans);
  const visible = new Set(['']);
  for (const f of p.files) {
    if (q && !f.path.toLowerCase().includes(q)) continue;
    if (kind === 'code' && !(f.imports.length || f.importedBy.length || ['js', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'dart', 'py'].includes(f.ext))) continue;
    if (kind === 'i18n' && !f.isTranslation && !p.i18n.fileKeys.has(f.path)) continue;
    if (kind === 'orphans' && !orphans.has(f.path)) continue;
    if (kind === 'cycles' && !cycle.has(f.path)) continue;
    visible.add(f.path);
    let d = dirname(f.path);
    while (d && !visible.has(d)) { visible.add(d); d = dirname(d); }
  }
  return visible;
}

function highlightName(name, q) {
  if (!q) return h(name);
  const i = name.toLowerCase().indexOf(q);
  if (i < 0) return h(name);
  return h(name.slice(0, i)) + '<mark>' + h(name.slice(i, i + q.length)) + '</mark>' + h(name.slice(i + q.length));
}

function renderTreeRows() {
  const p = state.project;
  const visible = treeFilter();
  const q = state.tree.query.trim().toLowerCase();
  const cycle = new Set(p.insights.cycles.flat());
  const orphans = new Set(p.insights.orphans);
  const sel = state.selection?.path;
  const out = [];
  (function walk(node, depth) {
    for (const c of node.children) {
      if (visible && !visible.has(c.path)) continue;
      const pad = 8 + depth * 16;
      if (c.type === 'dir') {
        const open = visible ? true : state.tree.open.has(c.path);
        out.push(`<div class="tree-row dir ${open ? 'open' : ''} ${sel === c.path && state.selection.type === 'dir' ? 'selected' : ''}" data-tree-dir="${h(c.path)}" style="padding-left:${pad}px">
          <span class="chev">▸</span><span class="dot" style="background:var(--muted);opacity:.35"></span><span class="name">${highlightName(c.name, q)}</span>
          <span class="meta"><span>${c.fileCount} fichier${c.fileCount > 1 ? 's' : ''}</span><span>${formatBytes(c.size)}</span></span></div>`);
        if (open) walk(c, depth + 1);
      } else {
        const f = c.file;
        const keys = p.i18n.fileKeys.get(f.path)?.size || 0;
        const badges = [
          f.imports.length ? `<span class="badge out" title="Importe ${f.imports.length} fichier(s)">→ ${f.imports.length}</span>` : '',
          f.importedBy.length ? `<span class="badge in" title="Utilisé par ${f.importedBy.length} fichier(s)">← ${f.importedBy.length}</span>` : '',
          keys ? `<span class="badge i18n" title="${keys} clé(s) de traduction utilisée(s)">🌐 ${keys}</span>` : '',
          f.isTranslation ? `<span class="badge i18n" title="Fichier de traduction">${h(f.translation.locale)} · ${f.translation.entries.length} clés</span>` : '',
          cycle.has(f.path) ? '<span class="badge danger" title="Fait partie d\'une dépendance circulaire">cycle</span>' : '',
          orphans.has(f.path) ? '<span class="badge warn" title="Aucun fichier ne l\'importe">orphelin</span>' : '',
        ].join('');
        out.push(`<div class="tree-row file ${sel === f.path ? 'selected' : ''}" data-path="${h(f.path)}" style="padding-left:${pad}px">
          <span class="chev"></span><span class="dot" style="background:${extColor(f.ext)}"></span><span class="name">${highlightName(c.name, q)}</span>
          <span class="meta">${badges}<span>${f.lines ? f.lines + ' l.' : formatBytes(f.size)}</span></span></div>`);
      }
    }
  })(p.tree, 0);
  $('#tree').innerHTML = out.join('') || '<p class="empty">Aucun fichier ne correspond.</p>';
}

function renderTree() {
  const kinds = [['all', 'Tous'], ['code', 'Code lié'], ['i18n', 'Traductions'], ['orphans', 'Orphelins'], ['cycles', 'Cycles']];
  $('#view-tree').innerHTML = `
    <div class="tree-layout">
      <div class="toolbar">
        <input type="search" id="tree-search" placeholder="Rechercher un fichier…" value="${h(state.tree.query)}" />
        <div class="seg" id="tree-kind">${kinds.map(([k, l]) => `<button data-kind="${k}" class="${state.tree.kind === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        <button class="btn small" id="tree-expand">Tout déplier</button>
        <button class="btn small" id="tree-collapse">Tout replier</button>
      </div>
      <div class="legend">
        <span><span class="badge out">→ n</span> importe n fichiers</span>
        <span><span class="badge in">← n</span> utilisé par n fichiers</span>
        <span><span class="badge i18n">🌐 n</span> clés de traduction utilisées</span>
        <span>Cliquez sur un fichier pour voir ses liens</span>
      </div>
      <div class="tree" id="tree" role="tree"></div>
    </div>`;
  renderTreeRows();
  $('#tree-search').addEventListener('input', (e) => { state.tree.query = e.target.value; renderTreeRows(); });
  $('#tree-kind').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    state.tree.kind = b.dataset.kind;
    $$('#tree-kind button').forEach((x) => x.classList.toggle('active', x === b));
    renderTreeRows();
  });
  $('#tree-expand').onclick = () => {
    (function all(n) { for (const c of n.children) if (c.type === 'dir') { state.tree.open.add(c.path); all(c); } })(state.project.tree);
    renderTreeRows();
  };
  $('#tree-collapse').onclick = () => { state.tree.open = new Set(); renderTreeRows(); };
}

function revealInTree(path) {
  let d = dirname(path);
  while (d) { state.tree.open.add(d); d = dirname(d); }
  state.tree.query = '';
  state.tree.kind = 'all';
  $('#view-tree').dataset.dirty = '1';
  switchTab('tree');
  setTimeout(() => $(`#tree [data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'center' }), 0);
}

/* ------------------------------------------------------------------ */
/* Panneau de détails                                                  */
/* ------------------------------------------------------------------ */

function openDetails(html) {
  $('#details-body').innerHTML = html;
  $('#details').hidden = false;
  $('#details').scrollTop = 0;
  document.body.classList.add('with-details');
}

function closeDetails() {
  $('#details').hidden = true;
  document.body.classList.remove('with-details');
  state.selection = null;
  $$('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
}

function refValue(id) {
  const loc = state.i18n.locale || state.project.i18n.locales[0];
  return indexTranslationsCached().get(loc)?.get(id)?.value;
}

let _idxCache = null;
function indexTranslationsCached() {
  if (!_idxCache || _idxCache.project !== state.project) _idxCache = { project: state.project, idx: indexTranslations(state.project.i18n.translations) };
  return _idxCache.idx;
}

function showFile(path) {
  const p = state.project;
  const f = p.byPath.get(path);
  if (!f) return;
  state.selection = { type: 'file', path };
  $$('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
  $(`#tree [data-path="${CSS.escape(path)}"]`)?.classList.add('selected');
  const inCycle = p.insights.cycles.find((c) => c.includes(path));
  const orphan = p.insights.orphans.includes(path);
  const keys = [...(p.i18n.fileKeys.get(path) || [])].sort();
  const dupIds = new Map();
  for (const g of state.dups) if (!state.i18n.locale || g.locale === state.i18n.locale) for (const o of g.occurrences) dupIds.set(o.id, g);

  let html = `<div class="crumbs">${h(dirname(path) || '(racine)')}</div><h2>${h(f.name)}</h2>
    <p>
      <span class="tag" style="color:${extColor(f.ext)}">.${h(f.ext || '?')}</span>
      <span class="tag">${f.lines ? formatNumber(f.lines) + ' lignes' : ''} ${formatBytes(f.size)}</span>
      ${inCycle ? '<span class="tag danger">dans un cycle</span>' : ''}
      ${orphan ? '<span class="tag warn">non importé</span>' : ''}
      ${f.isTranslation ? `<span class="tag accent">traduction · ${h(f.translation.locale)}</span>` : ''}
    </p>
    <p style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn small" data-reveal="${h(path)}">Afficher dans l'arborescence</button>
      ${f.imports.length || f.importedBy.length ? `<button class="btn small" data-focus-graph="${h(path)}">Voir dans le graphe</button>` : ''}
    </p>`;
  if (inCycle) html += `<section><h3>Cycle</h3><p class="mono" style="font-size:.82rem">${inCycle.map((x) => plink(x, basename(x))).join(' → ')} → ${plink(inCycle[0], basename(inCycle[0]))}</p></section>`;
  if (f.imports.length || !f.isTranslation) html += `<section><h3>Importe <span class="tag out">${f.imports.length}</span></h3>${pathList(f.imports)}</section>`;
  html += `<section><h3>Utilisé par <span class="tag ok">${f.importedBy.length}</span></h3>${pathList(f.importedBy)}</section>`;
  if (f.externalDeps.length) html += `<section><h3>Paquets externes</h3><p>${f.externalDeps.map((x) => `<span class="tag">${h(x)}</span>`).join(' ')}</p></section>`;
  if (f.unresolved.length) html += `<section><h3>Imports non résolus</h3><p>${f.unresolved.map((x) => `<span class="tag warn mono">${h(x)}</span>`).join(' ')}</p></section>`;
  if (keys.length) {
    html += `<section><h3>Clés de traduction utilisées <span class="tag accent">${keys.length}</span></h3>
      <div class="table-wrap"><table><tr><th>Clé</th><th>Texte</th></tr>${keys.map((k) => `<tr><td class="key">${h(k)}</td><td>${h(refValue(k) ?? '')} ${dupIds.has(k) ? `<span class="tag warn" title="Ce texte existe sous plusieurs clés">doublon</span>` : ''}</td></tr>`).join('')}</table></div></section>`;
  }
  const hard = state.hardcoded.flatMap((x) => x.places.filter((pl) => pl.path === path).map((pl) => ({ ...pl, text: x.text, keys: x.keys })));
  if (hard.length) html += `<section><h3>Textes en dur déjà traduits</h3><ul class="list">${hard.map((x) => `<li><span>« ${h(x.text)} » <span class="muted">l.${x.line}</span></span><span class="tag accent mono">${h(x.keys[0].id)}</span></li>`).join('')}</ul></section>`;
  if (f.isTranslation) {
    const t = f.translation;
    const unused = t.entries.filter((e) => e.usage.status === 'unused').length;
    const groups = state.dups.filter((g) => g.locale === t.locale && g.occurrences.some((o) => o.file === path));
    html += `<section><h3>Traductions</h3><dl class="kv"><dt>Langue</dt><dd>${h(t.locale)}</dd>${t.namespace ? `<dt>Namespace</dt><dd class="mono">${h(t.namespace)}</dd>` : ''}<dt>Clés</dt><dd>${t.entries.length}</dd><dt>Non utilisées</dt><dd>${unused}</dd><dt>Textes en double</dt><dd>${groups.length}</dd></dl>
      ${groups.length ? `<ul class="list" style="margin-top:8px">${groups.slice(0, 15).map((g) => `<li><span>« ${h(g.value)} »</span><span class="tag warn">×${g.occurrences.length}</span></li>`).join('')}</ul>
      <p><button class="btn small" data-goto="i18n">Voir les doublons</button></p>` : ''}</section>`;
  }
  if (f.content != null) {
    const preview = f.content.split('\n').slice(0, 300).join('\n');
    html += `<section><details><summary class="muted" style="cursor:pointer">Aperçu du contenu</summary><pre>${h(preview)}</pre></details></section>`;
  }
  openDetails(html);
}

function showDir(path) {
  const p = state.project;
  state.selection = { type: 'dir', path };
  const inside = (x) => !path || x === path || x.startsWith(path + '/');
  const files = p.files.filter((f) => inside(f.path));
  const out = new Map(), inc = new Map(), ext = new Map();
  const top = (x) => dirname(x).split('/').slice(0, Math.max(1, path.split('/').length)).join('/') || '(racine)';
  for (const f of files) {
    ext.set(f.ext || '(sans)', (ext.get(f.ext || '(sans)') || 0) + 1);
    for (const t of f.imports) if (!inside(t)) out.set(top(t), (out.get(top(t)) || 0) + 1);
    for (const s of f.importedBy) if (!inside(s)) inc.set(top(s), (inc.get(top(s)) || 0) + 1);
  }
  const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  const lines = files.reduce((s, f) => s + f.lines, 0);
  const html = `<div class="crumbs">${h(dirname(path) || '')}</div><h2>${h(basename(path) || p.name)}/</h2>
    <dl class="kv"><dt>Fichiers</dt><dd>${files.length}</dd><dt>Lignes</dt><dd>${formatNumber(lines)}</dd><dt>Taille</dt><dd>${formatBytes(files.reduce((s, f) => s + f.size, 0))}</dd></dl>
    <p style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px"><button class="btn small" data-graph-scope="${h(path)}">Graphe de ce dossier</button></p>
    <section><h3>Dépend de</h3>${out.size ? `<ul class="list">${sorted(out).map(([d, n]) => `<li>${dlink(d)}<span class="tag out">${n} import(s)</span></li>`).join('')}</ul>` : '<p class="muted">Aucun autre dossier</p>'}</section>
    <section><h3>Utilisé par</h3>${inc.size ? `<ul class="list">${sorted(inc).map(([d, n]) => `<li>${dlink(d)}<span class="tag ok">${n} import(s)</span></li>`).join('')}</ul>` : '<p class="muted">Aucun autre dossier</p>'}</section>
    <section><h3>Types de fichiers</h3><p>${sorted(ext).map(([e, n]) => `<span class="tag" style="color:${extColor(e)}">.${h(e)} × ${n}</span>`).join(' ')}</p></section>`;
  openDetails(html);
}

/* ------------------------------------------------------------------ */
/* Graphe                                                              */
/* ------------------------------------------------------------------ */

function graphScopes() {
  const out = [];
  (function walk(n, depth) {
    for (const c of n.children) if (c.type === 'dir') { out.push(c.path); if (depth < 2) walk(c, depth + 1); }
  })(state.project.tree, 0);
  return out;
}

function renderGraphView(focusId) {
  const g = state.graph;
  const view = $('#view-graph');
  if (!view.querySelector('.graph-layout')) {
    view.innerHTML = `<div class="graph-layout">
      <div class="toolbar">
        <div class="seg" id="g-mode"><button data-mode="files">Fichiers</button><button data-mode="folders">Dossiers</button></div>
        <label id="g-depth-wrap">Profondeur <select id="g-depth">${[1, 2, 3, 4, 5].map((d) => `<option value="${d}">${d}</option>`).join('')}</select></label>
        <label>Dossier <select id="g-scope"><option value="">Tout le projet</option>${graphScopes().map((s) => `<option value="${h(s)}">${h(s)}</option>`).join('')}</select></label>
        <input type="search" id="g-search" placeholder="Surligner…" />
        <label><input type="checkbox" id="g-styles" /> Styles</label>
        <label><input type="checkbox" id="g-translations" /> Traductions</label>
        <label><input type="checkbox" id="g-isolated" /> Masquer les isolés</label>
        <button class="btn small" id="g-reset">Recentrer</button>
      </div>
      <div class="legend" id="g-legend"></div>
      <div class="graph-box" id="graph-box"></div>
    </div>`;
    $('#g-mode').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (b) { g.mode = b.dataset.mode; renderGraphView(); } };
    $('#g-depth').onchange = (e) => { g.depth = +e.target.value; renderGraphView(); };
    $('#g-scope').onchange = (e) => { g.scope = e.target.value; renderGraphView(); };
    $('#g-search').oninput = (e) => {
      g.search = e.target.value;
      const q = g.search.toLowerCase();
      $$('#graph-box .node').forEach((n) => n.classList.toggle('match', !!q && n.__data__.id.toLowerCase().includes(q)));
    };
    $('#g-styles').onchange = (e) => { g.styles = e.target.checked; renderGraphView(); };
    $('#g-translations').onchange = (e) => { g.translations = e.target.checked; renderGraphView(); };
    $('#g-isolated').onchange = (e) => { g.hideIsolated = e.target.checked; renderGraphView(); };
    $('#g-reset').onclick = () => state.graphView?.resetZoom();
  }
  $$('#g-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === g.mode));
  $('#g-depth-wrap').hidden = g.mode !== 'folders';
  $('#g-depth').value = g.depth;
  $('#g-scope').value = g.scope;
  $('#g-search').value = g.search;
  $('#g-styles').checked = g.styles;
  $('#g-translations').checked = g.translations;
  $('#g-isolated').checked = g.hideIsolated;
  state.graphView?.destroy();
  const box = $('#graph-box');
  requestAnimationFrame(() => {
    state.graphView = renderGraph(box, state.project, g, (d) => {
      if (!d) return;
      if (d.kind === 'folder') showDir(d.id === '(racine)' ? '' : d.id); else showFile(d.id);
    });
    box.insertAdjacentHTML('beforeend', '<div class="graph-note">Molette : zoom · glisser : déplacer · clic : liens et détails · <span style="color:var(--danger)">rouge</span> : cycle</div>');
    const n = state.graphView.data?.nodes.length || 0;
    $('#g-legend').innerHTML = (state.graphView.groups || []).slice(0, 14).map((x) => `<span><i style="background:${x.color}"></i>${h(x.name)}</span>`).join('') +
      `<span class="muted">${n} nœud(s) · ${state.graphView.data?.links.length || 0} lien(s)${n > 600 ? ' — conseil : passez en mode Dossiers ou filtrez un dossier' : ''}</span>`;
    if (focusId) state.graphView.focus(focusId);
  });
}

function focusInGraph(path) {
  const f = state.project.byPath.get(path);
  state.graph.mode = 'files';
  if (f && (f.isTranslation)) state.graph.translations = true;
  if (f && ['css', 'scss', 'sass', 'less'].includes(f.ext)) state.graph.styles = true;
  if (state.graph.scope && !path.startsWith(state.graph.scope + '/')) state.graph.scope = '';
  state.tab = 'graph';
  for (const b of $$('#tabs button')) b.classList.toggle('active', b.dataset.tab === 'graph');
  for (const t of ['overview', 'tree', 'graph', 'i18n', 'insights']) $('#view-' + t).hidden = t !== 'graph';
  renderGraphView(path);
}

/* ------------------------------------------------------------------ */
/* Traductions                                                         */
/* ------------------------------------------------------------------ */

function visibleDups() {
  const q = state.i18n.query.trim().toLowerCase();
  return state.dups.filter((g) =>
    (!state.i18n.locale || g.locale === state.i18n.locale) &&
    (!q || g.norm.includes(q) || g.variants.some((v) => v.toLowerCase().includes(q)) || g.occurrences.some((o) => o.id.toLowerCase().includes(q))));
}

function groupTarget(g) {
  return state.i18n.overrides.get(g.id) || g.suggestion.id;
}

function selectedGroups() {
  return state.dups.filter((g) => state.i18n.selected.has(g.id)).map((g) => ({ ...g, suggestion: { ...g.suggestion, id: groupTarget(g) } }));
}

function renderI18n() {
  const p = state.project;
  const view = $('#view-i18n');
  if (!p.i18n.translations.length) {
    view.innerHTML = `<div class="card"><h2>Aucun fichier de traduction détecté</h2>
      <p class="muted">ArchiMap reconnaît automatiquement :</p>
      <ul><li>les fichiers JSON/YAML dans un dossier <code>i18n</code>, <code>locales</code>, <code>lang</code>, <code>translations</code>, <code>l10n</code>…</li>
      <li>les fichiers nommés par langue : <code>fr.json</code>, <code>en-US.json</code>, <code>messages.fr.yml</code>, <code>fr/common.json</code></li>
      <li>Flutter <code>.arb</code>, Android <code>values-fr/strings.xml</code>, iOS <code>fr.lproj/*.strings</code>, Java <code>*_fr.properties</code></li></ul></div>`;
    return;
  }
  const o = state.i18n.opts;
  const all = state.dups.filter((g) => !state.i18n.locale || g.locale === state.i18n.locale);
  const savings = all.reduce((s, g) => s + g.savings, 0);
  const missingTotal = p.i18n.missing.reduce((s, m) => s + m.missing.length, 0);
  const subs = [
    ['dups', `Doublons (${all.length})`],
    ['hardcoded', `Textes en dur (${state.hardcoded.length})`],
    ['unused', `Clés inutilisées (${p.i18n.unusedCount})`],
    ['missing', `Clés manquantes (${missingTotal})`],
    ['keys', `Toutes les clés (${p.i18n.keyCount})`],
  ];
  view.innerHTML = `
    <div class="grid stats">
      ${stat(p.i18n.locales.join(', '), 'langues')}
      ${stat(p.i18n.translations.length, 'fichiers de traduction')}
      ${stat(formatNumber(p.i18n.keyCount), 'clés')}
      ${stat(all.length, 'textes en double', all.length ? 'warn' : '')}
      ${stat(savings, 'clés regroupables', savings ? 'warn' : '')}
      ${stat(p.i18n.unusedCount, 'clés inutilisées')}
    </div>
    <div class="toolbar">
      <label>Langue <select id="i-locale"><option value="">Toutes</option>${p.i18n.locales.map((l) => `<option ${l === state.i18n.locale ? 'selected' : ''}>${h(l)}</option>`).join('')}</select></label>
      <input type="search" id="i-search" placeholder="Filtrer (texte ou clé)…" value="${h(state.i18n.query)}" />
      <label title="« Annuler » = « annuler »"><input type="checkbox" data-opt="ignoreCase" ${o.ignoreCase ? 'checked' : ''}/> Ignorer la casse</label>
      <label title="« Créer » = « Creer »"><input type="checkbox" data-opt="ignoreAccents" ${o.ignoreAccents ? 'checked' : ''}/> Ignorer les accents</label>
      <label title="« Email : » = « Email »"><input type="checkbox" data-opt="ignorePunctuation" ${o.ignorePunctuation ? 'checked' : ''}/> Ignorer la ponctuation finale</label>
      <label title="« E-mail » = « Email », « Mot de passe » = « Mot-de-passe »"><input type="checkbox" data-opt="loose" ${o.loose ? 'checked' : ''}/> Mode souple</label>
      <label>Min. <input type="number" id="i-min" min="2" max="20" value="${o.minCount}" style="width:64px" /></label>
    </div>
    <div class="subtabs" id="i-subs">${subs.map(([k, l]) => `<button data-sub="${k}" class="${state.i18n.sub === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="i-body"></div>`;
  $('#i-locale').onchange = (e) => { state.i18n.locale = e.target.value; state.i18n.limit = 60; updateTabCounts(); renderI18n(); markDirty('overview'); };
  $('#i-search').oninput = (e) => { state.i18n.query = e.target.value; state.i18n.limit = 60; renderI18nBody(); };
  $('#i-min').onchange = (e) => { o.minCount = Math.max(2, +e.target.value || 2); onOptsChange(); };
  $$('[data-opt]', view).forEach((c) => (c.onchange = () => { o[c.dataset.opt] = c.checked; onOptsChange(); }));
  $('#i-subs').onclick = (e) => { const b = e.target.closest('[data-sub]'); if (b) { state.i18n.sub = b.dataset.sub; $$('#i-subs button').forEach((x) => x.classList.toggle('active', x === b)); renderI18nBody(); } };
  renderI18nBody();
}

function markDirty(...tabs) { for (const t of tabs) $('#view-' + t).dataset.dirty = '1'; }

function onOptsChange() {
  store.set('dupOpts', state.i18n.opts);
  computeI18n();
  state.i18n.selected = new Set([...state.i18n.selected].filter((id) => state.dups.some((g) => g.id === id)));
  updateTabCounts();
  markDirty('overview');
  renderI18n();
}

function renderI18nBody() {
  const body = $('#i-body');
  const sub = state.i18n.sub;
  if (sub === 'dups') return renderDups(body);
  if (sub === 'hardcoded') return renderHardcoded(body);
  if (sub === 'unused') return renderUnused(body);
  if (sub === 'missing') return renderMissing(body);
  return renderAllKeys(body);
}

function usageCell(entry) {
  const u = entry?.e?.usage;
  if (!u) return '<span class="muted">—</span>';
  if (u.status === 'unused') return '<span class="tag danger">non utilisée</span>';
  const cls = u.status === 'dynamic' ? 'warn' : 'ok';
  const label = u.status === 'dynamic' ? 'dynamique ?' : `${u.files.length} fichier(s)`;
  return `<details><summary class="tag ${cls}" style="cursor:pointer;list-style:none">${label}</summary><div class="files">${u.files.map((x) => plink(x, basename(x))).join('')}</div></details>`;
}

function renderDups(body) {
  const groups = visibleDups();
  const idx = indexTranslationsCached();
  const others = state.project.i18n.locales.filter((l) => l !== state.i18n.locale);
  const shown = groups.slice(0, state.i18n.limit);
  body.innerHTML = `
    <p class="note">Chaque carte regroupe des clés différentes qui contiennent <b>le même texte</b>. Cochez celles à regrouper,
      ajustez la clé commune proposée, puis exportez le plan de migration. <span class="tag ok">fusion sûre</span> = les autres langues ont aussi le même texte ;
      <span class="tag warn">à vérifier</span> = une autre langue traduit différemment (le contexte n'est peut-être pas le même).</p>
    ${groups.length ? '' : '<p class="empty">Aucun doublon avec ces critères. Essayez le « mode souple » ou une autre langue.</p>'}
    <div class="dup-list">${shown.map((g) => dupCard(g, idx, state.i18n.locale ? others : [])).join('')}</div>
    ${groups.length > shown.length ? `<p style="text-align:center;margin-top:12px"><button class="btn" id="dup-more">Afficher plus (${groups.length - shown.length} restants)</button></p>` : ''}
    <div class="sticky-bar">
      <span class="grow" id="dup-summary"></span>
      <button class="btn small" id="dup-select-safe">Sélectionner les fusions sûres</button>
      <button class="btn small" id="dup-select-none">Tout désélectionner</button>
      <button class="btn small primary" id="dup-export-json">Plan de migration (JSON)</button>
      <button class="btn small" id="dup-export-md">Rapport (Markdown)</button>
      <button class="btn small" id="dup-export-csv">CSV</button>
    </div>`;
  updateDupSummary();
  $('#dup-more')?.addEventListener('click', () => { state.i18n.limit += 100; renderDups(body); });
  body.querySelectorAll('[data-dup-check]').forEach((c) => (c.onchange = () => {
    if (c.checked) state.i18n.selected.add(c.dataset.dupCheck); else state.i18n.selected.delete(c.dataset.dupCheck);
    c.closest('.dup').classList.toggle('selected', c.checked);
    updateDupSummary();
  }));
  body.querySelectorAll('[data-dup-key]').forEach((inp) => (inp.oninput = () => {
    const g = state.dups.find((x) => x.id === inp.dataset.dupKey);
    if (inp.value.trim() && inp.value.trim() !== g.suggestion.id) state.i18n.overrides.set(g.id, inp.value.trim()); else state.i18n.overrides.delete(g.id);
  }));
  $('#dup-select-safe').onclick = () => { for (const g of visibleDups()) if (g.status === 'safe') state.i18n.selected.add(g.id); renderDups(body); };
  $('#dup-select-none').onclick = () => { state.i18n.selected.clear(); renderDups(body); };
  $('#dup-export-json').onclick = exportPlan;
  $('#dup-export-md').onclick = () => download(`archimap-traductions-${state.project.name}.md`, markdownReport(), 'text/markdown');
  $('#dup-export-csv').onclick = exportCsv;
}

function updateDupSummary() {
  const sel = state.dups.filter((g) => state.i18n.selected.has(g.id));
  const saved = sel.reduce((s, g) => s + g.savings, 0);
  const el = $('#dup-summary');
  if (el) el.innerHTML = sel.length ? `<b>${sel.length}</b> groupe(s) sélectionné(s) · <b>${saved}</b> clé(s) en moins` : '<span class="muted">Aucune sélection — cochez les groupes à regrouper</span>';
}

function dupCard(g, idx, others) {
  const checked = state.i18n.selected.has(g.id);
  const target = groupTarget(g);
  const rows = g.occurrences.map((o) => `<tr>
      <td class="key">${h(o.id)}${o.id === target ? ' <span class="tag accent">cible</span>' : ''}</td>
      <td>${g.variants.length > 1 ? `« ${h(o.value)} » ` : ''}${plink(o.file, basename(o.file))}</td>
      <td>${usageCell(o)}</td>
      ${others.map((l) => { const it = idx.get(l)?.get(o.id); return `<td>${it ? h(it.value) : '<span class="tag danger">manquante</span>'}</td>`; }).join('')}
    </tr>`).join('');
  const conflicts = g.others.filter((x) => x.variants.length > 1);
  return `<div class="dup ${checked ? 'selected' : ''}">
    <div class="dup-head">
      <input type="checkbox" data-dup-check="${h(g.id)}" ${checked ? 'checked' : ''} aria-label="Sélectionner" />
      <span class="dup-value">« ${h(g.value)} »</span>
      <span class="dup-count">×${g.occurrences.length}</span>
      <span class="tag">${h(g.locale)}</span>
      ${g.status === 'safe' ? '<span class="tag ok">fusion sûre</span>' : `<span class="tag warn" title="${h(conflicts.map((c) => c.locale + ' : ' + c.variants.map((v) => v.value).join(' / ')).join(' — '))}">à vérifier</span>`}
      ${g.variants.length > 1 ? `<span class="muted" style="font-size:.85rem">variantes : ${g.variants.map((v) => '« ' + h(v) + ' »').join(', ')}</span>` : ''}
    </div>
    <div class="dup-suggest">Regrouper sous <input class="key-input" data-dup-key="${h(g.id)}" value="${h(target)}" spellcheck="false" />
      ${g.suggestion.existing && !state.i18n.overrides.has(g.id) ? '<span class="tag ok">clé existante</span>' : '<span class="tag">nouvelle clé</span>'}
      ${conflicts.length ? `<span class="muted" style="font-size:.85rem">${conflicts.map((c) => `${h(c.locale)} : ${c.variants.map((v) => '« ' + h(v.value) + ' »').join(' / ')}`).join(' — ')}</span>` : ''}</div>
    <div class="table-wrap"><table>
      <tr><th>Clé</th><th>Fichier</th><th>Utilisée dans</th>${others.map((l) => `<th>${h(l)}</th>`).join('')}</tr>${rows}
    </table></div>
  </div>`;
}

function renderHardcoded(body) {
  const q = state.i18n.query.trim().toLowerCase();
  const items = state.hardcoded.filter((x) => !q || x.text.toLowerCase().includes(q));
  body.innerHTML = `<p class="note">Textes écrits directement dans le code alors qu'une traduction identique existe déjà : remplacez-les par la clé indiquée.</p>
    ${items.length ? `<div class="card table-wrap"><table><tr><th>Texte</th><th>Clé(s) existante(s)</th><th>Emplacements</th></tr>
      ${items.map((x) => `<tr><td><b>« ${h(x.text)} »</b></td><td>${x.keys.map((k) => `<div class="mono" style="font-size:.82rem">${h(k.id)} <span class="muted">(${h(k.locale)})</span></div>`).join('')}</td>
        <td><div class="files">${x.places.map((pl) => `<span>${plink(pl.path, basename(pl.path))} <span class="muted">l.${pl.line}</span></span>`).join('')}</div></td></tr>`).join('')}
    </table></div>` : '<p class="empty">Aucun texte en dur correspondant à une traduction existante.</p>'}`;
}

function renderUnused(body) {
  const q = state.i18n.query.trim().toLowerCase();
  const loc = state.i18n.locale;
  const rows = [];
  for (const t of state.project.i18n.translations) {
    if (loc && t.locale !== loc) continue;
    for (const e of t.entries) {
      if (e.usage.status === 'used' || (e.usage.status === 'dynamic' && !state.i18n.showDynamic)) continue;
      const id = keyId(t.namespace, e.key);
      if (q && !id.toLowerCase().includes(q) && !e.value.toLowerCase().includes(q)) continue;
      rows.push({ id, t, e });
    }
  }
  body.innerHTML = `<p class="note">Clés dont le nom n'apparaît nulle part dans le code. Attention aux clés construites dynamiquement
      (<code>t(\`errors.\${code}\`)</code>) : celles qui correspondent à un préfixe dynamique sont marquées « dynamique ? » et masquées par défaut.</p>
    <div class="toolbar" style="margin-bottom:10px"><label><input type="checkbox" id="u-dyn" ${state.i18n.showDynamic ? 'checked' : ''}/> Afficher aussi les clés peut-être dynamiques (${state.project.i18n.dynamicCount})</label>
    <button class="btn small" id="u-export">Exporter la liste</button></div>
    ${rows.length ? `<div class="card table-wrap"><table><tr><th>Clé</th><th>Texte</th><th>Langue</th><th>Fichier</th><th></th></tr>
      ${rows.slice(0, 1500).map((r) => `<tr><td class="key">${h(r.id)}</td><td>${h(r.e.value)}</td><td>${h(r.t.locale)}</td><td>${plink(r.t.path, basename(r.t.path))}</td><td>${usageCell({ e: r.e })}</td></tr>`).join('')}
    </table>${rows.length > 1500 ? `<p class="muted">… ${rows.length - 1500} de plus (utilisez le filtre)</p>` : ''}</div>` : '<p class="empty">Toutes les clés sont utilisées 🎉</p>'}`;
  $('#u-dyn').onchange = (e) => { state.i18n.showDynamic = e.target.checked; renderUnused(body); };
  $('#u-export').onclick = () => download('cles-inutilisees.txt', rows.map((r) => `${r.t.locale}\t${r.id}\t${r.e.value}`).join('\n'));
}

function renderMissing(body) {
  const miss = state.project.i18n.missing;
  const idx = indexTranslationsCached();
  const valueElsewhere = (id) => { for (const [l, m] of idx) if (m.has(id)) return `${l} : ${m.get(id).value}`; return ''; };
  body.innerHTML = miss.length
    ? `<p class="note">Clés présentes dans au moins une langue mais absentes d'une autre.</p><div class="grid cols-2">${miss.map((m) => `<div class="card"><h3>${h(m.locale)} <span class="tag danger">${m.missing.length} manquante(s)</span></h3>
        <div class="table-wrap"><table>${m.missing.slice(0, 500).map((id) => `<tr><td class="key">${h(id)}</td><td class="muted">${h(valueElsewhere(id))}</td></tr>`).join('')}</table></div></div>`).join('')}</div>`
    : `<p class="empty">${state.project.i18n.locales.length < 2 ? 'Une seule langue détectée.' : 'Toutes les langues ont les mêmes clés 🎉'}</p>`;
}

function renderAllKeys(body) {
  const q = state.i18n.query.trim().toLowerCase();
  const idx = indexTranslationsCached();
  const locales = state.project.i18n.locales;
  const ids = new Set();
  for (const m of idx.values()) for (const id of m.keys()) ids.add(id);
  const list = [...ids].sort().filter((id) => !q || id.toLowerCase().includes(q) || locales.some((l) => idx.get(l)?.get(id)?.value.toLowerCase().includes(q)));
  body.innerHTML = `<div class="card table-wrap"><table><tr><th>Clé</th>${locales.map((l) => `<th>${h(l)}</th>`).join('')}<th>Utilisée dans</th></tr>
    ${list.slice(0, 800).map((id) => {
      const first = locales.map((l) => idx.get(l)?.get(id)).find(Boolean);
      return `<tr><td class="key">${h(id)}</td>${locales.map((l) => { const it = idx.get(l)?.get(id); return `<td>${it ? h(it.value) : '<span class="tag danger">manquante</span>'}</td>`; }).join('')}<td>${usageCell(first)}</td></tr>`;
    }).join('')}</table>${list.length > 800 ? `<p class="muted">… ${list.length - 800} de plus (utilisez le filtre)</p>` : ''}</div>`;
}

function exportPlan() {
  const groups = selectedGroups();
  if (!groups.length) { toast('Sélectionnez au moins un groupe de doublons.'); return; }
  const plan = buildMigrationPlan(groups, state.project.i18n.translations);
  plan.project = state.project.name;
  plan.groups = groups.map((g) => ({ locale: g.locale, value: g.value, target: g.suggestion.id, keys: g.occurrences.map((o) => o.id), status: g.status }));
  download(`archimap-plan-${state.project.name}.json`, JSON.stringify(plan, null, 2), 'application/json');
  toast('Plan exporté — appliquez-le avec : node tools/apply-plan.mjs <dossier> <plan.json>');
}

function exportCsv() {
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [['langue', 'texte', 'occurrences', 'statut', 'cle_cible', 'cle', 'fichier', 'utilisee_dans'].join(';')];
  for (const g of visibleDups()) for (const o of g.occurrences) {
    lines.push([g.locale, g.value, g.occurrences.length, g.status === 'safe' ? 'fusion sûre' : 'à vérifier', groupTarget(g), o.id, o.file, (o.e.usage?.files || []).join(' ')].map(esc).join(';'));
  }
  download(`archimap-doublons-${state.project.name}.csv`, '﻿' + lines.join('\n'), 'text/csv');
}

function markdownReport() {
  const p = state.project;
  const groups = visibleDups();
  const i = p.insights;
  const L = [];
  L.push(`# Rapport ArchiMap — ${p.name}`, '', `_Généré le ${new Date().toLocaleString('fr-FR')}_`, '');
  L.push('## Résumé', '', `- ${p.files.length} fichiers, ${p.deps.edges.length} liens entre fichiers, ${p.deps.externals.length} paquets externes`);
  L.push(`- Langues : ${p.i18n.locales.join(', ') || '—'} — ${p.i18n.keyCount} clés`);
  L.push(`- ${groups.length} textes en double (${groups.reduce((s, g) => s + g.savings, 0)} clés regroupables)`);
  L.push(`- ${p.i18n.unusedCount} clés non trouvées dans le code, ${state.hardcoded.length} textes écrits en dur`);
  L.push(`- ${i.cycles.length} cycles, ${i.orphans.length} fichiers orphelins, ${i.duplicateFiles.length} groupes de fichiers identiques`, '');
  if (groups.length) {
    L.push('## Traductions en double', '');
    for (const g of groups) {
      L.push(`### « ${g.value} » ×${g.occurrences.length} (${g.locale}) — ${g.status === 'safe' ? 'fusion sûre' : 'à vérifier'}`, '');
      L.push(`Clé commune proposée : \`${groupTarget(g)}\``, '');
      for (const o of g.occurrences) L.push(`- \`${o.id}\` — ${o.file}${o.e.usage?.files.length ? ` (utilisée dans ${o.e.usage.files.length} fichier(s))` : ' (non utilisée)'}`);
      for (const c of g.others.filter((x) => x.variants.length > 1)) L.push(`- ⚠️ ${c.locale} : ${c.variants.map((v) => `« ${v.value} »`).join(' / ')}`);
      L.push('');
    }
  }
  if (state.hardcoded.length) {
    L.push('## Textes écrits en dur', '');
    for (const x of state.hardcoded) L.push(`- « ${x.text} » → \`${x.keys[0].id}\` : ${x.places.map((pl) => `${pl.path}:${pl.line}`).join(', ')}`);
    L.push('');
  }
  if (i.cycles.length) { L.push('## Dépendances circulaires', ''); for (const c of i.cycles) L.push(`- ${[...c, c[0]].join(' → ')}`); L.push(''); }
  if (i.orphans.length) { L.push('## Fichiers potentiellement inutilisés', ''); for (const o of i.orphans) L.push(`- ${o}`); L.push(''); }
  if (i.duplicateFiles.length) { L.push('## Fichiers identiques', ''); for (const d of i.duplicateFiles) L.push(`- ${d.paths.join(' = ')}`); L.push(''); }
  if (i.sameNames.length) { L.push('## Noms de fichiers en double', ''); for (const d of i.sameNames) L.push(`- ${d.name} : ${d.paths.join(', ')}`); L.push(''); }
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* Optimisations                                                       */
/* ------------------------------------------------------------------ */

function renderInsights() {
  const p = state.project;
  const i = p.insights;
  const card = (title, count, desc, content, cls = 'warn') => `<div class="card"><div class="section-title"><h2>${title}</h2>${count ? `<span class="tag ${cls}">${count}</span>` : '<span class="tag ok">0</span>'}</div><p class="muted">${desc}</p>${content}</div>`;
  const cycles = i.cycles.map((c) => `<li style="display:block">${[...c, c[0]].map((x) => plink(x, basename(x))).join(' <span class="muted">→</span> ')}</li>`).join('');
  const unresolved = p.files.filter((f) => f.unresolved.length);
  $('#view-insights').innerHTML = `
    <p class="note">Ces indicateurs sont des <b>pistes</b> : vérifiez toujours avant de supprimer ou déplacer un fichier (imports dynamiques, fichiers chargés par configuration…).
      Pour le rapport complet : <button class="btn small" id="ins-export">Exporter le rapport Markdown</button></p>
    <div class="grid cols-2">
      ${card('Dépendances circulaires', i.cycles.length, 'Des fichiers qui s\'importent mutuellement (directement ou en chaîne). Extrayez la partie commune dans un module partagé.', `<ul class="list">${cycles}</ul>`, 'danger')}
      ${card('Fichiers potentiellement inutilisés', i.orphans.length, 'Aucun fichier ne les importe (points d\'entrée, pages et tests exclus).', pathList(i.orphans, 15))}
      ${card('Fichiers identiques', i.duplicateFiles.length, 'Même contenu exact : gardez-en un seul et importez-le.', `<ul class="list">${i.duplicateFiles.map((d) => `<li style="display:block">${d.paths.map((x) => plink(x)).join('<br>')} <span class="tag">${formatBytes(d.size)}</span></li>`).join('')}</ul>`)}
      ${card('Noms de fichiers en double', i.sameNames.length, 'Même nom dans plusieurs dossiers : candidats à la fusion (ex. plusieurs <code>utils.ts</code>) ou à un renommage plus explicite.', `<ul class="list">${i.sameNames.slice(0, 30).map((d) => `<li style="display:block"><b class="mono">${h(d.name)}</b> <span class="tag">×${d.paths.length}</span><br>${d.paths.map((x) => plink(x)).join('<br>')}</li>`).join('')}</ul>`)}
      ${card('Dossiers interdépendants', i.mutualCoupling.length, 'Deux dossiers qui s\'importent l\'un l\'autre : la frontière entre eux est floue.', `<ul class="list">${i.mutualCoupling.slice(0, 20).map((m) => `<li>${dlink(m.a)} ⇄ ${dlink(m.b)}<span class="tag">${m.ab} / ${m.ba}</span></li>`).join('')}</ul>`)}
      ${card('Dossiers à un seul fichier', i.lonelyFolders.length, 'Peut-être à aplatir ou à regrouper avec un dossier voisin.', `<ul class="list">${i.lonelyFolders.slice(0, 30).map((d) => `<li>${dlink(d)}</li>`).join('')}</ul>`, '')}
      ${card('Fichiers volumineux', i.largeFiles.length, 'Plus de 400 lignes : à découper en modules plus petits ?', `<ul class="list">${i.largeFiles.map((x) => `<li>${plink(x.path)}<span class="tag">${formatNumber(x.lines)} lignes</span></li>`).join('')}</ul>`, '')}
      ${card('Fichiers centraux', i.hubs.filter((x) => x.count > 1).length, 'Les plus importés : toute modification a un fort impact.', `<ul class="list">${i.hubs.filter((x) => x.count > 1).map((x) => `<li>${plink(x.path)}<span class="tag ok">${x.count}</span></li>`).join('')}</ul>`, '')}
      ${card('Arborescence profonde', i.deepFiles.length, 'Fichiers à plus de 7 niveaux de profondeur.', pathList(i.deepFiles, 10), '')}
      ${card('Imports non résolus', unresolved.length, 'Imports qu\'ArchiMap n\'a pas pu relier à un fichier (alias non détecté, fichier manquant…).', `<ul class="list">${unresolved.slice(0, 30).map((f) => `<li style="display:block">${plink(f.path)}<br>${f.unresolved.map((u) => `<span class="tag warn mono">${h(u)}</span>`).join(' ')}</li>`).join('')}</ul>`, '')}
    </div>`;
  $('#ins-export').onclick = () => download(`archimap-rapport-${state.project.name}.md`, markdownReport(), 'text/markdown');
}

/* ------------------------------------------------------------------ */
/* Événements globaux                                                  */
/* ------------------------------------------------------------------ */

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
}

function init() {
  applyTheme(store.get('theme', null));
  $('#btn-theme').onclick = () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    store.set('theme', next);
  };
  $('#btn-open').onclick = openFolder;
  $('#btn-open-2').onclick = openFolder;
  $('#btn-demo').onclick = () => load(async () => ({ name: 'demo-shop', entries: demoEntries() }));
  $('#btn-rescan').onclick = () => state.dirHandle && load(() => entriesFromDirectoryHandle(state.dirHandle, state.ignores, progress));
  $('#dir-input').onchange = (e) => {
    const list = e.target.files;
    if (list?.length) load(() => entriesFromFileList(list, state.ignores, progress));
    e.target.value = '';
  };
  $('#btn-settings').onclick = () => { $('#ignores').value = state.ignores.join(', '); $('#settings').showModal(); };
  $('#settings').addEventListener('close', () => {
    const v = $('#settings').returnValue;
    if (v === 'reset') state.ignores = [...DEFAULT_IGNORES];
    else if (v === 'ok') state.ignores = $('#ignores').value.split(',').map((s) => s.trim()).filter(Boolean);
    else return;
    store.set('ignores', state.ignores);
    toast('Paramètres enregistrés — rouvrez le dossier pour les appliquer.');
  });
  $('#tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) switchTab(b.dataset.tab); };
  $('#details-close').onclick = closeDetails;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#details').hidden) closeDetails(); });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tree-dir],[data-path],[data-dir],[data-goto],[data-reveal],[data-focus-graph],[data-graph-scope]');
    if (!t || !state.project) return;
    if (t.dataset.treeDir !== undefined) {
      const p = t.dataset.treeDir;
      if (!treeFilter()) { if (state.tree.open.has(p)) state.tree.open.delete(p); else state.tree.open.add(p); }
      state.selection = { type: 'dir', path: p };
      renderTreeRows();
      showDir(p);
    } else if (t.dataset.path !== undefined) {
      showFile(t.dataset.path);
    } else if (t.dataset.dir !== undefined) {
      showDir(t.dataset.dir === '(racine)' ? '' : t.dataset.dir);
    } else if (t.dataset.goto) {
      if (t.dataset.sub) { state.i18n.sub = t.dataset.sub; markDirty('i18n'); }
      switchTab(t.dataset.goto);
    } else if (t.dataset.reveal) {
      revealInTree(t.dataset.reveal);
    } else if (t.dataset.focusGraph) {
      focusInGraph(t.dataset.focusGraph);
    } else if (t.dataset.graphScope !== undefined) {
      state.graph.scope = t.dataset.graphScope;
      state.graph.mode = 'files';
      switchTab('graph');
    }
  });

  // Glisser-déposer d'un dossier n'importe où dans la page.
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; $('#dragover').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('#dragover').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    $('#dragover').hidden = true;
    if (e.dataTransfer?.items?.length) load(() => entriesFromDrop(e.dataTransfer, state.ignores, progress));
  });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.tab === 'graph' && state.project) renderGraphView(); }, 250); });

  if (new URLSearchParams(location.search).has('demo')) $('#btn-demo').click();
}

init();
