import React, { useEffect, useRef, useState, useCallback } from 'react';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { api } from '../../api/client.js';

cytoscape.use(fcose);

export const NOTEBOOK_PALETTE = [
  '#7c6af7', // indigo
  '#f7936a', // amber
  '#6af7a2', // mint
  '#f76a7c', // rose
  '#6ac8f7', // sky
  '#c8f76a', // lime
  '#d46af7', // violet
  '#f7d46a', // gold
];

export const COLOR_UNORGANIZED = '#4a4a5e';

// Returns {
//   nodeColors:      { notePath: hex },
//   notebookToNodes: { [notebookId]: Set(notePath) },
//   legend:          [{ id, name, color }],
// }
export async function buildNotebookColorMap() {
  try {
    const { notebooks } = await api.get('/api/notebooks/all-with-notes');
    const nodeColors = {};
    const notebookToNodes = {};
    const legend = [];
    notebooks.forEach((nb, i) => {
      const color = NOTEBOOK_PALETTE[i % NOTEBOOK_PALETTE.length];
      // paths may be plain strings or {path, updated} objects — normalize.
      const norm = p => (typeof p === 'object' ? p.path : p);
      const paths = new Set((nb.paths ?? []).map(norm));
      if (nb.id != null) notebookToNodes[nb.id] = paths;
      legend.push({ id: nb.id, name: nb.name, color });
      (nb.paths ?? []).forEach(p => { const path = norm(p); if (!nodeColors[path]) nodeColors[path] = color; });
    });
    return { nodeColors, notebookToNodes, legend };
  } catch {
    return { nodeColors: {}, notebookToNodes: {}, legend: [] };
  }
}

// Hide the notes belonging to the notebook ids in `hiddenIds`, plus any edge
// touching a hidden note (so no half-edge dangles). Membership is resolved via
// `notebookToNodes` (from /api/notebooks/all-with-notes) because node data
// carries no per-node notebook for the user's own notes. `hiddenIds` is a Set
// (or iterable); empty → everything visible.
//
// Uses the `.nb-hidden` style class (display:none CSS) rather than element
// `.hidden()` because fcose with `tile:true` does not reliably repaint the
// canvas for `.hidden()` mutations; the CSS route always does.
export function applyVisibility(cy, notebookToNodes, hiddenIds) {
  if (!cy) return;
  const hiddenIdsSet = new Set([...(hiddenIds || [])].map(String));
  const hiddenPaths = new Set();
  for (const [nbId, paths] of Object.entries(notebookToNodes || {})) {
    if (hiddenIdsSet.has(nbId)) for (const p of paths) hiddenPaths.add(p);
  }
  cy.nodes().forEach(n => n.toggleClass('nb-hidden', hiddenPaths.has(n.id())));
  cy.edges().forEach(e => e.toggleClass('nb-hidden',
    e.source().hasClass('nb-hidden') || e.target().hasClass('nb-hidden')));
}

export function applyColors(cy, nodeColors) {
  if (!cy) return;
  cy.nodes().forEach(node => {
    node.style('background-color', nodeColors[node.id()] ?? COLOR_UNORGANIZED);
  });
}

export default function GraphView({ onSelectNote, activePath, notebookColorKey, isMobile }) {
  const containerRef     = useRef(null);
  const cyRef            = useRef(null);
  const activePathRef    = useRef(activePath);
  const onSelectNoteRef  = useRef(onSelectNote);
  const [status, setStatus]           = useState('loading');
  const [graphReady, setGraphReady]   = useState(false);
  const [legend, setLegend]           = useState([]);
  const [hasUnorganized, setHasUnorganized] = useState(false);
  const [hiddenNotebooks, setHiddenNotebooks] = useState(() => new Set());
  const [notebookToNodes, setNotebookToNodes] = useState({});
  const hiddenRef = useRef(hiddenNotebooks);
  useEffect(() => { hiddenRef.current = hiddenNotebooks; }, [hiddenNotebooks]);

  useEffect(() => { onSelectNoteRef.current = onSelectNote; });

  // Keep ref in sync so the async graph-build callback reads the latest value
  useEffect(() => { activePathRef.current = activePath; }, [activePath]);

  // Build graph once on mount
  useEffect(() => {
    const mobile = isMobile; // capture at mount; graph isn't rebuilt on resize
    api.get('/api/notes/graph').then(async ({ nodes, edges }) => {
      if (!nodes.length) { setStatus('empty'); return; }

      const degree = {};
      nodes.forEach(n => { degree[n.path] = 0; });
      edges.forEach(e => {
        const target = nodes.find(n => n.title === e.target_title);
        if (!target) return;
        degree[e.source_path] = (degree[e.source_path] ?? 0) + 1;
        degree[target.path]   = (degree[target.path]   ?? 0) + 1;
      });

      const elements = [
        ...nodes.map(n => ({
          data: {
            id: n.path,
            label: n.title,
            size: Math.max(16 + Math.min((degree[n.path] ?? 0) * 4, 24), mobile ? 24 : 0),
            notebookId: n.notebookId ?? null,
          },
        })),
        ...edges.map((e, i) => {
          const target = nodes.find(n => n.title === e.target_title);
          if (!target) return null;
          return { data: { id: `e${i}`, source: e.source_path, target: target.path, label: e.label ?? '' } };
        }).filter(Boolean),
      ];

      cyRef.current = cytoscape({
        container: containerRef.current,
        elements,
        style: [
          {
            selector: 'node',
            style: {
              'background-color': COLOR_UNORGANIZED,
              'label': 'data(label)',
              'color': '#d4d4d4',
              'font-size': '11px',
              'font-weight': 500,
              'text-valign': 'bottom',
              'text-halign': 'center',
              'text-margin-y': 6,
              'text-opacity': 1,
              'text-background-color': '#1a1a2e',
              'text-background-opacity': 0.8,
              'text-background-padding': '3px',
              'text-border-opacity': 0,
              'width': 'data(size)',
              'height': 'data(size)',
            },
          },
          {
            selector: 'node.nb-hidden',
            style: { 'display': 'none' },
          },
          {
            selector: 'edge.nb-hidden',
            style: { 'display': 'none', 'opacity': 0 },
          },
          {
            selector: 'node.hovered',
            style: {
              'border-width': 2,
              'border-color': '#7c6af7',
            },
          },
          {
            selector: 'node:selected',
            style: {
              'border-width': 3,
              'border-color': '#fff',
              'color': '#fff',
            },
          },
          {
            selector: 'edge',
            style: {
              'width': 1,
              'line-color': '#3a3a3a',
              'target-arrow-color': '#555',
              'target-arrow-shape': 'triangle',
              'curve-style': 'bezier',
              'arrow-scale': 0.8,
              'label': 'data(label)',
              'font-size': '9px',
              'color': '#aaa',
              'text-rotation': 'autorotate',
              'text-background-color': '#1e1e1e',
              'text-background-opacity': 1,
              'text-background-padding': '2px',
            },
          },
          {
            selector: 'edge.highlighted',
            style: { 'line-color': '#7c6af7', 'target-arrow-color': '#7c6af7', 'width': 2, 'color': '#9d8fff' },
          },
        ],
        layout: {
          name: 'fcose',
          animate: false,
          quality: 'proof',
          nodeSeparation: 120,
          idealEdgeLength: 150,
          nodeRepulsion: 12000,
          edgeElasticity: 0.45,
          numIter: 2500,
          tile: true,
          tilingPaddingVertical: 20,
          tilingPaddingHorizontal: 20,
        },
      });

      setGraphReady(true);
      setStatus('ready');

      const { nodeColors, notebookToNodes: nbMap, legend: nb } = await buildNotebookColorMap();
      applyColors(cyRef.current, nodeColors);
      setLegend(nb);
      setNotebookToNodes(nbMap);
      let unorg = false;
      cyRef.current.nodes().forEach(n => { if (!nodeColors[n.id()]) unorg = true; });
      setHasUnorganized(unorg);
      applyVisibility(cyRef.current, nbMap, hiddenRef.current);
    }).catch(() => setStatus('empty'));

    return () => cyRef.current?.destroy();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Rebind label-reveal and navigation events whenever isMobile changes
  useEffect(() => {
    if (!graphReady || !cyRef.current) return;
    const cy = cyRef.current;

    cy.off('mouseover', 'node');
    cy.off('mouseout', 'node');
    cy.off('mousedown');
    cy.off('mouseup', 'node');
    cy.off('tap', 'node');

    if (isMobile) {
      cy.on('tap', 'node', e => {
        onSelectNoteRef.current(e.target.id(), e.target.data('notebookId'));
      });
    } else {
      let hoveredNodeId = null;
      cy.on('mouseover', 'node', e => {
        hoveredNodeId = e.target.id();
        e.target.addClass('hovered');
        e.target.connectedEdges().addClass('highlighted');
      });
      cy.on('mouseout', 'node', e => {
        hoveredNodeId = null;
        e.target.removeClass('hovered');
        e.target.connectedEdges().removeClass('highlighted');
      });
      // Use native DOM events on the container — Cytoscape's forwarded mouseup
      // on nodes is unreliable; mouseover (which works) tracks the hovered node.
      const container = cy.container();
      let downPos = null;
      const onDown = e => { downPos = { x: e.clientX, y: e.clientY }; };
      const onUp = e => {
        const start = downPos;
        downPos = null;
        if (!start || !hoveredNodeId) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (dx * dx + dy * dy <= 225) {
          const notebookId = cy.getElementById(hoveredNodeId).data('notebookId') ?? null;
          onSelectNoteRef.current(hoveredNodeId, notebookId);
        }
      };
      container.addEventListener('mousedown', onDown);
      container.addEventListener('mouseup', onUp);
      return () => {
        container.removeEventListener('mousedown', onDown);
        container.removeEventListener('mouseup', onUp);
      };
    }
  }, [graphReady, isMobile]);

  // Re-colour when notebook membership changes. Clear any hide filters first —
  // the notebook set just changed, so previously hidden ids may no longer exist.
  useEffect(() => {
    if (!cyRef.current) return;
    buildNotebookColorMap().then(({ nodeColors, notebookToNodes: nbMap, legend: nb }) => {
      applyColors(cyRef.current, nodeColors);
      setLegend(nb);
      setNotebookToNodes(nbMap);
      let unorg = false;
      cyRef.current.nodes().forEach(n => { if (!nodeColors[n.id()]) unorg = true; });
      setHasUnorganized(unorg);
      setHiddenNotebooks(new Set());
      applyVisibility(cyRef.current, nbMap, new Set());
    });
  }, [notebookColorKey]);

  // Apply show/hide whenever the selection or membership map changes.
  useEffect(() => {
    if (!graphReady || !cyRef.current) return;
    applyVisibility(cyRef.current, notebookToNodes, hiddenNotebooks);
  }, [graphReady, hiddenNotebooks, notebookToNodes]);

  function toggleNotebook(id) {
    if (id == null) return;
    setHiddenNotebooks(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function fitGraph() {
    cyRef.current?.fit(undefined, 40);
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: 'var(--bg)' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', touchAction: 'none' }} />

      {status === 'loading' && (
        <div style={overlay}>Loading graph…</div>
      )}
      {status === 'empty' && (
        <div style={overlay}>No notes with links yet. Add [[wikilinks]] between notes to see connections.</div>
      )}
      {status === 'ready' && (
        <button
          onClick={fitGraph}
          style={{ position: 'absolute', bottom: 16, right: 16, padding: '6px 12px', fontSize: 12, minHeight: 44 }}
        >
          Fit
        </button>
      )}

      {status === 'ready' && (legend.length > 0 || hasUnorganized) && (
        <div style={{
          position: 'absolute', bottom: 16, left: 16,
          background: 'rgba(18,18,28,0.88)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '8px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          maxHeight: 220,
          overflowY: 'auto',
          backdropFilter: 'blur(4px)',
          fontSize: isMobile ? 13 : 11,
        }}>
          {legend.map(({ id, name, color }) => {
            const hidden = id != null && hiddenNotebooks.has(id);
            return (
              <button
                key={id ?? name}
                type="button"
                role="checkbox"
                aria-checked={!hidden}
                title={hidden ? `Show notes in ${name}` : `Hide notes in ${name}`}
                onClick={() => toggleNotebook(id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  background: 'none', border: 'none', padding: '1px 2px', cursor: 'pointer',
                  opacity: hidden ? 0.45 : 1, width: '100%', textAlign: 'left',
                }}
              >
                <span aria-hidden style={{
                  width: 13, height: 13, borderRadius: 3, flexShrink: 0,
                  border: `1.5px solid ${color}`,
                  background: hidden ? 'transparent' : color,
                  boxSizing: 'border-box',
                  color: '#1a1a2e', fontSize: 10, lineHeight: '11px', textAlign: 'center',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {!hidden && '✓'}
                </span>
                <span style={{ color: 'var(--text)', whiteSpace: 'nowrap', textDecoration: hidden ? 'line-through' : 'none' }}>{name}</span>
              </button>
            );
          })}
          {hasUnorganized && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: COLOR_UNORGANIZED, flexShrink: 0 }} />
              <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Unorganized</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const overlay = {
  position: 'absolute', inset: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: 'var(--text-muted)', fontSize: 13, pointerEvents: 'none',
};
