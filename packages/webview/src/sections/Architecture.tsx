import { useMemo, useState } from 'react';
import type { DependencyEdge, ReviewReport } from '@diffwise/core';
import { Chip, EmptyState, FileRef, SectionHeader } from '../ui';

interface NodePos { id: string; x: number; y: number; depth: number; changed: boolean }

const WIDTH = 980;
const HEIGHT = 620;

function layout(report: ReviewReport): { nodes: NodePos[]; edges: DependencyEdge[] } {
  const g = report.architecture.graph;
  const changed = new Set(g.changedFiles);
  const depthOf = (id: string): number => (changed.has(id) ? 0 : g.impactDepth[id] ?? 3);
  const ids = new Set<string>([...g.changedFiles, ...g.directlyImpacted, ...g.indirectlyImpacted]);
  for (const e of g.edges) {
    if (ids.has(e.from) || ids.has(e.to)) {
      ids.add(e.from);
      ids.add(e.to);
    }
  }
  const byDepth = new Map<number, string[]>();
  for (const id of ids) {
    const d = Math.min(3, depthOf(id));
    (byDepth.get(d) ?? byDepth.set(d, []).get(d)!).push(id);
  }
  const nodes: NodePos[] = [];
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  for (const [depth, list] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = list.sort((a, b) => a.localeCompare(b));
    const radius = depth === 0 ? 0 : 120 + depth * 92;
    sorted.forEach((id, idx) => {
      const angle = depth === 0
        ? (sorted.length === 1 ? 0 : (idx / sorted.length) * Math.PI * 2)
        : (idx / Math.max(1, sorted.length)) * Math.PI * 2 + depth * 0.37;
      // Changed files sit on a small ring of their own so their labels do not
      // pile up in the exact centre.
      const extra = depth === 0 && sorted.length > 1 ? 74 : 0;
      nodes.push({
        id,
        x: cx + Math.cos(angle) * (radius + extra),
        y: cy + Math.sin(angle) * (radius + extra) * 0.72,
        depth,
        changed: changed.has(id),
      });
    });
  }
  const nodeSet = new Set(nodes.map((n) => n.id));
  const edges = g.edges.filter((e) => nodeSet.has(e.from) && nodeSet.has(e.to));
  return { nodes, edges };
}

export function Architecture({ report, onOpen }: { report: ReviewReport; onOpen: (file: string, line?: number) => void }) {
  const g = report.architecture.graph;
  const { nodes, edges } = useMemo(() => layout(report), [report]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showCoupling, setShowCoupling] = useState(false);

  const posById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const selectedNode = selected ? posById.get(selected) : undefined;
  const inbound = selected ? g.importers[selected] ?? [] : [];
  const outbound = selected ? g.edges.filter((e) => e.from === selected) : [];

  if (nodes.length === 0) {
    return (
      <div className="stack">
        <SectionHeader eyebrow="Architecture impact" title="Dependency impact" description="No dependency relationship could be resolved for this change, so there is no graph to show." />
        <EmptyState title="No resolvable dependencies" body="The changed files import nothing inside the analysed repository, or every import points outside it. This is a fact about the change, not an analysis failure." />
      </div>
    );
  }

  return (
    <div className="stack">
      <SectionHeader
        eyebrow="Architecture impact"
        title="Dependency impact of this change"
        description="Rings show distance from a changed file: centre is changed, then direct importers, then transitive impact. Solid edges are resolved imports; dashed edges are inferred calls."
        actions={<>
          <button className={`btn ${showCoupling ? 'active' : ''}`} onClick={() => setShowCoupling((v) => !v)}>{showCoupling ? 'Hide new coupling' : 'Show new coupling'}</button>
          <button className="btn ghost" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Reset view</button>
        </>}
      />

      <div className="grid grid-4">
        <div className="mini-stat"><strong>{g.changedFiles.length}</strong><span>changed files</span></div>
        <div className="mini-stat"><strong>{g.directlyImpacted.length}</strong><span>direct importers</span></div>
        <div className="mini-stat"><strong>{g.indirectlyImpacted.length}</strong><span>transitive impact</span></div>
        <div className="mini-stat"><strong>{g.cycles.length}</strong><span>import cycles</span></div>
      </div>

      <div className="arch-layout">
        <div className="graph-wrap">
          <div className="graph-controls">
            <button className="icon-btn" onClick={() => setZoom((z) => Math.min(2.4, z + 0.2))} title="Zoom in">+</button>
            <button className="icon-btn" onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))} title="Zoom out">−</button>
            <span className="muted small">{Math.round(zoom * 100)}%</span>
          </div>
          <svg
            className="graph"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-label="Architecture impact graph"
            onWheel={(e) => { e.preventDefault(); setZoom((z) => Math.max(0.4, Math.min(2.4, z + (e.deltaY < 0 ? 0.12 : -0.12)))); }}
            onPointerDown={(e) => { setDrag({ x: e.clientX - pan.x, y: e.clientY - pan.y }); (e.target as Element).setPointerCapture?.(e.pointerId); }}
            onPointerMove={(e) => { if (drag) setPan({ x: e.clientX - drag.x, y: e.clientY - drag.y }); }}
            onPointerUp={() => setDrag(null)}
            onPointerLeave={() => setDrag(null)}
          >
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--vscode-editor-foreground, #c9d1d9)" opacity="0.5" />
              </marker>
              <marker id="arrow-new" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--dw-good)" />
              </marker>
            </defs>
            <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
              {[0, 1, 2, 3].map((d) => (
                d === 0 ? null : <circle key={d} cx={WIDTH / 2} cy={HEIGHT / 2} r={120 + d * 92} className="graph-ring" />
              ))}
              {edges.map((e, i) => {
                const a = posById.get(e.from);
                const b = posById.get(e.to);
                if (!a || !b) return null;
                return (
                  <line
                    key={`${e.from}-${e.to}-${i}`}
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    className={`graph-edge ${e.kind === 'call' ? 'edge-inferred' : 'edge-verified'}`}
                    markerEnd="url(#arrow)"
                  />
                );
              })}
              {showCoupling && g.newCoupling.map((c, i) => {
                const a = posById.get(c.from);
                const b = posById.get(c.to);
                if (!a || !b) return null;
                return <line key={`new-${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="graph-edge edge-new" markerEnd="url(#arrow-new)" />;
              })}
              {nodes.map((n) => (
                <g
                  key={n.id}
                  className={`graph-node ${n.changed ? 'node-changed' : n.depth === 1 ? 'node-direct' : 'node-indirect'} ${selected === n.id ? 'node-selected' : ''}`}
                  onClick={(e) => { e.stopPropagation(); setSelected(n.id); }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') setSelected(n.id); }}
                >
                  <circle cx={n.x} cy={n.y} r={n.changed ? 13 : 9} />
                  {(n.changed || n.depth === 1 || selected === n.id) && (
                    <text x={n.x} y={n.y + (n.changed ? 28 : 24)} textAnchor="middle">{shorten(n.id)}</text>
                  )}
                </g>
              ))}
            </g>
          </svg>
          <div className="legend">
            <span><i className="dot dot-changed" /> changed</span>
            <span><i className="dot dot-direct" /> direct importer</span>
            <span><i className="dot dot-indirect" /> transitive</span>
            <span><i className="line-solid" /> import</span>
            <span><i className="line-dashed" /> inferred call</span>
            {showCoupling && <span><i className="line-new" /> new coupling</span>}
          </div>
        </div>

        <aside className="arch-side">
          {selectedNode ? (
            <div className="card">
              <div className="card-head"><h3>{selectedNode.id.split('/').pop()}</h3><Chip tone={selectedNode.changed ? 'bad' : 'neutral'}>{selectedNode.changed ? 'changed' : `depth ${selectedNode.depth}`}</Chip></div>
              <FileRef file={selectedNode.id} onOpen={onOpen} />
              <div className="divider" />
              <h4 className="subhead">Imported by ({inbound.length})</h4>
              {inbound.length === 0 ? <p className="muted small">Nothing imports this file inside the analysed set.</p> : inbound.slice(0, 12).map((f) => <FileRef key={f} file={f} onOpen={onOpen} inline />)}
              <h4 className="subhead">Imports ({outbound.length})</h4>
              {outbound.slice(0, 12).map((e, i) => (
                <div className="edge-row" key={i}>
                  <FileRef file={e.to} onOpen={onOpen} inline />
                  <span className={`edge-kind ${e.resolution}`}>{e.kind} · {e.resolution}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="card">
              <h3>Select a node</h3>
              <p className="muted small">Click any node to inspect its inbound and outbound dependencies. Zoom with the wheel, pan by dragging.</p>
              <div className="divider" />
              <h4 className="subhead">Changed files</h4>
              {g.changedFiles.map((f) => <FileRef key={f} file={f} onOpen={onOpen} inline />)}
            </div>
          )}
          {g.cycles.length > 0 && (
            <div className="card">
              <h3>Import cycles</h3>
              {g.cycles.map((c, i) => <div key={i} className="cycle">{c.join(' → ')}</div>)}
            </div>
          )}
          {g.boundaryChanges.length > 0 && (
            <div className="card">
              <h3>Boundaries touched</h3>
              {g.boundaryChanges.map((b) => (
                <div className="boundary" key={b.file}><FileRef file={b.file} onOpen={onOpen} inline /><div className="muted small">{b.reason}</div></div>
              ))}
            </div>
          )}
        </aside>
      </div>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head"><h2>Repository conventions</h2><Chip tone="neutral">{report.architecture.conventions.length}</Chip></div>
          <p className="muted small">Measured from the repository, not asserted by a model. Each convention lists how many files actually follow it.</p>
          {report.architecture.conventions.length === 0 ? <p className="muted">No convention reached the support threshold in this repository.</p> : (
            <div className="conventions">
              {report.architecture.conventions.map((c) => (
                <div className="convention" key={c.id}>
                  <div className="convention-statement">{c.statement}</div>
                  <div className="convention-meta">{c.supportingFiles}/{c.totalFiles} files · {c.examples.slice(0, 2).join(', ')}</div>
                  <div className="bar"><div style={{ width: `${Math.round(c.supportingFiles / Math.max(1, c.totalFiles) * 100)}%` }} /></div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head"><h2>Coupling delta</h2></div>
          {g.newCoupling.length === 0 && g.removedCoupling.length === 0 ? <p className="muted">This change adds and removes no internal dependency.</p> : (
            <>
              <h4 className="subhead">New dependencies ({g.newCoupling.length})</h4>
              {g.newCoupling.map((c, i) => <div className="coupling new" key={i}>{c.from} → {c.to} <span className="muted small">line {c.line}</span></div>)}
              <h4 className="subhead">Removed dependencies ({g.removedCoupling.length})</h4>
              {g.removedCoupling.map((c, i) => <div className="coupling removed" key={i}>{c.from} ✕ {c.to}</div>)}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function shorten(path: string): string {
  const parts = path.split('/');
  const base = parts.pop() ?? path;
  return base.length > 24 ? `${base.slice(0, 21)}…` : base;
}
