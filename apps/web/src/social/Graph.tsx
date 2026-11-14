import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  ArrowsOutSimple,
  ChatCircleText,
  Lightbulb,
  Minus,
  NotePencil,
  Plus,
  UsersThree,
} from '@phosphor-icons/react';
import type { SocialGraphEdge, SocialGraphNode, SocialNote } from '@yap/contracts/social';

type Point = { x: number; y: number };
const position = (node: SocialGraphNode): Point => ({
  x: 100 + node.x * 1.04,
  y: 80 + node.y * 0.64,
});
const short = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length).trim()}…` : text;

export default function ResearchGraph({
  nodes,
  edges,
  notes,
  selectedId,
  onSelect,
  onSelectNote,
}: {
  nodes: SocialGraphNode[];
  edges: SocialGraphEdge[];
  notes: SocialNote[];
  selectedId: string;
  onSelect: (node: SocialGraphNode) => void;
  onSelectNote: (note: SocialNote) => void;
}) {
  const [zoom, setZoom] = useState(0.8);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ width: 800, height: 676 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; pan: Point } | null>(null);
  const shownNodes = useMemo(() => {
    const selected = nodes.find((node) => node.id === selectedId);
    const sorted = [...nodes].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
    const subset = sorted.slice(0, 65);
    if (selected && !subset.some((node) => node.id === selected.id))
      subset[subset.length - 1] = selected;
    return subset;
  }, [nodes, selectedId]);
  const nodeMap = useMemo(() => new Map(shownNodes.map((node) => [node.id, node])), [shownNodes]);
  const shownEdges = edges.filter((edge) => nodeMap.has(edge.source) && nodeMap.has(edge.target));
  const neighbors = new Set(
    shownEdges
      .filter((edge) => edge.source === selectedId || edge.target === selectedId)
      .flatMap((edge) => [edge.source, edge.target]),
  );
  const shownNotes = notes.slice(-8).map((note, index) => {
    const anchor = shownNodes.find((node) =>
      node.evidenceIds.some((id) => note.evidenceIds.includes(id)),
    );
    const point = anchor ? position(anchor) : { x: 140 + (index % 4) * 260, y: 640 };
    return {
      note,
      anchor,
      x: Math.max(110, Math.min(1130, point.x + (index % 2 ? -160 : 160))),
      y: Math.min(760, point.y + 140 + Math.floor(index / 4) * 100),
    };
  });
  const points = [...shownNodes.map(position), ...shownNotes.map(({ x, y }) => ({ x, y }))];
  const minX = Math.min(...points.map((point) => point.x - 110), 0);
  const maxX = Math.max(...points.map((point) => point.x + 110), 400);
  const minY = Math.min(...points.map((point) => point.y - 70), 0);
  const maxY = Math.max(...points.map((point) => point.y + 70), 300);
  const fitGraph = useCallback(() => {
    const width = maxX - minX,
      height = maxY - minY;
    const nextZoom = Math.max(
      0.3,
      Math.min(0.85, (viewport.width - 32) / width, (viewport.height - 128) / height),
    );
    setZoom(nextZoom);
    setPan({
      x: (viewport.width - width * nextZoom) / 2 - minX * nextZoom,
      y: (viewport.height - 112 - height * nextZoom) / 2 - minY * nextZoom + 8,
    });
  }, [minX, maxX, minY, maxY, viewport.width, viewport.height]);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width > 0 && height > 0)
        setViewport((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height },
        );
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  useEffect(() => {
    fitGraph();
  }, [fitGraph]);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as Element).closest('button')) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, pan };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    setPan({
      x: drag.current.pan.x + event.clientX - drag.current.x,
      y: drag.current.pan.y + event.clientY - drag.current.y,
    });
  }

  return (
    <div className="social-graph-shell">
      <div
        ref={viewportRef}
        className="social-graph-viewport"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        aria-label="Research network. Drag the canvas to move it, or use the controls. Every node is a button; the evidence list provides an alternative view."
      >
        <div
          className="social-graph-world"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          <svg className="social-graph-lines" width="1320" height="1160" aria-hidden="true">
            {shownEdges.map((edge) => {
              const source = nodeMap.get(edge.source)!,
                target = nodeMap.get(edge.target)!;
              const a = position(source),
                b = position(target);
              const highlighted = edge.source === selectedId || edge.target === selectedId;
              return (
                <line
                  key={edge.id}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className={`${edge.observed ? 'observed' : 'derived'} ${highlighted ? 'highlighted' : ''}`}
                >
                  <title>
                    {edge.kind}:{' '}
                    {edge.observed
                      ? 'observed public relationship'
                      : 'derived content relationship'}
                  </title>
                </line>
              );
            })}
            {shownNotes.map(
              ({ note, anchor, x, y }) =>
                anchor && (
                  <path
                    key={note.id}
                    className="note-connection"
                    d={`M ${position(anchor).x} ${position(anchor).y} Q ${x} ${y - 100} ${x} ${y}`}
                  />
                ),
            )}
          </svg>
          {shownNodes.map((node) => {
            const point = position(node);
            const Icon =
              node.kind === 'post'
                ? ChatCircleText
                : node.kind === 'actor' || node.kind === 'community'
                  ? UsersThree
                  : Lightbulb;
            return (
              <button
                key={node.id}
                type="button"
                style={{ left: point.x, top: point.y }}
                className={`social-graph-node social-node-${node.kind} ${node.id === selectedId ? 'selected' : ''} ${selectedId && neighbors.has(node.id) ? 'neighbor' : ''}`}
                onClick={() => onSelect(node)}
                aria-pressed={node.id === selectedId}
                aria-label={`${node.kind}: ${node.label}`}
              >
                <span className="social-node-kind">
                  <Icon size={16} />
                  {node.kind}
                </span>
                <span>{short(node.label, node.kind === 'post' ? 78 : 40)}</span>
              </button>
            );
          })}
          {shownNotes.map(({ note, x, y }) => (
            <button
              key={note.id}
              type="button"
              style={{ left: x, top: y }}
              className={`social-graph-node social-node-note social-note-${note.kind}`}
              onClick={() => onSelectNote(note)}
              aria-label={`Saved ${note.kind} note: ${note.text}`}
            >
              <span className="social-node-kind">
                <NotePencil size={16} />
                {note.kind}
              </span>
              <span>{short(note.text, 92)}</span>
            </button>
          ))}
        </div>
        {!shownNodes.length && (
          <div className="social-graph-empty">
            No nodes match these filters. Try another platform or clear the search.
          </div>
        )}
      </div>
      <div className="social-graph-controls" role="group" aria-label="Graph navigation">
        <button
          type="button"
          onClick={() => setZoom((value) => Math.max(0.3, value - 0.15))}
          aria-label="Zoom out"
          disabled={zoom <= 0.3}
        >
          <Minus size={18} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => setZoom((value) => Math.min(1.6, value + 0.15))}
          aria-label="Zoom in"
          disabled={zoom >= 1.6}
        >
          <Plus size={18} />
        </button>
        <button type="button" onClick={fitGraph} aria-label="Fit graph" title="Fit graph">
          <ArrowsOutSimple size={18} />
        </button>
        <button
          type="button"
          onClick={() => setPan((value) => ({ ...value, x: value.x + 160 }))}
          aria-label="Pan graph right"
        >
          →
        </button>
        <button
          type="button"
          onClick={() => setPan((value) => ({ ...value, x: value.x - 160 }))}
          aria-label="Pan graph left"
        >
          ←
        </button>
        <button
          type="button"
          onClick={() => setPan((value) => ({ ...value, y: value.y + 160 }))}
          aria-label="Pan graph down"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={() => setPan((value) => ({ ...value, y: value.y - 160 }))}
          aria-label="Pan graph up"
        >
          ↑
        </button>
      </div>
      <div className="social-graph-legend">
        <span>
          <i className="social-line-observed" />
          Observed connection
        </span>
        <span>
          <i className="social-line-derived" />
          Content relationship
        </span>
        <span>
          <i className="social-legend-note" />
          Your note
        </span>
      </div>
      {nodes.length > shownNodes.length && (
        <p className="social-graph-limit">
          Showing {shownNodes.length} of {nodes.length} matching nodes. The evidence list includes
          every collected post.
        </p>
      )}
    </div>
  );
}
