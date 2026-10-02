// Petites fonctions utilitaires (chemins, hash, formatage) — sans dépendance au DOM.

export function dirname(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basename(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}

export function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

/** Normalise un chemin relatif ("a/./b/../c" -> "a/c"). Retourne null s'il sort de la racine. */
export function normalizePath(p) {
  const parts = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(s);
  }
  return parts.join('/');
}

export function joinPath(...ps) {
  return normalizePath(ps.filter((x) => x !== undefined && x !== null && x !== '').join('/'));
}

/** Hash FNV-1a 32 bits (suffisant pour repérer les fichiers identiques). */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + ':' + str.length;
}

/** Supprime commentaires et virgules finales d'un JSON "à la tsconfig". */
export function parseLooseJson(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

export function countLines(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function formatBytes(n) {
  if (n < 1024) return n + ' o';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' Ko';
  return (n / 1024 / 1024).toFixed(1) + ' Mo';
}

export function formatNumber(n) {
  return new Intl.NumberFormat('fr-FR').format(n);
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Index des débuts de ligne pour convertir un offset en numéro de ligne. */
export function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

export function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
