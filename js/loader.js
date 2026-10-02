// Lecture d'un dossier local dans le navigateur (sélecteur, <input webkitdirectory>, glisser-déposer).
// Rien n'est envoyé sur un serveur : tout reste dans la page.
import { extname } from './utils.js';
import { shouldIgnore, TEXT_EXTS, MAX_TEXT_SIZE } from './project.js';

async function toEntries(items, ignores, onProgress) {
  // items : [{ path, file }]
  const kept = items.filter((it) => !shouldIgnore(it.path, ignores));
  const entries = [];
  let done = 0;
  const BATCH = 64;
  for (let i = 0; i < kept.length; i += BATCH) {
    await Promise.all(
      kept.slice(i, i + BATCH).map(async ({ path, file }) => {
        const ext = extname(path);
        let content = null;
        if ((TEXT_EXTS.has(ext) || !ext) && file.size <= MAX_TEXT_SIZE) {
          try { content = await file.text(); } catch { content = null; }
          if (content && content.includes('\u0000')) content = null; // binaire
        }
        entries.push({ path, size: file.size, content });
        done++;
      }),
    );
    onProgress?.(done, kept.length);
  }
  return entries;
}

function stripRoot(paths) {
  const first = paths[0]?.split('/')[0];
  if (first && paths.every((p) => p.startsWith(first + '/'))) return { root: first, strip: first.length + 1 };
  return { root: '', strip: 0 };
}

/** Depuis un <input type="file" webkitdirectory>. */
export async function entriesFromFileList(fileList, ignores, onProgress) {
  const files = [...fileList];
  const rels = files.map((f) => f.webkitRelativePath || f.name);
  const { root, strip } = stripRoot(rels);
  const items = files.map((file, i) => ({ path: rels[i].slice(strip), file }));
  return { name: root || 'projet', entries: await toEntries(items, ignores, onProgress) };
}

/** Depuis window.showDirectoryPicker() (Chrome/Edge). */
export async function entriesFromDirectoryHandle(handle, ignores, onProgress) {
  const items = [];
  async function walk(dir, prefix) {
    for await (const [name, h] of dir.entries()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (ignores.includes(name)) continue;
      if (h.kind === 'directory') await walk(h, path);
      else items.push({ path, file: await h.getFile() });
    }
    onProgress?.(0, items.length, true);
  }
  await walk(handle, '');
  return { name: handle.name, entries: await toEntries(items, ignores, onProgress) };
}

/** Depuis un glisser-déposer de dossier. */
export async function entriesFromDrop(dataTransfer, ignores, onProgress) {
  const roots = [...dataTransfer.items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  const items = [];
  const readAll = (reader) =>
    new Promise((resolve, reject) => {
      const all = [];
      const next = () => reader.readEntries((batch) => (batch.length ? (all.push(...batch), next()) : resolve(all)), reject);
      next();
    });
  const getFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
  async function walk(entry, prefix) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (ignores.includes(entry.name)) return;
    if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) await walk(child, path);
    } else {
      items.push({ path, file: await getFile(entry) });
    }
  }
  for (const r of roots) await walk(r, '');
  const { root, strip } = stripRoot(items.map((i) => i.path));
  for (const it of items) it.path = it.path.slice(strip);
  return { name: root || roots[0]?.name || 'projet', entries: await toEntries(items, ignores, onProgress) };
}
