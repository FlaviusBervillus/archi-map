// Graphe de dépendances interactif (D3 force layout), par fichier ou par dossier.
/* global d3 */
import { dirname, basename } from './utils.js';
import { STYLE_EXTS } from './deps.js';

export function groupOf(path) {
  const parts = dirname(path).split('/').filter(Boolean);
  if (!parts.length) return '(racine)';
  const skip = ['src', 'lib', 'app'].includes(parts[0]) && parts.length > 1 ? 1 : 0;
  return parts.slice(0, skip + 1).join('/');
}

function folderAtDepth(path, depth) {
  const parts = dirname(path).split('/').filter(Boolean);
  return parts.slice(0, depth).join('/') || '(racine)';
}

/** Construit les nœuds/liens selon les options. */
export function buildGraphData(project, opts) {
  const cycleSet = new Set(project.insights.cycles.flat());
  const cycleEdges = new Set();
  for (const comp of project.insights.cycles) {
    const set = new Set(comp);
    for (const p of comp) for (const t of project.byPath.get(p).imports) if (set.has(t)) cycleEdges.add(p + '→' + t);
  }
  const keep = (f) =>
    (opts.styles || !STYLE_EXTS.has(f.ext)) &&
    (opts.translations || !f.isTranslation) &&
    (!opts.scope || f.path === opts.scope || f.path.startsWith(opts.scope + '/'));
  const linked = project.files.filter((f) => keep(f) && (f.imports.length || f.importedBy.length || !opts.hideIsolated));
  const candidates = linked.filter((f) => f.imports.length || f.importedBy.length || ['js', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'dart', 'py', 'mjs'].includes(f.ext));

  if (opts.mode === 'folders') {
    const nodes = new Map();
    const links = new Map();
    for (const f of candidates) {
      const id = folderAtDepth(f.path, opts.depth);
      if (!nodes.has(id)) nodes.set(id, { id, label: id.split('/').pop() || id, group: groupOf(id + '/x'), files: 0, inDeg: 0, kind: 'folder' });
      nodes.get(id).files++;
    }
    for (const f of candidates) {
      const a = folderAtDepth(f.path, opts.depth);
      for (const t of f.imports) {
        const tf = project.byPath.get(t);
        if (!tf || !keep(tf) || !nodes.has(folderAtDepth(t, opts.depth))) continue;
        const b = folderAtDepth(t, opts.depth);
        if (a === b) continue;
        const k = a + '→' + b;
        if (!links.has(k)) links.set(k, { source: a, target: b, weight: 0, cycle: false });
        links.get(k).weight++;
      }
    }
    for (const l of links.values()) {
      nodes.get(l.target).inDeg += l.weight;
      if (links.has(l.target + '→' + l.source)) l.cycle = true;
    }
    return { nodes: [...nodes.values()], links: [...links.values()] };
  }

  const ids = new Set(candidates.map((f) => f.path));
  const nodes = candidates.map((f) => ({
    id: f.path,
    label: basename(f.path),
    group: groupOf(f.path),
    inDeg: f.importedBy.filter((p) => ids.has(p)).length,
    kind: 'file',
    cycle: cycleSet.has(f.path),
    orphan: !f.importedBy.length,
  }));
  const links = [];
  for (const f of candidates) for (const t of f.imports) if (ids.has(t)) links.push({ source: f.path, target: t, weight: 1, cycle: cycleEdges.has(f.path + '→' + t) });
  return { nodes, links };
}

export function renderGraph(container, project, opts, onSelect) {
  container.innerHTML = '';
  if (typeof d3 === 'undefined') {
    container.innerHTML = '<p class="empty">La librairie D3 n\'a pas pu être chargée (connexion internet requise pour le graphe).</p>';
    return { focus() {}, destroy() {} };
  }
  const data = buildGraphData(project, opts);
  if (!data.nodes.length) {
    container.innerHTML = '<p class="empty">Aucun lien trouvé avec ces filtres.</p>';
    return { focus() {}, destroy() {}, data };
  }
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 600;
  const groups = [...new Set(data.nodes.map((n) => n.group))].sort();
  const palette = ['#4c6ef5', '#12b886', '#f59f00', '#e64980', '#7950f2', '#15aabf', '#fa5252', '#82c91e', '#fd7e14', '#be4bdb', '#228be6', '#40c057', '#868e96'];
  const color = (g) => palette[groups.indexOf(g) % palette.length];
  const radius = (n) => (n.kind === 'folder' ? 6 + Math.sqrt(n.files) * 2.2 : 4 + Math.sqrt(n.inDeg) * 2.4);

  const svg = d3.select(container).append('svg').attr('viewBox', [0, 0, width, height]).attr('class', 'graph-svg');
  const defs = svg.append('defs');
  for (const [id, cls] of [['arrow', 'arrow'], ['arrow-cycle', 'arrow cycle'], ['arrow-hl', 'arrow hl']]) {
    defs.append('marker').attr('id', id).attr('viewBox', '0 -4 8 8').attr('refX', 8).attr('markerUnits', 'userSpaceOnUse').attr('markerWidth', 8).attr('markerHeight', 8).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L8,0L0,4').attr('class', cls);
  }
  const root = svg.append('g');
  const zoom = d3.zoom().scaleExtent([0.1, 6]).on('zoom', (e) => root.attr('transform', e.transform));
  svg.call(zoom).on('dblclick.zoom', null);

  const link = root.append('g').attr('class', 'links').selectAll('line').data(data.links).join('line')
    .attr('class', (d) => 'link' + (d.cycle ? ' cycle' : ''))
    .attr('stroke-width', (d) => Math.min(1 + Math.log2(d.weight), 6))
    .attr('marker-end', (d) => (d.cycle ? 'url(#arrow-cycle)' : 'url(#arrow)'));

  const node = root.append('g').attr('class', 'nodes').selectAll('g').data(data.nodes).join('g').attr('class', (d) => 'node' + (d.cycle ? ' cycle' : '') + (d.orphan ? ' orphan' : ''));
  node.append('circle').attr('r', radius).attr('fill', (d) => color(d.group));
  node.append('text').attr('dx', (d) => radius(d) + 3).attr('dy', '0.35em').text((d) => d.label);
  node.append('title').text((d) => (d.kind === 'folder' ? `${d.id} — ${d.files} fichier(s)` : `${d.id}\nutilisé par ${d.inDeg} fichier(s)`));

  const many = data.nodes.length > 300;
  const sim = d3.forceSimulation(data.nodes)
    .force('link', d3.forceLink(data.links).id((d) => d.id).distance(() => (opts.mode === 'folders' ? 110 : 55)).strength(0.4))
    .force('charge', d3.forceManyBody().strength(many ? -40 : opts.mode === 'folders' ? -380 : -160))
    .force('collide', d3.forceCollide().radius((d) => radius(d) + 3))
    .force('x', d3.forceX(width / 2).strength(0.05))
    .force('y', d3.forceY(height / 2).strength(0.05));

  sim.on('tick', () => {
    link.each(function (d) {
      const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
      const len = Math.hypot(dx, dy) || 1;
      const r = radius(d.target) + 2;
      d3.select(this).attr('x1', d.source.x).attr('y1', d.source.y).attr('x2', d.target.x - (dx / len) * r).attr('y2', d.target.y - (dy / len) * r);
    });
    node.attr('transform', (d) => `translate(${d.x},${d.y})`);
  });

  node.call(d3.drag()
    .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
    .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

  let selected = null;
  function highlight(id) {
    selected = id;
    if (!id) {
      node.classed('dim', false).classed('sel', false).classed('nb', false);
      link.classed('dim', false).classed('hl', false).attr('marker-end', (d) => (d.cycle ? 'url(#arrow-cycle)' : 'url(#arrow)'));
      return;
    }
    const nb = new Set([id]);
    data.links.forEach((l) => { if (l.source.id === id) nb.add(l.target.id); if (l.target.id === id) nb.add(l.source.id); });
    node.classed('dim', (d) => !nb.has(d.id)).classed('sel', (d) => d.id === id).classed('nb', (d) => nb.has(d.id) && d.id !== id);
    link.classed('dim', (l) => l.source.id !== id && l.target.id !== id).classed('hl', (l) => l.source.id === id || l.target.id === id)
      .attr('marker-end', (l) => (l.source.id === id || l.target.id === id ? 'url(#arrow-hl)' : l.cycle ? 'url(#arrow-cycle)' : 'url(#arrow)'));
  }
  node.on('click', (e, d) => { e.stopPropagation(); highlight(d.id); onSelect?.(d); });
  svg.on('click', () => { highlight(null); onSelect?.(null); });

  if (opts.search) {
    const q = opts.search.toLowerCase();
    node.classed('match', (d) => d.id.toLowerCase().includes(q));
  }

  return {
    data,
    groups: groups.map((g) => ({ name: g, color: color(g) })),
    focus(id) {
      const n = data.nodes.find((x) => x.id === id);
      if (!n) return false;
      highlight(id);
      const go = () => svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(1.6).translate(-n.x, -n.y));
      if (sim.alpha() > 0.1) setTimeout(go, 900); else go();
      return true;
    },
    resetZoom() { svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity); },
    get selected() { return selected; },
    destroy() { sim.stop(); container.innerHTML = ''; },
  };
}
