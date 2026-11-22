"use client";

// Resizable split panes (IDE style). "horizontal" puts panes side by side with col-resize gutters;
// "vertical" stacks them with row-resize gutters. Sizes are percentages, persisted per id.

import { Children, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { applyDrag, clampSizes, parseStored } from "../lib/split";

const GUTTER_PX = 5;
const KEY_STEP = 2;

export function Split({
  direction,
  id,
  initial,
  min,
  minPx,
  children,
}: {
  readonly direction: "horizontal" | "vertical";
  readonly id: string;
  readonly initial: readonly number[];
  readonly min: readonly number[];
  /** Optional per-pane minimum in px (0 or missing = none). */
  readonly minPx?: readonly number[];
  readonly children: ReactNode;
}) {
  const panes = Children.toArray(children);
  const count = panes.length;
  const horizontal = direction === "horizontal";
  const storageKey = `oni.split.${id}`;

  const [sizes, setSizes] = useState<number[]>(() => [...initial]);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; start: number; startSizes: number[]; span: number } | null>(null);
  const pending = useRef<number | null>(null);
  const frame = useRef<number | null>(null);

  // Read after mount so the first render matches the server render.
  useEffect(() => {
    try {
      const stored = parseStored(window.localStorage.getItem(storageKey), count);
      if (stored !== null) setSizes(clampSizes(stored, min));
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, count]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const commit = useCallback(
    (next: number[]) => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      // Lets the chart (and anything else sized by the window) re-fit.
      window.dispatchEvent(new Event("resize"));
    },
    [storageKey],
  );

  // Percent minimums raised to the px minimums at the current container span.
  const effectiveMin = (span: number): number[] =>
    min.map((m, i) => Math.max(m, ((minPx?.[i] ?? 0) / Math.max(1, span)) * 100));
  const currentSpan = (): number => {
    const box = containerRef.current?.getBoundingClientRect();
    const total = box === undefined ? 0 : horizontal ? box.width : box.height;
    return Math.max(1, total - GUTTER_PX * (count - 1));
  };

  const flush = () => {
    frame.current = null;
    const d = drag.current;
    const px = pending.current;
    if (d === null || px === null) return;
    setSizes(applyDrag(d.startSizes, d.index, (px / d.span) * 100, effectiveMin(d.span)));
  };

  const onPointerDown = (index: number) => (event: React.PointerEvent<HTMLDivElement>) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (box === undefined || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const total = horizontal ? box.width : box.height;
    drag.current = {
      index,
      start: horizontal ? event.clientX : event.clientY,
      startSizes: [...sizesRef.current],
      span: Math.max(1, total - GUTTER_PX * (count - 1)),
    };
    pending.current = 0;
    event.preventDefault();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null) return;
    pending.current = (horizontal ? event.clientX : event.clientY) - d.start;
    if (frame.current === null) frame.current = requestAnimationFrame(flush);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    const px = pending.current ?? 0;
    const next = applyDrag(d.startSizes, d.index, (px / d.span) * 100, effectiveMin(d.span));
    drag.current = null;
    pending.current = null;
    frame.current = null;
    setSizes(next);
    commit(next);
  };

  const onKeyDown = (index: number) => (event: React.KeyboardEvent<HTMLDivElement>) => {
    const back = horizontal ? "ArrowLeft" : "ArrowUp";
    const forward = horizontal ? "ArrowRight" : "ArrowDown";
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    const next = applyDrag(sizesRef.current, index, event.key === back ? -KEY_STEP : KEY_STEP, effectiveMin(currentSpan()));
    setSizes(next);
    commit(next);
  };

  const reset = () => {
    const next = [...initial];
    setSizes(next);
    commit(next);
  };

  return (
    <div
      ref={containerRef}
      className={`flex h-full w-full min-h-0 min-w-0 overflow-hidden ${horizontal ? "flex-row" : "flex-col"}`}
    >
      {panes.map((pane, i) => (
        <PaneWithGutter
          key={i}
          last={i === count - 1}
          size={sizes[i] ?? 100 / count}
          horizontal={horizontal}
          value={Math.round(sizes[i] ?? 0)}
          min={min[i] ?? 0}
          minPx={minPx?.[i] ?? 0}
          onPointerDown={onPointerDown(i)}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown(i)}
          onDoubleClick={reset}
        >
          {pane}
        </PaneWithGutter>
      ))}
    </div>
  );
}

function PaneWithGutter({
  children,
  last,
  size,
  horizontal,
  value,
  min,
  minPx,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyDown,
  onDoubleClick,
}: {
  readonly minPx: number;
  readonly children: ReactNode;
  readonly last: boolean;
  readonly size: number;
  readonly horizontal: boolean;
  readonly value: number;
  readonly min: number;
  readonly onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  readonly onDoubleClick: () => void;
}) {
  return (
    <>
      {/* flex-grow proportional to the size, basis 0: the gutters' pixels are taken off first. */}
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={{
          flex: `${size} 1 0%`,
          ...(minPx > 0 ? (horizontal ? { minWidth: minPx } : { minHeight: minPx }) : {}),
        }}
      >
        {children}
      </div>
      {last ? null : (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation={horizontal ? "vertical" : "horizontal"}
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={100}
          title="Drag to resize, double-click to reset"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onKeyDown={onKeyDown}
          onDoubleClick={onDoubleClick}
          style={{ touchAction: "none", flex: `0 0 ${GUTTER_PX}px` }}
          className={`rounded-sm bg-crt-line/40 outline-none transition-colors hover:bg-accent focus-visible:bg-accent-bright active:bg-accent-bright ${
            horizontal ? "cursor-col-resize" : "cursor-row-resize"
          }`}
        />
      )}
    </>
  );
}
