/**
 * Residual-capture levels. Do not reuse an id with changed semantics. Do not put load-bearing chat-level data on `chat-shard` (clone re-publication drops the shard bag).
 * Publisher-derived head locations (`chatHeadPartSchema` elements, `cdc`, `hostPrivateShard`) carry no bag. Clone importers must blank `hostPrivate`.
 */
export type CapturedResidualLevelId =
  | "head"
  | "shard"
  | "core"
  | "core.lifecycle"
  | "core.settings"
  | "hostPrivate";

export type CapturedResidualLevel = {
  readonly id: CapturedResidualLevelId;
  /** Path from the owning record root; `[]` is the record. `hostPrivate` is relative to whichever record carries it. */
  readonly path: readonly string[];
};

export const CAPTURED_RESIDUAL_LEVELS: readonly CapturedResidualLevel[] = [
  { id: "head", path: [] },
  { id: "shard", path: [] },
  { id: "core", path: ["core"] },
  { id: "core.lifecycle", path: ["core", "lifecycle"] },
  { id: "core.settings", path: ["core", "settings"] },
  { id: "hostPrivate", path: ["hostPrivate"] },
];
