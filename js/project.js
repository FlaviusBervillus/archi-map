// Assemble l'analyse complète d'un projet : arbre, dépendances, traductions, recommandations.
import { basename, dirname, extname, hashString, countLines, groupBy } from './utils.js';
import { buildDependencyGraph, CODE_EXTS, JS_LIKE, STYLE_EXTS } from './deps.js';
import { analyzeTranslations, findDuplicates, findHardcodedTexts, DEFAULT_DUP_OPTIONS } from './i18n.js';

export const DEFAULT_IGNORES = ['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.output', '.svelte-kit', 'coverage', '.dart_tool', '.idea', '.vscode', 'vendor', '__pycache__', '.angular', '.cache', '.turbo', '.venv', 'venv', 'Pods', '.gradle', '.expo', 'out', 'target', 'bin', 'obj'];

export const TEXT_EXTS = new Set([...CODE_EXTS, 'json', 'arb', 'yaml', 'yml', 'xml', 'strings', 'properties', 'md', 'txt', 'kt', 'java', 'swift', 'rb', 'go', 'rs', 'cs', 'twig', 'erb', 'hbs', 'ejs', 'pug', 'graphql', 'gql', 'sql', 'env', 'toml', 'ini', 'sh', 'svg']);

export const MAX_TEXT_SIZE = 1.5 * 1024 * 1024;

export function shouldIgnore(path, ignores = DEFAULT_IGNORES) {
  return path.split('/').some((seg) => ignores.includes(seg));
}

/** Construit l'arbre de dossiers à partir des fichiers. */
export function buildTree(files) {
  const root = { name: '', path: '', type: 'dir', children: new Map(), fileCount: 0, size: 0, lines: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/');
      if (!node.children.has(parts[i])) node.children.set(parts[i], { name: parts[i], path: p, type: 'dir', children: new Map(), fileCount: 0, size: 0, lines: 0 });
      node = node.children.get(parts[i]);
    }
    node.children.set(parts[parts.length - 1], { name: parts[parts.length - 1], path: f.path, type: 'file', file: f });
  }
  (function finalize(node) {
    const kids = [...node.children.values()];
    for (const k of kids) {
      if (k.type === 'dir') {
        finalize(k);
        node.fileCount += k.fileCount; node.size += k.size; node.lines += k.lines;
      } else {
        node.fileCount++; node.size += k.file.size; node.lines += k.file.lines || 0;
      }
    }
    node.children = kids.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'fr', { numeric: true }) : a.type === 'dir' ? -1 : 1));
  })(root);
  return root;
}

const ENTRY_NAME_RE = /^(index|main|app|server|client|_app|_document|_layout|\+page|\+layout|\+server|layout|page|loading|error|not-found|route|router|routes|middleware|setup|polyfills|environment.*|global|globals|styles?|reset|variables|vite-env\.d|env\.d|.*\.config|.*\.d|.*\.(test|spec|stories|story|e2e|cy|mock|fixture)s?|test_.*|conftest|manage|wsgi|asgi|settings|urls|__init__|__main__)\.[\w.]+$/i;
const ENTRY_DIR_RE = /(^|\/)(pages|app|routes|test|tests|__tests__|__mocks__|e2e|cypress|playwright|scripts|bin|public|static|stories|\.storybook|migrations|tools|config|bin|docs|examples?)(\/|$)/i;

/** Recommandations d'architecture basées sur le graphe et l'arbre. */
export function computeInsights(files, deps, tree) {
  const codeFiles = files.filter((f) => CODE_EXTS.has(f.ext) && !f.isTranslation);
  const hasLinks = deps.edges.length > 0;

  const orphans = hasLinks
    ? codeFiles
        .filter((f) => (JS_LIKE.has(f.ext) || STYLE_EXTS.has(f.ext) || f.ext === 'dart' || f.ext === 'py') && !f.importedBy.length)
        .filter((f) => !ENTRY_NAME_RE.test(basename(f.path)) && !ENTRY_DIR_RE.test(dirname(f.path)))
        .filter((f) => !(f.ext === 'dart' && /(^|\/)lib\/main\.dart$/.test(f.path)))
        .map((f) => f.path)
        .sort()
    : [];

  const duplicateFiles = [...groupBy(files.filter((f) => f.hash && f.size >= 64), (f) => f.hash).values()]
    .filter((g) => g.length > 1)
    .map((g) => ({ size: g[0].size, paths: g.map((f) => f.path).sort() }))
    .sort((a, b) => b.paths.length * b.size - a.paths.length * a.size);

  const GENERIC_NAMES = /^(index|main|types?|styles?|constants?|readme|package|tsconfig|\.gitignore|__init__|mod|module|routes?|\+page|\+layout|page|layout)\.\w+$/i;
  const sameNames = [...groupBy(codeFiles, (f) => basename(f.path).toLowerCase()).entries()]
    .filter(([name, g]) => g.length > 1 && !GENERIC_NAMES.test(name))
    .map(([name, g]) => ({ name, paths: g.map((f) => f.path).sort() }))
    .sort((a, b) => b.paths.length - a.paths.length || a.name.localeCompare(b.name));

  const largeFiles = codeFiles
    .filter((f) => f.lines > 400)
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 25)
    .map((f) => ({ path: f.path, lines: f.lines }));

  const hubs = files
    .filter((f) => f.importedBy?.length)
    .sort((a, b) => b.importedBy.length - a.importedBy.length)
    .slice(0, 15)
    .map((f) => ({ path: f.path, count: f.importedBy.length }));

  const deepFiles = files.filter((f) => f.path.split('/').length > 7).map((f) => f.path);

  const lonelyFolders = [];
  (function walk(node) {
    for (const c of node.children) {
      if (c.type !== 'dir') continue;
      const subdirs = c.children.filter((k) => k.type === 'dir').length;
      if (c.fileCount === 1 && subdirs === 0) lonelyFolders.push(c.path);
      walk(c);
    }
  })(tree);

  // Couplage entre dossiers (niveau 2) : quels dossiers dépendent le plus les uns des autres ?
  const folderOf = (p) => {
    const d = dirname(p).split('/').filter(Boolean);
    return d.slice(0, 2).join('/') || '(racine)';
  };
  const coupling = new Map();
  for (const e of deps.edges) {
    const a = folderOf(e.source), b = folderOf(e.target);
    if (a === b) continue;
    const k = a + ' → ' + b;
    coupling.set(k, (coupling.get(k) || 0) + 1);
  }
  const mutualCoupling = [];
  for (const [k, n] of coupling) {
    const [a, b] = k.split(' → ');
    const back = coupling.get(b + ' → ' + a);
    if (back && a < b) mutualCoupling.push({ a, b, ab: n, ba: back });
  }

  return {
    orphans,
    cycles: deps.cycles,
    duplicateFiles,
    sameNames,
    largeFiles,
    hubs,
    deepFiles,
    lonelyFolders,
    mutualCoupling: mutualCoupling.sort((x, y) => y.ab + y.ba - x.ab - x.ba),
  };
}

/**
 * Analyse complète. `entries` : [{ path, size, content }] (content = null pour les binaires).
 */
export function analyzeProject(entries, { name = 'projet' } = {}) {
  const files = entries
    .map((e) => ({
      path: e.path,
      name: basename(e.path),
      ext: extname(e.path),
      size: e.size ?? (e.content ? e.content.length : 0),
      content: e.content ?? null,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const f of files) {
    f.lines = f.content != null ? countLines(f.content) : 0;
    f.hash = f.content != null ? hashString(f.content) : null;
  }
  const i18n = analyzeTranslations(files); // marque f.isTranslation avant le graphe
  const deps = buildDependencyGraph(files);
  const tree = buildTree(files);
  const insights = computeInsights(files, deps, tree);
  return { name, files, byPath: new Map(files.map((f) => [f.path, f])), tree, deps, i18n, insights };
}

export function analyzeTranslationDuplicates(project, opts = DEFAULT_DUP_OPTIONS) {
  return findDuplicates(project.i18n.translations, opts);
}

export function analyzeHardcoded(project, opts = DEFAULT_DUP_OPTIONS) {
  return findHardcodedTexts(project.i18n.usage, project.i18n.translations, opts);
}
