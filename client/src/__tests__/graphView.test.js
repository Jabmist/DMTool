import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/client.js', () => ({ api: { get: vi.fn() } }));

import { api } from '../api/client.js';
import { buildNotebookColorMap, applyColors, applyVisibility, NOTEBOOK_PALETTE, COLOR_UNORGANIZED } from '../components/graph/GraphView.jsx';

function makeCy(ids) {
  const nodes = ids.map(id => {
    const styles = {};
    return { id: () => id, style: (k, v) => { styles[k] = v; }, _styles: styles };
  });
  return {
    nodes: () => ({ forEach: fn => nodes.forEach(fn) }),
    _nodes: nodes,
  };
}

// Minimal Cytoscape surface for applyVisibility. The app routes through
// toggleClass('nb-hidden', bool) — track that class.
function makeVisibilityCy() {
  function makeEl() {
    const e = { _classes: new Set() };
    e.toggleClass = function (name, on) { if (on) this._classes.add(name); else this._classes.delete(name); };
    e.hasClass = function (name) { return this._classes.has(name); };
    return e;
  }
  const a = makeEl(); a.id = () => 'a';
  const b = makeEl(); b.id = () => 'b';
  const c = makeEl(); c.id = () => 'c';
  const e1 = makeEl(); e1.source = () => a; e1.target = () => b;
  const e2 = makeEl(); e2.source = () => b; e2.target = () => c;
  return {
    nodes: () => ({ forEach: fn => [a, b, c].forEach(fn) }),
    edges: () => ({ forEach: fn => [e1, e2].forEach(fn) }),
    a, b, c, e1, e2,
  };
}

// Helper: `hidden` on a fake element == hasClass('nb-hidden').
const hidden = (el) => el.hasClass('nb-hidden');

const NB_TO_NODES = { 1: new Set(['a']), 2: new Set(['b', 'c']) };

describe('buildNotebookColorMap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty nodeColors and legend when there are no notebooks', async () => {
    api.get.mockResolvedValueOnce({ notebooks: [] });
    const { nodeColors, legend } = await buildNotebookColorMap();
    expect(nodeColors).toEqual({});
    expect(legend).toEqual([]);
  });

  it('assigns the first palette colour to notes in the first notebook', async () => {
    api.get.mockResolvedValueOnce({ notebooks: [{ id: 1, name: 'Science', paths: ['a.md', 'b.md'] }] });
    const { nodeColors, legend } = await buildNotebookColorMap();
    expect(nodeColors['a.md']).toBe(NOTEBOOK_PALETTE[0]);
    expect(nodeColors['b.md']).toBe(NOTEBOOK_PALETTE[0]);
    expect(legend).toEqual([{ id: 1, name: 'Science', color: NOTEBOOK_PALETTE[0] }]);
  });

  it('returns a notebookToNodes map for toggling visibility', async () => {
    api.get.mockResolvedValueOnce({
      notebooks: [
        { id: 1, name: 'Alpha', paths: ['a.md', 'shared.md'] },
        { id: 2, name: 'Beta',  paths: ['b.md', 'shared.md'] },
      ],
    });
    const { notebookToNodes } = await buildNotebookColorMap();
    expect([...notebookToNodes[1]]).toEqual(['a.md', 'shared.md']);
    expect([...notebookToNodes[2]]).toEqual(['b.md', 'shared.md']);
    expect(Object.keys(notebookToNodes).sort()).toEqual(['1', '2']);
  });

  it('assigns different colours to different notebooks', async () => {
    api.get.mockResolvedValueOnce({
      notebooks: [
        { id: 1, name: 'Alpha', paths: ['a.md'] },
        { id: 2, name: 'Beta',  paths: ['b.md'] },
      ],
    });
    const { nodeColors, legend } = await buildNotebookColorMap();
    expect(nodeColors['a.md']).toBe(NOTEBOOK_PALETTE[0]);
    expect(nodeColors['b.md']).toBe(NOTEBOOK_PALETTE[1]);
    expect(legend[0]).toEqual({ id: 1, name: 'Alpha', color: NOTEBOOK_PALETTE[0] });
    expect(legend[1]).toEqual({ id: 2, name: 'Beta',  color: NOTEBOOK_PALETTE[1] });
  });

  it('first notebook wins when a note belongs to multiple notebooks', async () => {
    api.get.mockResolvedValueOnce({
      notebooks: [
        { id: 1, name: 'First',  paths: ['shared.md', 'a.md'] },
        { id: 2, name: 'Second', paths: ['shared.md', 'b.md'] },
      ],
    });
    const { nodeColors } = await buildNotebookColorMap();
    expect(nodeColors['shared.md']).toBe(NOTEBOOK_PALETTE[0]);
  });

  it('cycles through the palette when there are more notebooks than colours', async () => {
    const notebooks = NOTEBOOK_PALETTE.map((_, i) => ({ id: i + 1, name: `NB${i}`, paths: [`note${i}.md`] }));
    notebooks.push({ id: 99, name: 'Overflow', paths: ['overflow.md'] });
    api.get.mockResolvedValueOnce({ notebooks });
    const { nodeColors } = await buildNotebookColorMap();
    expect(nodeColors['overflow.md']).toBe(NOTEBOOK_PALETTE[0]);
  });

  it('returns empty nodeColors and legend when the API throws', async () => {
    api.get.mockRejectedValueOnce(new Error('network'));
    const { nodeColors, legend } = await buildNotebookColorMap();
    expect(nodeColors).toEqual({});
    expect(legend).toEqual([]);
  });
});

describe('applyColors', () => {
  it('colours nodes by their notebook colour', () => {
    const cy = makeCy(['a.md', 'b.md', 'c.md']);
    applyColors(cy, { 'a.md': NOTEBOOK_PALETTE[0], 'b.md': NOTEBOOK_PALETTE[1] });
    const byId = Object.fromEntries(cy._nodes.map(n => [n.id(), n._styles['background-color']]));
    expect(byId['a.md']).toBe(NOTEBOOK_PALETTE[0]);
    expect(byId['b.md']).toBe(NOTEBOOK_PALETTE[1]);
    expect(byId['c.md']).toBe(COLOR_UNORGANIZED);
  });

  it('colours all nodes as unorganized when the map is empty', () => {
    const cy = makeCy(['a.md', 'b.md']);
    applyColors(cy, {});
    cy._nodes.forEach(n => expect(n._styles['background-color']).toBe(COLOR_UNORGANIZED));
  });

  it('does nothing when cy is null', () => {
    expect(() => applyColors(null, {})).not.toThrow();
  });
});

describe('applyVisibility', () => {
  it('shows everything when the hidden set is empty/undefined', () => {
    const cy = makeVisibilityCy();
    applyVisibility(cy, NB_TO_NODES, new Set([1]));
    applyVisibility(cy, NB_TO_NODES, new Set()); // reset to visible
    expect([cy.a, cy.b, cy.c].every(n => hidden(n) === false)).toBe(true);
    expect([cy.e1, cy.e2].every(e => hidden(e) === false)).toBe(true);
  });

  it('hides nodes of the selected notebook and edges touching them', () => {
    const cy = makeVisibilityCy();
    applyVisibility(cy, NB_TO_NODES, new Set([1]));
    expect(hidden(cy.a)).toBe(true);   // notebook 1
    expect(hidden(cy.b)).toBe(false);  // notebook 2
    expect(hidden(cy.c)).toBe(false);  // notebook 2
    expect(hidden(cy.e1)).toBe(true);  // touches node a (hidden)
    expect(hidden(cy.e2)).toBe(false); // both endpoints visible
  });

  it('hides crossing edges when either endpoint is hidden', () => {
    const cy = makeVisibilityCy();
    applyVisibility(cy, NB_TO_NODES, new Set([2]));
    expect(hidden(cy.a)).toBe(false); // nb1 visible
    expect(hidden(cy.b)).toBe(true);  // nb2 hidden
    expect(hidden(cy.c)).toBe(true);  // nb2 hidden
    expect(hidden(cy.e1)).toBe(true); // crosses into hidden nb2
    expect(hidden(cy.e2)).toBe(true); // both endpoints hidden
  });

  it('restores visibility for a previously hidden notebook on toggle-off', () => {
    const cy = makeVisibilityCy();
    applyVisibility(cy, NB_TO_NODES, new Set([1]));
    expect(hidden(cy.a)).toBe(true);
    applyVisibility(cy, NB_TO_NODES, new Set()); // toggle nb1 back on
    expect(hidden(cy.a)).toBe(false);
    expect(hidden(cy.e1)).toBe(false);
  });

  it('does not hide nodes not in the membership map', () => {
    const cy = makeVisibilityCy();
    applyVisibility(cy, {}, new Set([1])); // no map → nothing known
    expect([cy.a, cy.b, cy.c].every(n => hidden(n) === false)).toBe(true);
  });

  it('does nothing when cy is null', () => {
    expect(() => applyVisibility(null, NB_TO_NODES, new Set([1]))).not.toThrow();
  });
});
