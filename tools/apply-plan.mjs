#!/usr/bin/env node
// Applique un plan de migration exporté par ArchiMap (onglet Traductions > Plan de migration) :
//  - fichiers JSON / ARB : supprime les clés en double et ajoute la clé commune ;
//  - code source : remplace 'ancienne.cle' par 'nouvelle.cle' dans les chaînes littérales.
//
// Usage : node tools/apply-plan.mjs <dossier-du-projet> <plan.json> [--write]
// Sans --write, rien n'est modifié : le script affiche seulement ce qu'il ferait.
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isTranslationCandidate, detectLocale } from '../js/i18n.js';
import { DEFAULT_IGNORES } from '../js/project.js';
import { extname } from '../js/utils.js';

const CODE_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro', 'html', 'htm', 'dart', 'py', 'php']);

const args = process.argv.slice(2);
const write = args.includes('--write');
const [root, planPath] = args.filter((a) => !a.startsWith('--'));
if (!root || !planPath) {
  console.error('Usage : node tools/apply-plan.mjs <dossier-du-projet> <plan.json> [--write]');
  process.exit(1);
}

const plan = JSON.parse(await readFile(planPath, 'utf8'));
const renames = plan.renames || {};
const additions = plan.additions || {};

const splitId = (id) => {
  const i = id.indexOf(':');
  return i < 0 ? { ns: '', key: id } : { ns: id.slice(0, i), key: id.slice(i + 1) };
};

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (DEFAULT_IGNORES.includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if ((await stat(full)).size < 1.5 * 1024 * 1024) out.push(full);
  }
  return out;
}

/** Trouve une clé "a.b.c" dans un objet, qu'il soit imbriqué ou plat ({"a.b": {"c": ...}}). */
function locate(obj, key) {
  if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key)) return { parent: obj, prop: key, chain: [] };
  const parts = key.split('.');
  for (let i = 1; i < parts.length; i++) {
    const head = parts.slice(0, i).join('.');
    const child = obj?.[head];
    if (child && typeof child === 'object') {
      const r = locate(child, parts.slice(i).join('.'));
      if (r) return { ...r, chain: [{ parent: obj, prop: head }, ...r.chain] };
    }
  }
  return null;
}

function removeKey(obj, key) {
  const loc = locate(obj, key);
  if (!loc) return undefined;
  const value = loc.parent[loc.prop];
  delete loc.parent[loc.prop];
  // Supprime les objets parents devenus vides.
  for (let i = loc.chain.length - 1; i >= 0; i--) {
    const { parent, prop } = loc.chain[i];
    if (Object.keys(parent[prop]).length === 0) delete parent[prop];
    else break;
  }
  return value;
}

function setKey(obj, key, value, flat) {
  if (locate(obj, key)) return false;
  if (flat) { obj[key] = value; return true; }
  const parts = key.split('.');
  let node = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof node[p] !== 'object' || node[p] === null) node[p] = {};
    node = node[p];
  }
  node[parts[parts.length - 1]] = value;
  return true;
}

const files = await walk(root);
const rel = (f) => relative(root, f).split(sep).join('/');

// 1) Fichiers de traduction
const translations = [];
for (const f of files) {
  const path = rel(f);
  const ext = extname(path);
  if (!isTranslationCandidate(path) || (ext !== 'json' && ext !== 'arb')) continue;
  const text = await readFile(f, 'utf8');
  let data;
  try { data = JSON.parse(text); } catch { continue; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
  const { locale, namespace } = detectLocale(path);
  const indent = (/\n([ \t]+)"/.exec(text) || [, '  '])[1];
  const isFlat = ext === 'arb' || Object.values(data).every((v) => typeof v === 'string');
  translations.push({ file: f, path, ext, locale: ext === 'arb' && data['@@locale'] ? String(data['@@locale']).replace('_', '-') : locale, namespace, data, indent, isFlat, changed: false, log: [] });
}

const arbKeys = new Set();
for (const t of translations) {
  for (const [from, to] of Object.entries(renames)) {
    const a = splitId(from), b = splitId(to);
    if (a.ns !== t.namespace) continue;
    const value = removeKey(t.data, a.key);
    if (value === undefined) continue;
    if (t.ext === 'arb') {
      arbKeys.add(a.key);
      const meta = t.data['@' + a.key];
      delete t.data['@' + a.key];
      if (meta && !t.data['@' + b.key]) t.data['@' + b.key] = meta;
    }
    t.changed = true;
    t.log.push(`- ${from}`);
    const target = translations.find((x) => x.locale === t.locale && x.namespace === b.ns) || t;
    const v = additions[t.locale]?.[to] ?? value;
    if (setKey(target.data, b.key, v, target.isFlat && target.ext === 'arb')) {
      target.changed = true;
      target.log.push(`+ ${to} = ${JSON.stringify(v)}`);
    }
  }
  for (const [to, v] of Object.entries(additions[t.locale] || {})) {
    const b = splitId(to);
    if (b.ns !== t.namespace) continue;
    if (setKey(t.data, b.key, v, t.isFlat && t.ext === 'arb')) { t.changed = true; t.log.push(`+ ${to} = ${JSON.stringify(v)}`); }
  }
}

// 2) Code source : remplacement des clés dans les chaînes littérales
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const replacements = [];
for (const [from, to] of Object.entries(renames)) {
  const a = splitId(from), b = splitId(to);
  replacements.push([from, to]);
  if (a.ns && b.ns) replacements.push([a.key, b.key, a.ns]); // t('cle') avec useTranslation('ns')
  else if (!a.ns) replacements.push([a.key, b.key]);
}
const codeChanges = [];
for (const f of files) {
  const path = rel(f);
  const ext = extname(path);
  if (!CODE_EXTS.has(ext)) continue;
  let text = await readFile(f, 'utf8');
  const original = text;
  let count = 0;
  for (const [from, to, onlyNs] of replacements) {
    if (onlyNs && !text.includes(onlyNs)) continue;
    const re = new RegExp(`(['"\`])${escapeRe(from)}\\1`, 'g');
    text = text.replace(re, (_m, q) => { count++; return q + to + q; });
    if (ext === 'dart' && arbKeys.has(from)) {
      text = text.replace(new RegExp(`\\.${escapeRe(from)}\\b`, 'g'), () => { count++; return '.' + to; });
    }
  }
  if (text !== original) codeChanges.push({ file: f, path, text, count });
}

// 3) Résumé et écriture
console.log(write ? 'Application du plan…\n' : 'Simulation (ajoutez --write pour appliquer)\n');
for (const t of translations.filter((x) => x.changed)) {
  console.log(`📄 ${t.path} (${t.locale})`);
  for (const l of t.log) console.log('   ' + l);
  if (write) await writeFile(t.file, JSON.stringify(t.data, null, t.indent) + '\n');
}
for (const c of codeChanges) {
  console.log(`🧩 ${c.path} : ${c.count} remplacement(s)`);
  if (write) await writeFile(c.file, c.text);
}
const touched = translations.filter((x) => x.changed).length + codeChanges.length;
console.log(`\n${touched} fichier(s) ${write ? 'modifié(s)' : 'à modifier'}.`);
if (!write && touched) console.log('Relancez avec --write pour appliquer (pensez à committer avant !).');
console.log('Formats YAML, XML, .strings et .properties : appliquez les renommages manuellement (voir le plan).');
