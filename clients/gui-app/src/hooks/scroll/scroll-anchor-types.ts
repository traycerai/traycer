import type { StateSnapshot } from "react-virtuoso";

export type TileScrollAnchor = NativeScrollAnchor | BundleDiffScrollAnchor;

export interface NativeScrollAnchor {
  readonly kind: "native";
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
}

export interface BundleDiffScrollAnchor {
  readonly kind: "bundle-diff";
  readonly virtuosoState: StateSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isTileScrollAnchor(value: unknown): value is TileScrollAnchor {
  if (!isRecord(value)) return false;
  if (value.kind === "native") {
    return (
      isFiniteNumber(value.scrollTop) &&
      isFiniteNumber(value.scrollLeft) &&
      isFiniteNumber(value.scrollHeight) &&
      isFiniteNumber(value.scrollWidth)
    );
  }
  if (value.kind !== "bundle-diff" || !isRecord(value.virtuosoState)) {
    return false;
  }
  return (
    isFiniteNumber(value.virtuosoState.scrollTop) &&
    Array.isArray(value.virtuosoState.ranges)
  );
}
