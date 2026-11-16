import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { mapGridSize, snapMapPoint } from "@/lib/map-grid";
import type { MapPoint } from "@/lib/service-map";

export function MapDraggable({
  point,
  zoom,
  onMove,
  onCommit,
  onCancel,
  children,
  style,
  label,
  handleOnly = false,
  gridOffset,
}: {
  point: MapPoint;
  zoom: number;
  onMove: (point: MapPoint) => void;
  onCommit: (point: MapPoint) => void;
  onCancel: () => void;
  children: ReactNode;
  style?: CSSProperties;
  label: string;
  handleOnly?: boolean;
  gridOffset?: MapPoint;
}) {
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    origin: MapPoint;
    latest: MapPoint;
    moved: boolean;
    scale: number;
    scroll: HTMLElement | null;
    scrollX: number;
    scrollY: number;
  } | null>(null);
  const frame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  function clearFrame() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }
  function finish() {
    const current = drag.current;
    clearFrame();
    drag.current = null;
    setDragging(false);
    if (current?.moved) {
      onMove(current.latest);
      onCommit(current.latest);
    }
  }
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const bounded = (x: number, y: number) => snapMapPoint(x, y, gridOffset);
  function cancel() {
    clearFrame();
    const current = drag.current;
    if (current?.moved) onCancel();
    drag.current = null;
    setDragging(false);
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: This groups draggable map content, not form controls.
    <div
      role="group"
      aria-label={label}
      aria-description="Drag to move. Focus a card or group title and use Alt plus arrow keys to move it."
      className="absolute select-none"
      style={{
        ...style,
        left: point.x,
        top: point.y,
        zIndex: dragging ? 10 : undefined,
        touchAction: "none",
      }}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (
          event.button !== 0 ||
          target.closest("[data-map-no-drag]") ||
          (handleOnly && !target.closest("[data-map-handle]"))
        )
          return;
        event.stopPropagation();
        suppressClick.current = false;
        const scroll = event.currentTarget.closest("section");
        drag.current = {
          scale: zoom,
          scroll,
          scrollX: scroll?.scrollLeft ?? 0,
          scrollY: scroll?.scrollTop ?? 0,
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          origin: point,
          latest: point,
          moved: false,
        };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        event.stopPropagation();
        const dx = event.clientX - current.x,
          dy = event.clientY - current.y;
        if (!current.moved && Math.hypot(dx, dy) < 5) return;
        if (!current.moved) {
          current.moved = true;
          suppressClick.current = true;
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        current.latest = bounded(
          current.origin.x +
            (dx + (current.scroll?.scrollLeft ?? 0) - current.scrollX) /
              current.scale,
          current.origin.y +
            (dy + (current.scroll?.scrollTop ?? 0) - current.scrollY) /
              current.scale,
        );
        if (frame.current === null)
          frame.current = requestAnimationFrame(() => {
            frame.current = null;
            if (drag.current?.moved) onMove(drag.current.latest);
          });
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        event.stopPropagation();
        if (current.moved)
          current.latest = bounded(
            current.origin.x +
              (event.clientX -
                current.x +
                (current.scroll?.scrollLeft ?? 0) -
                current.scrollX) /
                current.scale,
            current.origin.y +
              (event.clientY -
                current.y +
                (current.scroll?.scrollTop ?? 0) -
                current.scrollY) /
                current.scale,
          );
        finish();
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={(event) => {
        // Touch starts with implicit capture on the inner button. Moving that
        // capture to this wrapper must not cancel the drag via a bubbled event.
        if (event.target === event.currentTarget) finish();
      }}
      onClickCapture={(event) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && drag.current) {
          cancel();
          return;
        }
        if (
          !event.altKey ||
          !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
            event.key,
          )
        )
          return;
        if ((event.target as HTMLElement).closest("[data-map-no-drag]")) return;
        event.preventDefault();
        event.stopPropagation();
        const step = mapGridSize * (event.shiftKey ? 4 : 1);
        const next = bounded(
          point.x +
            (event.key === "ArrowLeft"
              ? -step
              : event.key === "ArrowRight"
                ? step
                : 0),
          point.y +
            (event.key === "ArrowUp"
              ? -step
              : event.key === "ArrowDown"
                ? step
                : 0),
        );
        onMove(next);
        onCommit(next);
      }}
    >
      {children}
    </div>
  );
}
