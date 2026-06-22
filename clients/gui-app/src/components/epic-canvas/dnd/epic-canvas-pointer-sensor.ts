/**
 * Single pointer sensor for the root DndContext. It mirrors the stock
 * `PointerSensor` activation (primary button only) and adds the Pierre
 * shadow-DOM bridge: when the pressed draggable is a Pierre host (its
 * `data` is a {@link PierreDragHostData} holder), the activator resolves
 * the file row under the pointer BEFORE activation:
 *
 * - a non-row press leaves `payload` null and returns `false`, vetoing the
 *   drag so Pierre keeps its own click / select gesture;
 * - a row press writes the resolved payload into the holder (read later by
 *   the root drag handlers via `active.data.current`) and re-anchors the
 *   draggable's measured node to the grabbed row, so the drag overlay and
 *   collision rect track the row instead of the whole-tree wrapper.
 *
 * The holder is a stable object whose fields are mutated per press - core
 * keeps `data` in a ref, so mutation is visible to handlers without any
 * re-render. This replaces @dnd-kit/dom's `preventActivation` +
 * `source.element` swap, neither of which exists in @dnd-kit/core.
 *
 * There is intentionally NO keyboard sensor on the root context: every root
 * payload is a typed canvas/header source whose keyboard activation was
 * already suppressed under @dnd-kit/react (see git history of
 * `epic-canvas-dnd-activation.ts`).
 */
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  PointerSensor,
  type Activators,
  type PointerSensorOptions,
  type Sensor,
} from "@dnd-kit/core";
import { extractPierreItemElementFromEvent } from "@/components/epic-canvas/pierre-tree-adapter";
import {
  isRecord,
  type EpicCanvasDragSourceData,
} from "@/components/epic-canvas/dnd/dnd";

/** Mouse-drag activation distance (px), shared by every root drag source. */
export const EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE = 5;

export interface PierreDragHost {
  /** Per-press resolved payload; null while no row press is active. */
  payload: EpicCanvasDragSourceData | null;
  /** Latest row resolver, kept current by the bridge hook's effect. */
  resolve: (event: PointerEvent) => EpicCanvasDragSourceData | null;
  /** Re-points the draggable's measured node at the grabbed row. */
  anchorRowNode: (element: HTMLElement) => void;
}

/**
 * Stable marker every Pierre host draggable passes as its `data`. The live
 * per-press state lives in the module registry below, keyed by draggable id
 * - a plain module map (not React state/refs), so the bridge hook can keep
 * the resolver current from an effect and the activator can mutate the
 * payload during a DOM pointer-down without touching anything the React
 * Compiler considers frozen.
 */
export const PIERRE_HOST_DATA: { readonly pierreHost: true } = {
  pierreHost: true,
};

const PIERRE_DRAG_HOSTS = new Map<string, PierreDragHost>();

export function isPierreHostData(value: unknown): boolean {
  return isRecord(value) && value.pierreHost === true;
}

export function registerPierreDragHost(id: string): PierreDragHost {
  const existing = PIERRE_DRAG_HOSTS.get(id);
  if (existing !== undefined) return existing;
  const host: PierreDragHost = {
    payload: null,
    resolve: () => null,
    anchorRowNode: () => undefined,
  };
  PIERRE_DRAG_HOSTS.set(id, host);
  return host;
}

export function unregisterPierreDragHost(id: string): void {
  PIERRE_DRAG_HOSTS.delete(id);
}

export function getPierreDragHost(id: string): PierreDragHost | null {
  return PIERRE_DRAG_HOSTS.get(id) ?? null;
}

const activators: Activators<PointerSensorOptions> = [
  {
    eventName: "onPointerDown",
    handler: (
      event: ReactPointerEvent,
      options: PointerSensorOptions,
      context,
    ): boolean => {
      const nativeEvent = event.nativeEvent;
      if (!nativeEvent.isPrimary || nativeEvent.button !== 0) {
        return false;
      }
      if (isPierreHostData(context.active.data.current)) {
        const host = getPierreDragHost(String(context.active.id));
        if (host === null) return false;
        host.payload = host.resolve(nativeEvent);
        if (host.payload === null) return false;
        const rowElement = extractPierreItemElementFromEvent({ nativeEvent });
        if (rowElement !== null) host.anchorRowNode(rowElement);
      }
      options.onActivation?.({ event: nativeEvent });
      return true;
    },
  },
];

/**
 * Widen the base's static side to the public `Sensor` contract before
 * extending: `PointerSensor.activators` is declared with two-parameter
 * handlers, so overriding with the three-parameter `Activators` form (the
 * shape the runtime actually invokes, and the one that carries the active
 * draggable context the Pierre branch needs) would otherwise fail the
 * static-side compatibility check.
 */
const BasePointerSensor: Sensor<PointerSensorOptions> = PointerSensor;

export class EpicCanvasPointerSensor extends BasePointerSensor {
  static activators = activators;
}
