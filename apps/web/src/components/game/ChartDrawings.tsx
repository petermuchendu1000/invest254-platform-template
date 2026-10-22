'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ANCHORS_NEEDED, extendRay, fibArcs, fibChannel, fibExpansion, fibFan, fibLines, fibTimeZones,
  gannFan, gannGrid, equidistantChannel, humanDuration, linearRegression, measure, pitchforkLines,
  regressionDeviation, dashOf, gannUnitPerSecond, levelLabel, moveHandleOf, nextObjectName, shownOn,
  ELLIOTT_CORRECTION_LABELS, ELLIOTT_IMPULSE_LABELS,
  type Anchor, type Drawing, type DrawingKind, type Point, type ToolId,
} from '@/lib/chart/drawings';
import { objectOf } from '@/lib/chart/objects';

/**
 * The drawing surface — what makes the chart's left rail do something.
 *
 * An SVG laid over the plot. Objects are held in CHART space (a time and a price per anchor) and
 * projected to pixels on every paint, so they stay pinned to their bars when the chart is panned or
 * zoomed. `lightweight-charts` draws series and nothing else, so all of this is ours.
 *
 * It is `pointer-events: none` whenever the cursor tool is active, which is what lets the chart keep
 * its own pan, pinch and crosshair: the overlay only takes the pointer while you are actually
 * drawing. That is the difference between a drawing layer and a layer that breaks the chart.
 */

export interface Projection {
  /** Chart time (epoch seconds) → x pixels, or null when the time is outside the visible range. */
  xOf: (time: number) => number | null;
  /** Price → y pixels, or null when the price is off the visible scale. */
  yOf: (price: number) => number | null;
  /** The inverse pair, for turning a pointer position into an anchor. */
  timeOf: (x: number) => number | null;
  priceOf: (y: number) => number | null;
  /** Seconds per bar at the current timeframe, so the measure tool can count bars. */
  barSeconds: number;
  /** Decimal places the instrument quotes, for the labels. */
  digits: number;
  /**
   * The closes between two times, as {x: time, y: price}. The regression and standard-deviation
   * channels are fitted through the BARS in the span, not through the two anchors, so they need the
   * series; everything else here is pure geometry and does not.
   */
  closesBetween?: (fromTime: number, toTime: number) => Array<{ x: number; y: number }>;
}

/**
 * Per-object colours. MetaTrader gives each object type its own default, and anything not named
 * here falls back to the chart's foreground, which is what its own unstyled objects use.
 */
const DEFAULT_COLOR = '#4597ff';
const COLORS: Partial<Record<DrawingKind, string>> = {
  trend: '#4597ff',
  trendAngle: '#4597ff',
  arrowedLine: '#4597ff',
  horizontal: '#f0b90b',
  vertical: '#f0b90b',
  cycleLines: '#8fa2b8',
  channelEquidistant: '#2dd4bf',
  channelStdDev: '#2dd4bf',
  channelRegression: '#2dd4bf',
  pitchfork: '#2dd4bf',
  gannLine: '#ec4899',
  gannFan: '#ec4899',
  gannGrid: '#ec4899',
  fib: '#a78bfa',
  fibTimeZones: '#a78bfa',
  fibFan: '#a78bfa',
  fibArcs: '#a78bfa',
  fibChannel: '#a78bfa',
  fibExpansion: '#a78bfa',
  elliottImpulse: '#f0b90b',
  elliottCorrection: '#f0b90b',
  rectangle: '#8fa2b8',
  triangle: '#8fa2b8',
  ellipse: '#8fa2b8',
  text: '#ffffff',
  textLabel: '#ffffff',
  measure: '#41be56',
  // Arrows carry MetaTrader's own sense: buy blue, sell red, stop red, check green.
  buySign: '#3183ff',
  sellSign: '#f23645',
  arrowUp: '#41be56',
  arrowDown: '#f23645',
  thumbsUp: '#41be56',
  thumbsDown: '#f23645',
  stopSign: '#f23645',
  checkSign: '#41be56',
  leftPriceLabel: '#8fa2b8',
  rightPriceLabel: '#8fa2b8',
  arrow: '#4597ff',
};
const colorOf = (k: DrawingKind): string => COLORS[k] ?? DEFAULT_COLOR;

/** One shared arrow head, referenced by the Arrowed Line. */
const ARROW_MARKER = 'pp-arrowhead';

/**
 * MetaTrader's Arrows group: eleven single-anchor marks a trader pins to a bar. MetaTrader draws
 * them from its Wingdings symbol set; a web chart has no Wingdings, so each is the Unicode glyph
 * that carries the same meaning. The two price labels are not glyphs at all and are drawn as text.
 */
const ARROW_GLYPHS: Partial<Record<DrawingKind, string>> = {
  thumbsUp: '\u{1F44D}',
  thumbsDown: '\u{1F44E}',
  arrowUp: '\u2191',
  arrowDown: '\u2193',
  stopSign: '\u26D4',
  checkSign: '\u2714',
  buySign: '\u25B2',
  sellSign: '\u25BC',
  arrow: '\u279C',
};

const newId = (): string => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function ChartDrawings({
  tool, project, drawings, onChange, onToolDone, selected, onSelect, width, height, revision,
  timeframe, onProperties, onContextMenu, onDeleteLatest, onUndoDelete, showDescriptions,
}: {
  tool: ToolId;
  project: Projection;
  drawings: readonly Drawing[];
  onChange: (next: Drawing[]) => void;
  /** Called once an object is finished, so the rail can fall back to the cursor as MetaTrader does. */
  onToolDone: () => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  width: number;
  height: number;
  /** Bumped by the chart whenever the visible range moves, to force a re-projection. */
  revision: number;
  /** The chart's period, so `OBJPROP_TIMEFRAMES` can hide an object the trader hid on it. */
  timeframe: string;
  /** A double click on an object opens its properties, as it does in MetaTrader. */
  onProperties: (id: string) => void;
  /**
   * MetaTrader's "Show object descriptions" on Chart Properties' Show tab: an object's description
   * is drawn beside it on the chart. Text and Text Label already draw theirs, because for those two
   * the description IS the object.
   */
  showDescriptions: boolean;
  /** A right click on an object opens MetaTrader's object context menu. */
  onContextMenu: (id: string, x: number, y: number) => void;
  /** MetaTrader's Backspace deletes the LATEST object placed, not the selected one. */
  onDeleteLatest: () => void;
  /** MetaTrader's Alt+Backspace and Ctrl+Z restore the last deleted object. */
  onUndoDelete: () => void;
}) {
  /** Anchors placed so far for the object being drawn. */
  const [pending, setPending] = useState<Anchor[]>([]);
  /** Where the pointer is while an object is in progress, for the rubber-band preview. */
  const [hover, setHover] = useState<Anchor | null>(null);
  /**
   * A marker being dragged on the selected object: which one, where the drag started, and the
   * object's anchors as they were when it started, so every move is computed from the original
   * rather than compounding rounding on each mouse event.
   */
  const [drag, setDrag] = useState<{ index: number | 'move'; from: Anchor; origin: Anchor[] } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // `objects` opens the Insert tree rather than drawing, so it is not a drawing tool either.
  const drawingTool: DrawingKind | null =
    tool === 'cursor' || tool === 'crosshair' || tool === 'trash' || tool === 'objects' ? null : tool;

  // Changing tool abandons a half-placed object rather than finishing it with the next tool's clicks.
  useEffect(() => { setPending([]); setHover(null); setDrag(null); }, [tool]);

  const anchorAt = useCallback((e: { clientX: number; clientY: number }): Anchor | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const time = project.timeOf(e.clientX - rect.left);
    const price = project.priceOf(e.clientY - rect.top);
    return time === null || price === null ? null : { time, price };
  }, [project]);

  const onPointerDown = (e: React.PointerEvent) => {
    // Without a drawing tool the overlay is pointer-transparent and never sees this; selection is
    // the objects' own (see HitLine), and deselection is a click on the chart beneath.
    if (!drawingTool) return;
    const a = anchorAt(e);
    if (!a) return;
    e.preventDefault();
    const next = [...pending, a];
    if (next.length < ANCHORS_NEEDED[drawingTool]) { setPending(next); return; }

    /**
     * Complete. The object is created and that is the end of it.
     *
     * A Text object used to stop here and raise `window.prompt('Label')`. MetaTrader has no such
     * step: the object is created with its type's own default text and the text is edited in Object
     * Properties, which is also where its description, colour and levels live. A browser prompt is
     * not a MetaTrader dialog, and it is dismissed by every automated run, which quietly meant a
     * Text object could not be placed at all.
     */
    const def = objectOf(drawingTool);
    onChange([...drawings, {
      id: newId(),
      kind: drawingTool,
      name: nextObjectName(drawingTool, drawings, timeframe),
      points: next,
      color: colorOf(drawingTool),
      ...(def?.defaultText === undefined ? {} : { label: def.defaultText }),
    }]);
    setPending([]);
    setHover(null);
    onToolDone();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawingTool || pending.length === 0) return;
    setHover(anchorAt(e));
  };

  /**
   * MetaTrader's object keys.
   *
   *   Escape                    abandon the object being drawn (ours: a half-placed object).
   *   Delete                    delete the selected object.
   *   Backspace                 "Delete the latest objects imposed to a chart" — the LAST one
   *                             placed, not the selected one. That is MetaTrader's own wording and
   *                             it is deliberately not the same key as Delete.
   *   Alt+Backspace / Ctrl+Z    "Cancel object deletion."
   *
   * None of them fire while the trader is typing into a field, which is what the target check is
   * for: Backspace in the Objects List's Name box must edit the name, not delete an object.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === 'Escape') { setPending([]); setHover(null); }
      if (typing) return;
      if ((e.altKey && e.key === 'Backspace') || ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z'))) {
        e.preventDefault();
        onUndoDelete();
        return;
      }
      if (e.key === 'Delete' && selected) {
        onChange(drawings.filter((d) => d.id !== selected));
        onSelect(null);
        return;
      }
      if (e.key === 'Backspace' && drawings.length > 0) {
        e.preventDefault();
        onDeleteLatest();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected, drawings, onChange, onSelect, onDeleteLatest, onUndoDelete]);

  // `revision` is in the dependency list so a pan or zoom repaints every object at its new position.
  void revision;

  /**
   * The selected object's square markers, and the drag that moves them.
   *
   * The overlay is pointer-transparent under the cursor tool so the chart keeps its own pan and
   * zoom, so each marker re-enables the pointer for itself and captures it for the duration of the
   * drag. That is also what stops a drag that leaves the marker from being lost.
   */
  const selectedObject = selected === null ? null : drawings.find((d) => d.id === selected) ?? null;

  const grab = (e: React.PointerEvent, index: number | 'move') => {
    if (!selectedObject || drawingTool) return;
    e.stopPropagation();
    e.preventDefault();
    const a = anchorAt(e);
    if (!a) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ index, from: a, origin: selectedObject.points.map((p) => ({ ...p })) });
  };

  const dragTo = (e: React.PointerEvent) => {
    if (!drag || !selectedObject) return;
    e.stopPropagation();
    const a = anchorAt(e);
    if (!a) return;
    const points = drag.index === 'move'
      ? drag.origin.map((p) => ({ time: p.time + (a.time - drag.from.time), price: p.price + (a.price - drag.from.price) }))
      : drag.origin.map((p, i) => (i === drag.index ? a : p));
    onChange(drawings.map((d) => (d.id === selectedObject.id ? { ...d, points } : d)));
  };

  const letGo = (e: React.PointerEvent) => {
    if (!drag) return;
    e.stopPropagation();
    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    setDrag(null);
  };

  const preview: Drawing | null = drawingTool && pending.length > 0 && hover
    ? { id: '__preview', kind: drawingTool, points: [...pending, hover], color: colorOf(drawingTool) }
    : null;

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      className="absolute inset-0 z-10"
      /**
       * The overlay takes the pointer ONLY while a drawing tool is in use.
       *
       * It used to put a full-size transparent rect over the plot whenever the cursor tool was
       * active, to catch selection clicks. The cursor tool is the DEFAULT, and a child may re-enable
       * pointer events even under a `none` parent, so from page load every pan, pinch, zoom and
       * crosshair move landed on an invisible sheet instead of the chart: the chart simply stopped
       * responding, and once a tool had been used and dropped back to the cursor it stayed that way.
       *
       * Selection is now the drawn objects' own job — each carries a transparent wide-stroke twin
       * (see `HitLine`) — so nothing but an actual line is ever a target, and the chart keeps every
       * gesture it had.
       */
      style={{
        pointerEvents: drawingTool ? 'auto' : 'none',
        cursor: drawingTool ? 'crosshair' : 'default',
        touchAction: drawingTool ? 'none' : 'auto',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      aria-hidden
    >
      <defs>
        <marker id={ARROW_MARKER} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor" />
        </marker>
      </defs>
      {/* `OBJPROP_TIMEFRAMES` hides an object on a period its Visualization tab has unticked;
          `OBJPROP_BACK` moves it to the layer behind the candles, drawn by DrawingsBackdrop. */}
      {drawings.filter((d) => shownOn(d, timeframe) && d.back !== true).map((d) => (
        /* The wrapper carries the object's identity, so the Objects List can find, highlight and
           count what is on the chart without the renderers each having to label themselves. */
        <g
          key={d.id}
          data-object-id={d.id}
          data-object-kind={d.kind}
          // A double click on an object opens its properties, as it does in MetaTrader. The handler
          // sits on the wrapper so every object family gets it from one place; the click itself
          // lands on the object's own hit twin and bubbles here.
          {...(drawingTool ? {} : {
            onDoubleClick: () => onProperties(d.id),
            onContextMenu: (e: React.MouseEvent) => {
              e.preventDefault();
              onSelect(d.id);
              onContextMenu(d.id, e.clientX, e.clientY);
            },
          })}
        >
        <Shape
          d={d}
          project={project}
          selected={d.id === selected}
          // Only the cursor tool selects; while drawing, a click on an old object must place an
          // anchor rather than select it.
          {...(drawingTool ? {} : { onPick: () => onSelect(d.id) })}
        />
        {showDescriptions && d.label && d.kind !== 'text' && d.kind !== 'textLabel'
          ? <Description d={d} project={project} />
          : null}
        </g>
      ))}
      {preview ? <Shape d={preview} project={project} selected={false} preview /> : null}
      {/* Anchors already committed for the object in progress, so a three-click pitchfork shows its
          progress rather than appearing to have swallowed the first two clicks. */}
      {pending.map((p, i) => {
        const x = project.xOf(p.time), y = project.yOf(p.price);
        return x === null || y === null ? null
          : <circle key={i} cx={x} cy={y} r={3.5} fill={drawingTool ? colorOf(drawingTool) : '#fff'} />;
      })}
      {/* MetaTrader's square markers on the selected object: one per anchor, and one in the middle
          that moves the whole object without reshaping it. */}
      {selectedObject && !drawingTool && shownOn(selectedObject, timeframe) ? (
        <g
          // A marker covers the object underneath it, and the central one sits exactly where a
          // trader aims to right click a line. Without this, selecting an object would take away
          // its own context menu.
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu(selectedObject.id, e.clientX, e.clientY);
          }}
        >
          {selectedObject.points.map((p, i) => {
            const x = project.xOf(p.time), y = project.yOf(p.price);
            return x === null || y === null ? null : (
              <Handle key={i} x={x} y={y} colour={selectedObject.color}
                      onDown={(e) => grab(e, i)} onMove={dragTo} onUp={letGo} />
            );
          })}
          {(() => {
            const pair = moveHandleOf(selectedObject);
            if (!pair) return null;
            const u = selectedObject.points[pair[0]], v = selectedObject.points[pair[1]];
            if (!u || !v) return null;
            const ux = project.xOf(u.time), uy = project.yOf(u.price);
            const vx = project.xOf(v.time), vy = project.yOf(v.price);
            if (ux === null || uy === null || vx === null || vy === null) return null;
            return (
              <Handle x={(ux + vx) / 2} y={(uy + vy) / 2} colour={selectedObject.color} centre
                      onDown={(e) => grab(e, 'move')} onMove={dragTo} onUp={letGo} />
            );
          })()}
        </g>
      ) : null}
    </svg>
  );
}

/**
 * The layer BEHIND the candles, for objects with MetaTrader's "Draw object as background" set.
 *
 * MetaTrader's `OBJPROP_BACK` puts the object under the price series, which is what makes a shaded
 * rectangle usable as a highlight rather than a sheet over the bars. The price series here is a
 * canvas, and nothing in an overlay can get beneath it, so the chart paints its own background
 * transparent and the pane colour sits on the wrapper: this SVG then sits between that colour and
 * the canvas, which is the same stack MetaTrader has. A background object is not on the front layer
 * at all, so it cannot be clicked; it is reached through the Objects List, which is how a trader
 * reaches a background object in MetaTrader too.
 */
export function DrawingsBackdrop({ project, drawings, width, height, revision, timeframe }: {
  project: Projection;
  drawings: readonly Drawing[];
  width: number;
  height: number;
  revision: number;
  timeframe: string;
}) {
  void revision;
  const back = drawings.filter((d) => d.back === true && shownOn(d, timeframe));
  if (back.length === 0) return null;
  return (
    <svg width={width} height={height} className="pointer-events-none absolute inset-0 z-0" aria-hidden>
      {back.map((d) => (
        <g key={d.id} data-object-id={d.id} data-object-kind={d.kind} data-object-back="">
          <Shape d={d} project={project} selected={false} />
        </g>
      ))}
    </svg>
  );
}

/**
 * One of MetaTrader's square markers on a selected object.
 *
 * The centre marker is drawn hollow so the point that MOVES the object reads differently from the
 * points that reshape it. MetaQuotes names no colour for either, so both take the object's own.
 */
function Handle({ x, y, colour, centre, onDown, onMove, onUp }: {
  x: number; y: number; colour: string; centre?: boolean;
  onDown: (e: React.PointerEvent) => void;
  onMove: (e: React.PointerEvent) => void;
  onUp: (e: React.PointerEvent) => void;
}) {
  const r = 4;
  return (
    <rect
      data-object-handle={centre ? 'move' : 'anchor'}
      x={x - r} y={y - r} width={r * 2} height={r * 2}
      fill={centre ? '#0f1720' : colour}
      stroke={centre ? colour : '#ffffff'}
      strokeWidth={1.25}
      style={{ pointerEvents: 'all', cursor: centre ? 'move' : 'pointer', touchAction: 'none' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
  );
}

/**
 * An object's description, drawn beside its first anchor.
 *
 * MetaTrader draws it only when "Show object descriptions" is ticked on Chart Properties' Show tab,
 * which is why it is a separate piece rather than part of every renderer.
 */
function Description({ d, project }: { d: Drawing; project: Projection }) {
  const a = d.points[0];
  if (!a) return null;
  const x = project.xOf(a.time), y = project.yOf(a.price);
  if (x === null || y === null) return null;
  return (
    <text x={x + 6} y={y - 6} fill={d.color} fontSize={10} fontFamily="monospace" pointerEvents="none">
      {d.label}
    </text>
  );
}

/** The transparent wide-stroke twin that makes a hairline object clickable. */
function HitLine({ x1, y1, x2, y2, onPick }: { x1: number; y1: number; x2: number; y2: number; onPick?: (() => void) | undefined }) {
  if (!onPick) return null;
  return (
    <line
      x1={x1} y1={y1} x2={x2} y2={y2}
      stroke="transparent" strokeWidth={14} fill="none"
      style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
      onPointerDown={(e) => { e.stopPropagation(); onPick(); }}
    />
  );
}

function Shape({ d, project, selected, preview, onPick }: {
  d: Drawing; project: Projection; selected: boolean; preview?: boolean; onPick?: (() => void) | undefined;
}) {
  const px = (an: Anchor): Point | null => {
    const x = project.xOf(an.time), y = project.yOf(an.price);
    return x === null || y === null ? null : { x, y };
  };
  const stroke = selected ? '#ffffff' : d.color;
  // MetaTrader's OBJPROP_WIDTH is 1 to 5. 1.5 is this renderer's hairline for a 1-wide object, so
  // the property scales from there and a selected object is drawn a step heavier, as MetaTrader's is.
  const width = (selected ? 0.5 : 0) + 1.5 * Math.max(1, d.width ?? 1);
  // A preview is always dashed so a half-placed object reads as unfinished; a placed object takes
  // its own OBJPROP_STYLE.
  const dash = preview ? '4 3' : dashOf(d.style);
  const common = { stroke, strokeWidth: width, fill: 'none', ...(dash ? { strokeDasharray: dash } : {}) };
  /**
   * A closed shape is an outline unless the trader fills it.
   *
   * MetaTrader's Parameters tab has `Fill` ("enable/disable color filling inside the shape") and
   * the Common tab's "Draw object as background" does the same job: "This option also sets color
   * filling of objects like shapes or channels". Neither is on by default, so neither is here.
   */
  const shapeFill = d.fill === true || d.back === true
    ? { fill: stroke, fillOpacity: 0.18 }
    : { fill: 'none' };
  const [a, b, c] = d.points;
  if (!a) return null;
  const pa = px(a);

  if (d.kind === 'horizontal') {
    return pa ? (
      <g>
        <line x1={0} y1={pa.y} x2="100%" y2={pa.y} {...common} />
        <HitLine x1={0} y1={pa.y} x2={10_000} y2={pa.y} onPick={onPick} />
        <text x={6} y={pa.y - 5} fill={stroke} fontSize={10} fontFamily="monospace">{a.price.toFixed(project.digits)}</text>
      </g>
    ) : null;
  }
  if (d.kind === 'vertical') {
    return pa ? (
      <g>
        <line x1={pa.x} y1={0} x2={pa.x} y2="100%" {...common} />
        <HitLine x1={pa.x} y1={0} x2={pa.x} y2={10_000} onPick={onPick} />
      </g>
    ) : null;
  }
  if (ARROW_GLYPHS[d.kind] !== undefined) {
    // MetaTrader's Arrows are single-anchor glyphs pinned to a price and a time.
    return pa ? (
      <g>
        <text x={pa.x} y={pa.y} fill={stroke} fontSize={16} textAnchor="middle" dominantBaseline="middle">
          {ARROW_GLYPHS[d.kind]}
        </text>
        <HitLine x1={pa.x - 9} y1={pa.y} x2={pa.x + 9} y2={pa.y} onPick={onPick} />
      </g>
    ) : null;
  }
  if (d.kind === 'leftPriceLabel' || d.kind === 'rightPriceLabel') {
    const left = d.kind === 'leftPriceLabel';
    return pa ? (
      <g>
        <text x={pa.x + (left ? -6 : 6)} y={pa.y} fill={stroke} fontSize={10} fontFamily="monospace"
              textAnchor={left ? 'end' : 'start'} dominantBaseline="middle">
          {a.price.toFixed(project.digits)}
        </text>
        <HitLine x1={pa.x - 30} y1={pa.y} x2={pa.x + 30} y2={pa.y} onPick={onPick} />
      </g>
    ) : null;
  }
  if (d.kind === 'text' || d.kind === 'textLabel') {
    return pa ? (
      <g>
        <text x={pa.x} y={pa.y} fill={stroke} fontSize={12} fontWeight={600}>{d.label ?? ''}</text>
        <HitLine x1={pa.x} y1={pa.y - 6} x2={pa.x + Math.max(20, (d.label ?? '').length * 7)} y2={pa.y - 6} onPick={onPick} />
      </g>
    ) : null;
  }
  if (!b) return null;
  const pb = px(b);

  if (d.kind === 'trend' || d.kind === 'trendAngle' || d.kind === 'arrowedLine') {
    if (!pa || !pb) return null;
    // Trendline by Angle is a ray: MetaTrader extends it past the second anchor and prints the
    // angle it was drawn at. Arrowed Line is a trendline with a head.
    //
    // A plain Trendline extends only where the Parameters tab's `Ray right` / `Ray left` say so.
    // MetaQuotes does not state which way those start, so neither is assumed on: an untouched
    // trendline is the segment between its anchors, and ticking a ray extends it.
    const ray = d.kind === 'trendAngle' || d.rayRight === true ? extendRay(a, b, 4) : null;
    const end = ray ? px(ray.b) : pb;
    const backRay = d.rayLeft === true ? px(extendRay(b, a, 4).b) : null;
    if (!end) return null;
    const deg = (Math.atan2(pa.y - pb.y, pb.x - pa.x) * 180) / Math.PI;
    return (
      <g>
        <line
          x1={backRay ? backRay.x : pa.x} y1={backRay ? backRay.y : pa.y} x2={end.x} y2={end.y} {...common}
          {...(d.kind === 'arrowedLine' ? { markerEnd: `url(#${ARROW_MARKER})` } : {})}
        />
        <HitLine x1={pa.x} y1={pa.y} x2={end.x} y2={end.y} onPick={onPick} />
        {d.kind === 'trendAngle' ? (
          <text x={pb.x + 6} y={pb.y - 6} fill={stroke} fontSize={10} fontFamily="monospace">{deg.toFixed(1)}°</text>
        ) : null}
      </g>
    );
  }

  if (d.kind === 'cycleLines' && pa && pb) {
    // Equally spaced verticals, the drag setting the period. MetaTrader repeats them across the
    // whole window rather than only between the anchors.
    const step = pb.x - pa.x;
    if (Math.abs(step) < 2) return null;
    const lines: number[] = [];
    for (let i = -20; i <= 40 && lines.length < 60; i++) lines.push(pa.x + step * i);
    return (
      <g>
        {lines.map((x, i) => <line key={i} x1={x} y1={0} x2={x} y2="100%" {...common} />)}
        <HitLine x1={pa.x} y1={0} x2={pa.x} y2={10_000} onPick={onPick} />
      </g>
    );
  }

  if (d.kind === 'rectangle' && pa && pb) {
    return (
      <g>
        <rect x={Math.min(pa.x, pb.x)} y={Math.min(pa.y, pb.y)} width={Math.abs(pb.x - pa.x)} height={Math.abs(pb.y - pa.y)}
              {...common} {...shapeFill} />
        <HitLine x1={pa.x} y1={pa.y} x2={pb.x} y2={pa.y} onPick={onPick} />
      </g>
    );
  }

  if (d.kind === 'ellipse' && pa && pb) {
    return (
      <g>
        <ellipse cx={(pa.x + pb.x) / 2} cy={(pa.y + pb.y) / 2} rx={Math.abs(pb.x - pa.x) / 2} ry={Math.abs(pb.y - pa.y) / 2}
                 {...common} {...shapeFill} />
        <HitLine x1={pa.x} y1={(pa.y + pb.y) / 2} x2={pb.x} y2={(pa.y + pb.y) / 2} onPick={onPick} />
      </g>
    );
  }

  if (d.kind === 'gannFan' && pa && pb) {
    // The Parameters tab's `Pips per bar:` sets the 1x1 slope once the trader has set it.
    const rays = gannFan(a, b, 4, gannUnitPerSecond(d, project.barSeconds, project.digits));
    return (
      <g>
        {rays.map((r, i) => {
          const q = px(r.line.b);
          return q ? (
            <g key={i}>
              <line x1={pa.x} y1={pa.y} x2={q.x} y2={q.y} {...common} strokeWidth={r.ratio === 1 ? width + 0.5 : width} />
              <text x={q.x - 4} y={q.y} fill={stroke} fontSize={9} fontFamily="monospace" textAnchor="end">{r.label}</text>
            </g>
          ) : null;
        })}
        <HitLine x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} onPick={onPick} />
      </g>
    );
  }

  if (d.kind === 'gannLine' && pa && pb) {
    const ray = extendRay(a, b, 4);
    const end = px(ray.b);
    return end ? (
      <g>
        <line x1={pa.x} y1={pa.y} x2={end.x} y2={end.y} {...common} />
        <HitLine x1={pa.x} y1={pa.y} x2={end.x} y2={end.y} onPick={onPick} />
      </g>
    ) : null;
  }

  if (d.kind === 'gannGrid' && pa && pb) {
    const g = gannGrid(a, b, 8, gannUnitPerSecond(d, project.barSeconds, project.digits));
    return (
      <g>
        {g.verticals.map((t, i) => { const x = project.xOf(t); return x === null ? null : <line key={`v${i}`} x1={x} y1={0} x2={x} y2="100%" {...common} strokeOpacity={0.5} />; })}
        {g.horizontals.map((pr, i) => { const y = project.yOf(pr); return y === null ? null : <line key={`h${i}`} x1={0} y1={y} x2="100%" y2={y} {...common} strokeOpacity={0.5} />; })}
        <HitLine x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} onPick={onPick} />
      </g>
    );
  }

  if (d.kind === 'fibFan' && pa && pb) {
    const rays = fibFan(a, b, 3);
    return (
      <g>
        {rays.map((r, i) => {
          const q = px(r.line.b);
          return q ? (
            <g key={i}>
              <line x1={pa.x} y1={pa.y} x2={q.x} y2={q.y} {...common} />
              <text x={q.x - 4} y={q.y} fill={stroke} fontSize={9} fontFamily="monospace" textAnchor="end">{(r.ratio * 100).toFixed(1)}%</text>
            </g>
          ) : null;
        })}
        <HitLine x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} onPick={onPick} />
      </g>
    );
  }

  if (d.kind === 'fibTimeZones' && pa && pb) {
    return (
      <g>
        {fibTimeZones(a, b).map((z, i) => {
          const x = project.xOf(z.time);
          return x === null ? null : (
            <g key={i}>
              <line x1={x} y1={0} x2={x} y2="100%" {...common} />
              <text x={x + 3} y={12} fill={stroke} fontSize={9} fontFamily="monospace">{z.step}</text>
            </g>
          );
        })}
        <HitLine x1={pa.x} y1={0} x2={pa.x} y2={10_000} onPick={onPick} />
      </g>
    );
  }

  if (d.kind === 'fibArcs' && pa && pb) {
    return (
      <g>
        {fibArcs(a, b).map((arc, i) => {
          const q = px({ time: a.time + arc.dTime, price: a.price + arc.dPrice });
          if (!q) return null;
          const r = Math.hypot(q.x - pa.x, q.y - pa.y);
          return (
            <g key={i}>
              <circle cx={pa.x} cy={pa.y} r={r} {...common} />
              <text x={pa.x + r + 3} y={pa.y} fill={stroke} fontSize={9} fontFamily="monospace">{(arc.ratio * 100).toFixed(1)}%</text>
            </g>
          );
        })}
        <HitLine x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} onPick={onPick} />
      </g>
    );
  }

  if (d.kind === 'measure' && pa && pb) {
    const m = measure(a, b, project.barSeconds);
    const tone = m.up ? '#41be56' : '#f23645';
    const bars = m.bars === null ? '' : ` · ${m.bars} bars`;
    return (
      <g>
        <rect x={Math.min(pa.x, pb.x)} y={Math.min(pa.y, pb.y)} width={Math.abs(pb.x - pa.x)} height={Math.abs(pb.y - pa.y)}
              fill={tone} fillOpacity={0.12} stroke={tone} strokeWidth={1} />
        <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={tone} strokeWidth={1.5} />
        <HitLine x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} onPick={onPick} />
        <text x={(pa.x + pb.x) / 2} y={Math.min(pa.y, pb.y) - 6} fill={tone} fontSize={11} fontFamily="monospace" textAnchor="middle">
          {`${m.delta >= 0 ? '+' : ''}${m.delta.toFixed(project.digits)} (${m.percent.toFixed(2)}%) · ${humanDuration(m.seconds)}${bars}`}
        </text>
      </g>
    );
  }

  if (d.kind === 'fib' && pa && pb) {
    const left = Math.min(pa.x, pb.x), right = Math.max(pa.x, pb.x);
    return (
      <g>
        {fibLines(a, b, d.levels).map((l) => {
          const y = project.yOf(l.price);
          if (y === null) return null;
          return (
            <g key={l.ratio}>
              <line x1={left} y1={y} x2={right} y2={y} stroke={stroke} strokeWidth={l.ratio === 0 || l.ratio === 1 ? 1.5 : 1}
                    strokeDasharray={l.ratio === 0 || l.ratio === 1 ? undefined : '3 3'} />
              <HitLine x1={left} y1={y} x2={right} y2={y} onPick={onPick} />
              {/* MetaTrader labels a level with its DESCRIPTION, which defaults to the
                  percentage. The price is shown only where the description asks for it with %$. */}
              <text x={right + 4} y={y + 3} fill={stroke} fontSize={9} fontFamily="monospace">
                {levelLabel(l.label, l.price, project.digits)}
              </text>
            </g>
          );
        })}
      </g>
    );
  }

  if ((d.kind === 'channelStdDev' || d.kind === 'channelRegression') && pa && pb) {
    // Both are a least-squares fit through the span. The regression channel bounds it by the
    // extremes of the fitted residuals; the standard-deviation channel by the deviation itself,
    // which is the only difference between them.
    const pts = project.closesBetween?.(a.time, b.time) ?? [];
    const sample = pts.length >= 2 ? pts : [{ x: a.time, y: a.price }, { x: b.time, y: b.price }];
    const fit = linearRegression(sample);
    const dev = regressionDeviation(sample, fit);
    const band = d.kind === 'channelStdDev'
      ? dev
      : Math.max(...sample.map((pt: { x: number; y: number }) => Math.abs(pt.y - (fit.intercept + fit.slope * pt.x))), dev);
    const mid = (t: number) => fit.intercept + fit.slope * t;
    const rows: Array<[number, number]> = [[a.time, mid(a.time)], [b.time, mid(b.time)]];
    const render = (offset: number, key: string, bold: boolean) => {
      const p1 = px({ time: rows[0]![0], price: rows[0]![1] + offset });
      const p2 = px({ time: rows[1]![0], price: rows[1]![1] + offset });
      return p1 && p2 ? (
        <g key={key}>
          <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} {...common} strokeWidth={bold ? width + 0.5 : width}
                {...(bold ? {} : { strokeDasharray: '4 3' })} />
          <HitLine x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} onPick={onPick} />
        </g>
      ) : null;
    };
    return <g>{render(0, 'mid', true)}{render(band, 'up', false)}{render(-band, 'dn', false)}</g>;
  }

  if (d.kind === 'elliottImpulse' || d.kind === 'elliottCorrection') {
    const labels = d.kind === 'elliottImpulse' ? ELLIOTT_IMPULSE_LABELS : ELLIOTT_CORRECTION_LABELS;
    const pts = d.points.map(px);
    return (
      <g>
        {pts.map((p, i) => {
          const q = pts[i + 1];
          return p && q ? <line key={`l${i}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} {...common} /> : null;
        })}
        {pts.map((p, i) => p ? (
          <text key={`t${i}`} x={p.x} y={p.y - 8} fill={stroke} fontSize={11} fontWeight={600} textAnchor="middle">
            {labels[i] ?? ''}
          </text>
        ) : null)}
        {pts[0] && pts[1] ? <HitLine x1={pts[0].x} y1={pts[0].y} x2={pts[1].x} y2={pts[1].y} onPick={onPick} /> : null}
      </g>
    );
  }

  if (!c) return null;
  const pc = px(c);

  if (d.kind === 'triangle' && pa && pb && pc) {
    return (
      <g>
        <polygon points={`${pa.x},${pa.y} ${pb.x},${pb.y} ${pc.x},${pc.y}`} {...common} {...shapeFill} />
        <HitLine x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} onPick={onPick} />
      </g>
    );
  }

  if (d.kind === 'channelEquidistant' && pa && pb && pc) {
    const { base, parallel } = equidistantChannel(a, b, c);
    return (
      <g>
        {[base, parallel].map((l, i) => {
          const p = px(l.a), q = px(l.b);
          return p && q ? (
            <g key={i}>
              <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} {...common} />
              <HitLine x1={p.x} y1={p.y} x2={q.x} y2={q.y} onPick={onPick} />
            </g>
          ) : null;
        })}
      </g>
    );
  }

  if (d.kind === 'fibChannel' && pa && pb && pc) {
    return (
      <g>
        {fibChannel(a, b, c).map((l, i) => {
          const p = px(l.line.a), q = px(l.line.b);
          return p && q ? (
            <g key={i}>
              <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} {...common} strokeWidth={l.ratio === 0 || l.ratio === 1 ? width + 0.5 : width} />
              <text x={q.x + 4} y={q.y + 3} fill={stroke} fontSize={9} fontFamily="monospace">{(l.ratio * 100).toFixed(1)}%</text>
            </g>
          ) : null;
        })}
        <HitLine x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} onPick={onPick} />
      </g>
    );
  }

  if (d.kind === 'fibExpansion' && pa && pb && pc) {
    const left = Math.min(pa.x, pb.x, pc.x);
    return (
      <g>
        {fibExpansion(a, b, c).map((l, i) => {
          const y = project.yOf(l.price);
          return y === null ? null : (
            <g key={i}>
              <line x1={left} y1={y} x2="100%" y2={y} {...common} strokeDasharray={l.ratio === 1 ? undefined : '3 3'} />
              <HitLine x1={left} y1={y} x2={10_000} y2={y} onPick={onPick} />
              <text x={left + 4} y={y - 3} fill={stroke} fontSize={9} fontFamily="monospace">
                {`${l.label} ${l.price.toFixed(project.digits)}`}
              </text>
            </g>
          );
        })}
      </g>
    );
  }

  if (d.kind === 'pitchfork' && c) {
    const f = pitchforkLines(a, b, c);
    return (
      <g>
        {[f.median, f.upper, f.lower].map((l, i) => {
          const p = px(l.from), q = px(l.to);
          return p && q ? (
            <g key={i}>
              <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} {...common} strokeWidth={i === 0 ? width + 0.5 : width} />
              <HitLine x1={p.x} y1={p.y} x2={q.x} y2={q.y} onPick={onPick} />
            </g>
          ) : null;
        })}
      </g>
    );
  }
  return null;
}
