// Extraction des imports et construction du graphe de dépendances entre fichiers.
import { dirname, basename, joinPath, normalizePath, parseLooseJson } from './utils.js';

export const JS_LIKE = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro']);
export const STYLE_EXTS = new Set(['css', 'scss', 'sass', 'less']);
export const CODE_EXTS = new Set([...JS_LIKE, ...STYLE_EXTS, 'html', 'htm', 'dart', 'py', 'php']);

const JS_RESOLVE_EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro', 'json', 'd.ts'];
const STYLE_RESOLVE_EXTS = ['scss', 'sass', 'css', 'less'];

/** Supprime les commentaires JS/CSS (approximation suffisante pour repérer les imports). */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\/])\/\/[^\n]*/g, '$1');
}

function pushUnique(arr, v) {
  if (v && !arr.includes(v)) arr.push(v);
}

function extractStyleImports(src, out) {
  const re = /@(?:import|use|forward)\s+(?:url\(\s*)?['"]?([^'")\s;]+)['"]?/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (/^(https?:)?\/\//.test(spec) || spec.startsWith('sass:')) continue;
    pushUnique(out, spec);
  }
}

function extractJsImports(src, out) {
  const patterns = [
    /(?:^|[;\s}])(?:import|export)\s+(?:type\s+)?(?:[^'"`;()]*?\s+from\s*)?['"]([^'"\n]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*[,)]/g,
    // Angular : templateUrl / styleUrls / styleUrl
    /\b(?:templateUrl|styleUrl)\s*:\s*['"]([^'"\n]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) pushUnique(out, m[1]);
  }
  const styles = /\bstyleUrls\s*:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = styles.exec(src))) {
    for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) pushUnique(out, s[1]);
  }
}

/** Retourne la liste des "spécificateurs" importés par un fichier. */
export function extractImports(content, ext) {
  const out = [];
  if (!content) return out;
  if (JS_LIKE.has(ext)) {
    const src = stripComments(content);
    extractJsImports(src, out);
    if (ext === 'vue' || ext === 'svelte' || ext === 'astro') extractStyleImports(src, out);
  } else if (STYLE_EXTS.has(ext)) {
    extractStyleImports(stripComments(content), out);
  } else if (ext === 'html' || ext === 'htm') {
    const re = /<(?:script|img|source)[^>]*\ssrc=["']([^"']+)["']|<link[^>]*\shref=["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(content))) {
      const spec = m[1] || m[2];
      if (/^([a-z]+:)?\/\//i.test(spec) || spec.startsWith('data:') || spec.startsWith('#')) continue;
      pushUnique(out, spec);
    }
  } else if (ext === 'dart') {
    const re = /^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/gm;
    let m;
    while ((m = re.exec(content))) pushUnique(out, m[1]);
  } else if (ext === 'py') {
    let m;
    const fromRe = /^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\s+\(?([\w\s,*]+)/gm;
    while ((m = fromRe.exec(content))) {
      const base = m[1];
      pushUnique(out, 'py:' + base);
      if (/^\.+$/.test(base)) {
        // "from . import a, b" -> modules a et b relatifs
        for (const name of m[2].split(',').map((s) => s.trim().split(/\s+/)[0]).filter((s) => s && s !== '*')) {
          pushUnique(out, 'py:' + base + name);
        }
      }
    }
    const importRe = /^\s*import\s+([\w., ]+)/gm;
    while ((m = importRe.exec(content))) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+/)[0];
        if (name) pushUnique(out, 'py:' + name);
      }
    }
  } else if (ext === 'php') {
    const re = /\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(content))) pushUnique(out, m[1].replace(/^\//, './'));
  }
  return out;
}

/** Récupère les alias (tsconfig/jsconfig paths, baseUrl, vite) et les paquets Dart du projet. */
export function detectProjectConfig(files) {
  const aliases = []; // { dir, prefix, exact, targets: [] }
  const baseUrls = []; // { dir, base }
  const dartPackages = new Map(); // nom -> dossier
  const byPath = new Map(files.map((f) => [f.path, f]));

  for (const f of files) {
    const name = basename(f.path);
    if (f.content == null) continue;
    if (/^(tsconfig|jsconfig)(\.[\w-]+)?\.json$/.test(name)) {
      let cfg;
      try { cfg = parseLooseJson(f.content); } catch { continue; }
      const configDir = dirname(f.path);
      // Résout un éventuel "extends" local pour récupérer baseUrl/paths.
      let co = cfg.compilerOptions || {};
      if (!co.paths && typeof cfg.extends === 'string' && cfg.extends.startsWith('.')) {
        const parentPath = joinPath(configDir, cfg.extends.endsWith('.json') ? cfg.extends : cfg.extends + '.json');
        const parent = parentPath && byPath.get(parentPath);
        if (parent?.content) {
          try { co = { ...(parseLooseJson(parent.content).compilerOptions || {}), ...co }; } catch { /* ignore */ }
        }
      }
      const baseDir = joinPath(configDir, co.baseUrl || '.') ?? configDir;
      if (co.baseUrl) baseUrls.push({ dir: configDir, base: baseDir });
      for (const [key, targets] of Object.entries(co.paths || {})) {
        if (!Array.isArray(targets)) continue;
        const wildcard = key.endsWith('*');
        aliases.push({
          dir: configDir,
          prefix: wildcard ? key.slice(0, -1) : key,
          exact: !wildcard,
          targets: targets.map((t) => joinPath(baseDir, t.replace(/\*$/, '')) ?? ''),
        });
      }
    } else if (/^vite\.config\.[mc]?[jt]s$|^vue\.config\.js$|^webpack\.config\.[jt]s$|^nuxt\.config\.[jt]s$/.test(name)) {
      const configDir = dirname(f.path);
      const re = /['"]?([@~#$][\w/-]*)['"]?\s*:\s*(?:path\.)?(?:resolve|join)?\(?\s*(?:__dirname\s*,\s*|fileURLToPath\(new URL\()?['"]\.?\/?([\w./-]+)['"]/g;
      let m;
      while ((m = re.exec(f.content))) {
        aliases.push({ dir: configDir, prefix: m[1].endsWith('/') ? m[1] : m[1] + '/', exact: false, targets: [joinPath(configDir, m[2]) ?? ''] });
        aliases.push({ dir: configDir, prefix: m[1], exact: true, targets: [joinPath(configDir, m[2]) ?? ''] });
      }
    } else if (name === 'pubspec.yaml') {
      const m = /^name:\s*([\w-]+)/m.exec(f.content);
      if (m) dartPackages.set(m[1], dirname(f.path));
    }
  }
  // Alias conventionnels "@/..." et "~/..." -> src/ si aucun alias ne les définit.
  const hasSrc = files.some((f) => f.path.startsWith('src/'));
  if (hasSrc) {
    for (const prefix of ['@/', '~/']) {
      if (!aliases.some((a) => a.prefix === prefix)) aliases.push({ dir: '', prefix, exact: false, targets: ['src'], implicit: true });
    }
  }
  // Les alias les plus spécifiques d'abord.
  aliases.sort((a, b) => b.dir.length - a.dir.length || b.prefix.length - a.prefix.length);
  baseUrls.sort((a, b) => b.dir.length - a.dir.length);
  return { aliases, baseUrls, dartPackages };
}

function isInside(path, dir) {
  return !dir || path === dir || path.startsWith(dir + '/');
}

export function packageName(spec) {
  if (spec.startsWith('node:')) return spec;
  const parts = spec.split('/');
  return spec.startsWith('@') && parts.length > 1 ? parts[0] + '/' + parts[1] : parts[0];
}

export function createResolver(files, config = detectProjectConfig(files)) {
  const fileSet = new Set(files.map((f) => f.path));
  const dirSet = new Set();
  for (const f of files) {
    let d = dirname(f.path);
    while (d && !dirSet.has(d)) { dirSet.add(d); d = dirname(d); }
  }

  function tryCandidates(base, exts) {
    if (base == null) return null;
    if (fileSet.has(base)) return base;
    for (const e of exts) if (fileSet.has(base + '.' + e)) return base + '.' + e;
    // import "./x.js" qui pointe en réalité vers x.ts (ESM + TypeScript)
    const m = /^(.*)\.(m|c)?js$/.exec(base);
    if (m) for (const e of ['ts', 'tsx', 'mts', 'cts']) if (fileSet.has(m[1] + '.' + e)) return m[1] + '.' + e;
    if (dirSet.has(base)) {
      for (const e of exts) if (fileSet.has(base + '/index.' + e)) return base + '/index.' + e;
    }
    return null;
  }

  function tryStyle(base) {
    if (base == null) return null;
    const hit = tryCandidates(base, STYLE_RESOLVE_EXTS);
    if (hit) return hit;
    const d = dirname(base), b = basename(base);
    const partial = joinPath(d, '_' + b);
    return tryCandidates(partial, STYLE_RESOLVE_EXTS) || (dirSet.has(base) ? tryCandidates(base + '/_index', STYLE_RESOLVE_EXTS) : null);
  }

  function resolvePython(spec, from) {
    const m = /^(\.*)([\w.]*)$/.exec(spec);
    if (!m) return { unresolved: spec };
    const dots = m[1].length;
    const rel = m[2].replace(/\./g, '/');
    const bases = [];
    if (dots) {
      let d = dirname(from);
      for (let i = 1; i < dots; i++) d = dirname(d);
      bases.push(d);
    } else {
      bases.push('', 'src', 'app');
      let d = dirname(from);
      while (d) { bases.push(d); d = dirname(d); }
    }
    for (const b of bases) {
      const p = joinPath(b, rel);
      if (p == null) continue;
      if (rel && fileSet.has(p + '.py')) return { path: p + '.py' };
      if (fileSet.has(joinPath(p, '__init__.py'))) return { path: joinPath(p, '__init__.py') };
    }
    if (dots) return { unresolved: spec };
    return { external: rel.split('/')[0] };
  }

  return function resolve(rawSpec, from, ext) {
    let spec = rawSpec.split('?')[0].split('#')[0];
    if (!spec) return { unresolved: rawSpec };
    if (spec.startsWith('py:')) return resolvePython(spec.slice(3), from);
    const isStyle = STYLE_EXTS.has(ext);
    const attempt = (p) => (isStyle ? tryStyle(p) : tryCandidates(p, JS_RESOLVE_EXTS)) || (isStyle ? null : tryStyle(p));
    const fromDir = dirname(from);

    if (ext === 'dart') {
      if (spec.startsWith('dart:')) return { external: spec };
      const pm = /^package:([\w-]+)\/(.*)$/.exec(spec);
      if (pm) {
        const dir = config.dartPackages.get(pm[1]);
        if (dir == null) return { external: pm[1] };
        const p = joinPath(dir, 'lib', pm[2]);
        return p && fileSet.has(p) ? { path: p } : { unresolved: spec };
      }
    }
    if (spec.startsWith('~') && isStyle && !spec.startsWith('~/')) spec = spec.slice(1); // ~bootstrap/scss
    if (spec.startsWith('.') || ((ext === 'html' || ext === 'htm' || ext === 'php' || ext === 'dart') && !spec.startsWith('/'))) {
      const hit = attempt(joinPath(fromDir, spec));
      return hit ? { path: hit } : { unresolved: spec };
    }
    if (spec.startsWith('/')) {
      const p = normalizePath(spec);
      const hit = attempt(p) || attempt(joinPath('public', p)) || attempt(joinPath('src', p));
      return hit ? { path: hit } : { unresolved: spec };
    }
    for (const a of config.aliases) {
      if (!isInside(from, a.dir)) continue;
      const matches = a.exact ? spec === a.prefix : spec.startsWith(a.prefix);
      if (!matches) continue;
      const rest = a.exact ? '' : spec.slice(a.prefix.length);
      for (const t of a.targets) {
        const hit = attempt(joinPath(t, rest));
        if (hit) return { path: hit };
      }
      if (!a.implicit) return { unresolved: spec };
    }
    for (const b of config.baseUrls) {
      if (!isInside(from, b.dir)) continue;
      const hit = attempt(joinPath(b.base, spec));
      if (hit) return { path: hit };
    }
    if (isStyle) {
      const hit = attempt(joinPath(fromDir, spec)) || attempt(spec);
      if (hit) return { path: hit };
    }
    return { external: packageName(spec) };
  };
}

/** Composantes fortement connexes (Tarjan itératif) -> cycles de dépendances. */
export function findCycles(nodes, adjacency) {
  let index = 0;
  const idx = new Map(), low = new Map(), onStack = new Set(), stack = [], result = [];
  for (const start of nodes) {
    if (idx.has(start)) continue;
    const work = [[start, 0]];
    idx.set(start, index); low.set(start, index); index++;
    stack.push(start); onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      const nexts = adjacency.get(v) || [];
      if (i < nexts.length) {
        frame[1]++;
        const w = nexts[i];
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++;
          stack.push(w); onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), idx.get(w)));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
        if (low.get(v) === idx.get(v)) {
          const comp = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
          if (comp.length > 1) result.push(comp.reverse());
        }
      }
    }
  }
  return result.sort((a, b) => a.length - b.length);
}

/**
 * Construit le graphe : ajoute sur chaque fichier `imports`, `importedBy`,
 * `externalDeps` et `unresolved`, et retourne une synthèse.
 */
export function buildDependencyGraph(files) {
  const config = detectProjectConfig(files);
  const resolve = createResolver(files, config);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const edges = [];
  const externals = new Map();
  let unresolvedCount = 0;

  for (const f of files) {
    f.imports = []; f.importedBy = []; f.externalDeps = []; f.unresolved = [];
  }
  for (const f of files) {
    if (!CODE_EXTS.has(f.ext) || f.content == null) continue;
    for (const spec of extractImports(f.content, f.ext)) {
      const r = resolve(spec, f.path, f.ext);
      if (r.path) {
        if (r.path !== f.path && !f.imports.includes(r.path)) {
          f.imports.push(r.path);
          edges.push({ source: f.path, target: r.path });
        }
      } else if (r.external) {
        pushUnique(f.externalDeps, r.external);
        if (!externals.has(r.external)) externals.set(r.external, new Set());
        externals.get(r.external).add(f.path);
      } else {
        f.unresolved.push(r.unresolved);
        unresolvedCount++;
      }
    }
  }
  for (const e of edges) byPath.get(e.target)?.importedBy.push(e.source);

  const adjacency = new Map(files.map((f) => [f.path, f.imports]));
  const cycles = findCycles(files.map((f) => f.path), adjacency);

  return {
    edges,
    cycles,
    config,
    unresolvedCount,
    externals: [...externals.entries()]
      .map(([name, set]) => ({ name, count: set.size, files: [...set].sort() }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}
