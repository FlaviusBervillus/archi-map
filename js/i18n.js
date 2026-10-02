// Analyse des fichiers de traduction : détection, parsing, doublons, usages, clés manquantes.
import { basename, dirname, extname, stripExt, lineIndex } from './utils.js';
import { JS_LIKE } from './deps.js';

const ISO_639_1 = new Set(('aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu fil').split(' '));
const I18N_DIR_RE = /^(i18n|l10n|locales?|langs?|languages?|translations?|messages|lang|intl|strings)$/i;
const NOT_TRANSLATION_RE = /^(package(-lock)?|composer|tsconfig.*|jsconfig.*|angular|nx|project|firebase|vercel|netlify|app|manifest|\.?eslintrc|\.?prettierrc|\.?babelrc|lerna|turbo|renovate|components|nest-cli|deno)\.json$|\.config\.json$/i;
const CODE_FOR_USAGE = new Set([...JS_LIKE, 'html', 'htm', 'dart', 'py', 'php', 'kt', 'java', 'swift', 'rb', 'cs', 'xml', 'twig', 'erb', 'blade', 'hbs', 'ejs', 'pug']);

/** "fr", "fr-FR", "fr_FR", "pt-BR", "zh-Hans" -> code normalisé, sinon null. */
export function asLocale(token) {
  const m = /^([a-z]{2,3})(?:[-_]([a-z]{2}|[a-z]{4}|\d{3}))?$/i.exec(token || '');
  if (!m) return null;
  const lang = m[1].toLowerCase();
  if (!ISO_639_1.has(lang)) return null;
  if (m[1] !== lang && m[1] !== m[1].toUpperCase()) return null; // "Fr" improbable
  return m[2] ? lang + '-' + (m[2].length === 2 ? m[2].toUpperCase() : m[2]) : lang;
}

export function isTranslationCandidate(path) {
  const ext = extname(path);
  const name = basename(path);
  const segments = path.split('/');
  const dirs = segments.slice(0, -1);
  if (ext === 'arb') return true;
  if (name === 'strings.xml') return dirs.some((d) => /^values(-|$)/.test(d));
  if (ext === 'strings') return dirs.some((d) => d.endsWith('.lproj'));
  if (ext === 'properties') return /_[a-z]{2}(_[A-Z]{2})?\.properties$|^messages\.properties$/.test(name);
  if (!['json', 'yaml', 'yml'].includes(ext)) return false;
  if (NOT_TRANSLATION_RE.test(name) || name === 'pubspec.yaml' || name.startsWith('.')) return false;
  if (dirs.some((d) => I18N_DIR_RE.test(d))) return true;
  const base = stripExt(name);
  if (asLocale(base)) return true;
  const parts = base.split('.');
  return parts.length > 1 && !!asLocale(parts[parts.length - 1]);
}

/** Déduit langue + namespace d'un fichier de traduction à partir de son chemin. */
export function detectLocale(path) {
  const ext = extname(path);
  const name = basename(path);
  const base = stripExt(name);
  const dirs = dirname(path).split('/').filter(Boolean);

  if (ext === 'arb') {
    const m = /^(.*?)[_-]([a-z]{2,3}(?:[_-][A-Za-z]{2,4})?)$/.exec(base);
    if (m && asLocale(m[2])) return { locale: asLocale(m[2]), namespace: '' };
    return { locale: asLocale(base) || 'default', namespace: '' };
  }
  if (name === 'strings.xml') {
    const d = dirs[dirs.length - 1] || '';
    const m = /^values-([a-z]{2,3})(?:-r([A-Z]{2}))?/.exec(d);
    return { locale: m ? asLocale(m[1] + (m[2] ? '-' + m[2] : '')) || m[1] : 'default', namespace: '' };
  }
  if (ext === 'strings') {
    const lp = dirs.find((d) => d.endsWith('.lproj'));
    const code = lp ? lp.slice(0, -6) : '';
    return { locale: asLocale(code) || (code ? code.toLowerCase() : 'default'), namespace: base === 'Localizable' ? '' : base };
  }
  if (ext === 'properties') {
    const m = /^(.*?)_([a-z]{2}(?:_[A-Z]{2})?)$/.exec(base);
    return m ? { locale: asLocale(m[2]), namespace: '' } : { locale: 'default', namespace: '' };
  }
  const direct = asLocale(base);
  if (direct) return { locale: direct, namespace: '' };
  const parts = base.split('.');
  if (parts.length > 1 && asLocale(parts[parts.length - 1])) {
    return { locale: asLocale(parts.pop()), namespace: parts.join('.') };
  }
  for (let i = dirs.length - 1; i >= 0; i--) {
    const loc = asLocale(dirs[i]);
    if (loc) return { locale: loc, namespace: [...dirs.slice(i + 1), base].join('/') };
  }
  return { locale: 'default', namespace: base };
}

function flattenJson(obj, prefix, out, stats) {
  if (typeof obj === 'string') {
    stats.strings++;
    out.push({ key: prefix, value: obj });
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => flattenJson(v, prefix ? `${prefix}.${i}` : String(i), out, stats));
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) flattenJson(v, prefix ? `${prefix}.${k}` : k, out, stats);
  } else {
    stats.other++;
  }
}

/** Parseur YAML minimal (maps imbriquées de scalaires, blocs | et >) adapté aux fichiers i18n. */
export function parseSimpleYaml(text) {
  const out = [];
  const stack = []; // { indent, key }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw) || /^\s*-/.test(raw) || raw.trim() === '---') continue;
    const m = /^(\s*)(["']?)([^"':#][^:]*?|[^"']*?)\2\s*:(?:\s+(.*))?$/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[3].trim();
    let value = (m[4] ?? '').trim();
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const fullKey = [...stack.map((s) => s.key), key].join('.');
    if (value === '' || value.startsWith('&')) { stack.push({ indent, key }); continue; }
    if (/^[|>][-+]?$/.test(value)) {
      const block = [];
      let blockIndent = null;
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim() === '') { block.push(''); i++; continue; }
        const ind = /^(\s*)/.exec(next)[1].length;
        if (ind <= indent) break;
        if (blockIndent === null) blockIndent = ind;
        block.push(next.slice(blockIndent));
        i++;
      }
      value = value.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').trim();
    } else if (/^".*"$/.test(value)) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
    } else if (/^'.*'$/.test(value)) {
      value = value.slice(1, -1).replace(/''/g, "'");
    } else {
      value = value.replace(/\s+#.*$/, '');
      if (/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(value)) continue;
    }
    out.push({ key: fullKey, value });
  }
  return out;
}

function unescapeXml(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/\\'/g, "'");
}

/** Parse un fichier de traduction. Retourne null s'il ne ressemble pas à des traductions. */
export function parseTranslationFile(path, content) {
  if (content == null) return null;
  const ext = extname(path);
  let { locale, namespace } = detectLocale(path);
  let entries = [];
  try {
    if (ext === 'json' || ext === 'arb') {
      const data = JSON.parse(content);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      if (ext === 'arb') {
        if (typeof data['@@locale'] === 'string') locale = asLocale(data['@@locale']) || locale;
        for (const [k, v] of Object.entries(data)) if (!k.startsWith('@') && typeof v === 'string') entries.push({ key: k, value: v });
      } else {
        const stats = { strings: 0, other: 0 };
        flattenJson(data, '', entries, stats);
        if (!stats.strings || stats.strings / (stats.strings + stats.other) < 0.7) return null;
      }
    } else if (ext === 'yaml' || ext === 'yml') {
      entries = parseSimpleYaml(content);
      // Style Rails : "fr:\n  key: ..." -> on retire la racine de langue.
      const roots = new Set(entries.map((e) => e.key.split('.')[0]));
      if (roots.size === 1) {
        const root = [...roots][0];
        if (asLocale(root)) {
          locale = asLocale(root);
          entries = entries.map((e) => ({ key: e.key.slice(root.length + 1), value: e.value }));
        }
      }
    } else if (ext === 'xml') {
      for (const m of content.matchAll(/<string\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)) entries.push({ key: m[1], value: unescapeXml(m[2]) });
    } else if (ext === 'strings') {
      for (const m of content.matchAll(/^\s*"((?:\\.|[^"\\])*)"\s*=\s*"((?:\\.|[^"\\])*)"\s*;/gm)) entries.push({ key: m[1], value: m[2].replace(/\\"/g, '"').replace(/\\n/g, '\n') });
    } else if (ext === 'properties') {
      for (const m of content.matchAll(/^\s*([^#!\s=:][^=:]*?)\s*[=:]\s*(.*)$/gm)) entries.push({ key: m[1], value: m[2] });
    }
  } catch {
    return null;
  }
  entries = entries.filter((e) => e.key);
  if (!entries.length) return null;
  return { path, ext, locale, namespace, entries };
}

/** Identifiant unique d'une clé, en tenant compte du namespace (fichier). */
export function keyId(namespace, key) {
  return namespace ? `${namespace}:${key}` : key;
}

/**
 * Indexe les chaînes littérales et identifiants trouvés dans le code pour savoir
 * où chaque clé de traduction est utilisée, et repérer les textes écrits en dur.
 */
export function buildUsageIndex(files) {
  const literals = new Map(); // chaîne -> Set(chemins)
  const identifiers = new Map(); // identifiant (après "." ou "@string/") -> Set(chemins)
  const dynamicPrefixes = new Map(); // préfixe de template `errors.${x}` -> Set(chemins)
  const texts = []; // { text, path, line, kind }
  const add = (map, k, p) => {
    let s = map.get(k);
    if (!s) map.set(k, (s = new Set()));
    s.add(p);
  };
  for (const f of files) {
    if (f.content == null || !CODE_FOR_USAGE.has(f.ext) || f.isTranslation) continue;
    if (f.ext === 'xml' && !/layout|menu|navigation|AndroidManifest/.test(f.path)) continue;
    const src = f.content;
    const toLine = lineIndex(src);
    for (const m of src.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      const value = m[2];
      if (!value) continue;
      if (m[1] === '`' && value.includes('${')) {
        const prefix = value.slice(0, value.indexOf('${'));
        if (prefix.length >= 2 && !/\s/.test(prefix)) add(dynamicPrefixes, prefix, f.path);
        continue;
      }
      add(literals, value, f.path);
      if (looksLikeHumanText(value)) texts.push({ text: value, path: f.path, line: toLine(m.index), kind: 'string' });
    }
    for (const m of src.matchAll(/(?:\.|@string\/|R\.string\.)([A-Za-z_$][\w$]*)/g)) add(identifiers, m[1], f.path);
    // Texte brut entre balises (JSX, Vue, Angular, HTML).
    if (JS_LIKE.has(f.ext) || f.ext === 'html' || f.ext === 'htm') {
      for (const m of src.matchAll(/>([^<>{}\n`]*[\p{L}][^<>{}\n`]*)</gu)) {
        const t = m[1].trim();
        if (t && looksLikeHumanText(t) && !/^[\w$.]+\s*(=>|\(|&&|\|\|)/.test(t)) texts.push({ text: t, path: f.path, line: toLine(m.index), kind: 'markup' });
      }
    }
  }
  return { literals, identifiers, dynamicPrefixes, texts };
}

function looksLikeHumanText(s) {
  if (s.length < 2 || s.length > 200) return false;
  if (!/\p{Lu}|\s/u.test(s)) return false; // "Annuler", "Mot de passe", pas "cancel" ni "flex"
  if (/^[\w-]+(\.[\w-]+)+$/.test(s)) return false; // clé ou nom de fichier
  if (/^[./@~#]|:\/\/|^\w+\/|[{}<>;=]|^\s*$/.test(s)) return false;
  if (/^[A-Z0-9_]+$/.test(s)) return false; // CONSTANTE
  if (/^(?:[a-z][\w-]*\s+)*[a-z][\w-]*$/.test(s) && /-/.test(s)) return false; // classes CSS
  return /\p{L}{2,}/u.test(s);
}

/** Statut d'utilisation d'une clé dans le code : { status: 'used'|'dynamic'|'unused', files: [] } */
export function keyUsage(usage, t, entry) {
  const files = new Set();
  const candidates = [entry.key];
  if (t.namespace) candidates.push(`${t.namespace}:${entry.key}`, `${t.namespace}.${entry.key}`);
  for (const c of candidates) for (const p of usage.literals.get(c) || []) files.add(p);
  // Flutter (AppLocalizations.of(context).cle) et Android (R.string.cle / @string/cle).
  if (t.ext === 'arb' || t.ext === 'xml') for (const p of usage.identifiers.get(entry.key) || []) files.add(p);
  if (files.size) return { status: 'used', files: [...files].sort() };
  const dyn = new Set();
  for (const [prefix, paths] of usage.dynamicPrefixes) {
    if (candidates.some((c) => c.startsWith(prefix))) paths.forEach((p) => dyn.add(p));
  }
  if (dyn.size) return { status: 'dynamic', files: [...dyn].sort() };
  return { status: 'unused', files: [] };
}

export const DEFAULT_DUP_OPTIONS = { ignoreCase: true, ignoreAccents: false, ignorePunctuation: true, loose: false, minCount: 2 };

export function normalizeValue(v, opts = DEFAULT_DUP_OPTIONS) {
  let s = String(v).trim().replace(/\s+/g, ' ');
  if (opts.ignoreCase) s = s.toLocaleLowerCase('fr');
  if (opts.ignoreAccents) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (opts.loose) s = s.replace(/[^\p{L}\p{N}{}]+/gu, '');
  else if (opts.ignorePunctuation) s = s.replace(/[\s.:!?…,;*]+$/u, '').replace(/^[\s¡¿*]+/u, '');
  return s;
}

const COMMON_PREFIX_RE = /^(common|shared|global|generic|general|core|actions?|buttons?|labels?|commons)([.:/_]|[A-Z])/;

function slugify(text) {
  const words = text
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim().toLowerCase().split(' ').filter(Boolean).slice(0, 4);
  if (!words.length) return 'text';
  return words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('');
}

/** Regroupe toutes les traductions chargées : index par langue et par identifiant de clé. */
export function indexTranslations(translations) {
  const byLocale = new Map(); // locale -> Map(id -> {file, key, namespace, value})
  for (const t of translations) {
    if (!byLocale.has(t.locale)) byLocale.set(t.locale, new Map());
    const m = byLocale.get(t.locale);
    for (const e of t.entries) m.set(keyId(t.namespace, e.key), { file: t.path, key: e.key, namespace: t.namespace, value: e.value, t, e });
  }
  return byLocale;
}

/**
 * Trouve les valeurs dupliquées par langue ("Annuler" utilisé sous 4 clés...)
 * et propose une clé commune pour les regrouper.
 */
export function findDuplicates(translations, opts = DEFAULT_DUP_OPTIONS) {
  const byLocale = indexTranslations(translations);
  const englishLocale = [...byLocale.keys()].find((l) => l === 'en' || l.startsWith('en-'));
  const groups = [];
  for (const [locale, map] of byLocale) {
    const buckets = new Map();
    for (const [id, item] of map) {
      const norm = normalizeValue(item.value, opts);
      if (!norm || !/[\p{L}\p{N}]/u.test(norm)) continue;
      if (!buckets.has(norm)) buckets.set(norm, []);
      buckets.get(norm).push({ id, ...item });
    }
    for (const [norm, occ] of buckets) {
      if (occ.length < (opts.minCount || 2)) continue;
      occ.sort((a, b) => a.id.localeCompare(b.id));
      const ids = occ.map((o) => o.id);
      // Vérifie les autres langues : les mêmes clés ont-elles aussi la même traduction ?
      const others = [];
      let conflict = false;
      for (const [other, omap] of byLocale) {
        if (other === locale) continue;
        const values = new Map();
        let missing = 0;
        for (const id of ids) {
          const it = omap.get(id);
          if (!it) { missing++; continue; }
          const n = normalizeValue(it.value, opts);
          if (!values.has(n)) values.set(n, { value: it.value, ids: [] });
          values.get(n).ids.push(id);
        }
        if (values.size > 1) conflict = true;
        others.push({ locale: other, variants: [...values.values()], missing });
      }
      const variants = [...new Set(occ.map((o) => o.value))];
      const suggestion = suggestKey(occ, map, englishLocale && englishLocale !== locale ? byLocale.get(englishLocale) : null, norm, opts);
      groups.push({
        id: `${locale}::${norm}`,
        locale,
        norm,
        value: mostFrequent(occ.map((o) => o.value)),
        variants,
        occurrences: occ,
        others,
        status: conflict ? 'conflict' : 'safe',
        suggestion,
        savings: occ.length - 1,
      });
    }
  }
  groups.sort((a, b) => b.occurrences.length - a.occurrences.length || a.norm.localeCompare(b.norm));
  return groups;
}

function mostFrequent(arr) {
  const c = new Map();
  for (const x of arr) c.set(x, (c.get(x) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function suggestKey(occ, localeMap, englishMap, norm, opts) {
  const existing = occ.filter((o) => COMMON_PREFIX_RE.test(o.id)).sort((a, b) => a.id.length - b.id.length)[0];
  if (existing) return { id: existing.id, existing: true };
  const ns = occ.some((o) => o.namespace === 'common') ? 'common:' : '';
  // Les formats "plats" n'acceptent pas les points : commonCancel (ARB), common_cancel (Android)…
  const ext = occ[0].t.ext;
  const flat = ext === 'arb' ? 'camel' : ext === 'xml' || ext === 'properties' || ext === 'strings' ? 'snake' : null;
  const prefix = ns ? '' : flat === 'camel' ? 'common' : flat === 'snake' ? 'common_' : 'common.';
  const lastSegments = occ.map((o) => o.key.split('.').pop());
  const counts = new Map();
  for (const s of lastSegments) counts.set(s, (counts.get(s) || 0) + 1);
  const [bestSeg, bestCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  let slug;
  if (bestCount >= 2 && !/^\d+$/.test(bestSeg)) slug = bestSeg;
  else if (englishMap) {
    const en = occ.map((o) => englishMap.get(o.id)?.value).find(Boolean);
    slug = slugify(en || occ[0].value);
  } else slug = slugify(occ[0].value);
  if (flat === 'camel') slug = slug[0].toUpperCase() + slug.slice(1);
  if (flat === 'snake') slug = slug.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  let id = ns + prefix + slug;
  let n = 2;
  while (localeMap.has(id) && normalizeValue(localeMap.get(id).value, opts) !== norm) id = ns + prefix + slug + n++;
  return { id, existing: localeMap.has(id) };
}

/** Clés présentes dans une langue mais absentes d'une autre. */
export function findMissingKeys(translations) {
  const byLocale = indexTranslations(translations);
  const all = new Set();
  for (const m of byLocale.values()) for (const id of m.keys()) all.add(id);
  const result = [];
  if (byLocale.size < 2) return result;
  for (const [locale, m] of byLocale) {
    const missing = [...all].filter((id) => !m.has(id)).sort();
    if (missing.length) result.push({ locale, missing });
  }
  return result;
}

/** Textes écrits en dur dans le code qui existent déjà dans les traductions. */
export function findHardcodedTexts(usage, translations, opts = DEFAULT_DUP_OPTIONS) {
  const byNorm = new Map();
  for (const t of translations) {
    for (const e of t.entries) {
      const n = normalizeValue(e.value, opts);
      if (!n) continue;
      if (!byNorm.has(n)) byNorm.set(n, []);
      const list = byNorm.get(n);
      if (list.length < 5) list.push({ id: keyId(t.namespace, e.key), locale: t.locale });
    }
  }
  const results = new Map();
  for (const t of usage.texts) {
    const n = normalizeValue(t.text, opts);
    const keys = byNorm.get(n);
    if (!keys) continue;
    if (!results.has(n)) results.set(n, { text: t.text, keys, places: [] });
    results.get(n).places.push({ path: t.path, line: t.line, kind: t.kind });
  }
  return [...results.values()].sort((a, b) => b.places.length - a.places.length);
}

/** Point d'entrée : charge toutes les traductions d'un projet et calcule les usages. */
export function analyzeTranslations(files) {
  const translations = [];
  for (const f of files) {
    if (!isTranslationCandidate(f.path)) continue;
    const t = parseTranslationFile(f.path, f.content);
    if (t) { translations.push(t); f.isTranslation = true; f.translation = t; }
  }
  const usage = buildUsageIndex(files);
  const fileKeys = new Map(); // fichier de code -> [ids de clés]
  let unused = 0, dynamic = 0;
  for (const t of translations) {
    for (const e of t.entries) {
      e.usage = keyUsage(usage, t, e);
      if (e.usage.status === 'unused') unused++;
      else if (e.usage.status === 'dynamic') dynamic++;
      if (e.usage.status === 'used') {
        for (const p of e.usage.files) {
          if (!fileKeys.has(p)) fileKeys.set(p, new Set());
          fileKeys.get(p).add(keyId(t.namespace, e.key));
        }
      }
    }
  }
  const locales = [...new Set(translations.map((t) => t.locale))].sort();
  return {
    translations,
    usage,
    fileKeys,
    locales,
    keyCount: new Set(translations.flatMap((t) => t.entries.map((e) => keyId(t.namespace, e.key)))).size,
    entryCount: translations.reduce((s, t) => s + t.entries.length, 0),
    unusedCount: unused,
    dynamicCount: dynamic,
    missing: findMissingKeys(translations),
  };
}

/** Plan de migration : anciennes clés -> clé commune, pour les groupes sélectionnés. */
export function buildMigrationPlan(groups, translations) {
  const byLocale = indexTranslations(translations);
  const renames = new Map();
  const additions = {};
  for (const g of groups) {
    const target = g.suggestion.id;
    for (const o of g.occurrences) if (o.id !== target) renames.set(o.id, target);
    for (const [locale, map] of byLocale) {
      if (map.has(target)) continue;
      const source = g.occurrences.map((o) => map.get(o.id)).find(Boolean);
      if (!source) continue;
      (additions[locale] ||= {})[target] = source.value;
    }
  }
  return {
    generatedBy: 'ArchiMap',
    generatedAt: new Date().toISOString(),
    renames: Object.fromEntries([...renames.entries()].sort()),
    additions,
  };
}
