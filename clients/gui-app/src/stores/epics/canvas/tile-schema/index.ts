/**
 * Canvas tile-kind schema registry - React-free.
 *
 * Owns persistence for every `EpicCanvasTileRef` kind: parse (rehydrate),
 * serialize (persist), and the `isRecordBacked` flag (true => Y.Doc
 * artifact; consumed by route-sync deletion). Keyed by `TileKindId` via a
 * `{ [K in TileKindId]: ... }` mapped type, so a missing kind fails the
 * build. `store.ts` and `dnd.ts` dispatch through here instead of
 * hand-rolling per-kind parse/serialize.
 */
import type { DesktopJsonValue } from "@/lib/windows/types";
import type { EpicCanvasTileRef } from "../types";
import { isTileKind, type TileKindId } from "../tile-kinds";
import type { TileKindToRefMap } from "../tile-kind-types";
import {
  recordBackedArtifactTileSchema,
  terminalTileSchema,
  workspaceFileTileSchema,
} from "./artifact-tile";
import { gitDiffTileSchema } from "./git-diff-tile";
import { snapshotDiffTileSchema } from "./snapshot-diff-tile";
import { blankTileSchema } from "./blank-tile";

export interface TileSchema<R extends EpicCanvasTileRef> {
  readonly parse: (value: unknown) => R | null;
  readonly serialize: (ref: R) => DesktopJsonValue;
  readonly isRecordBacked: boolean;
}

type TileSchemaRegistry = {
  readonly [K in TileKindId]: TileSchema<TileKindToRefMap[K]>;
};

const TILE_SCHEMAS: TileSchemaRegistry = {
  chat: recordBackedArtifactTileSchema,
  "terminal-agent": recordBackedArtifactTileSchema,
  spec: recordBackedArtifactTileSchema,
  ticket: recordBackedArtifactTileSchema,
  story: recordBackedArtifactTileSchema,
  review: recordBackedArtifactTileSchema,
  terminal: terminalTileSchema,
  "workspace-file": workspaceFileTileSchema,
  "git-diff": gitDiffTileSchema,
  "snapshot-diff": snapshotDiffTileSchema,
  blank: blankTileSchema,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseWithSchema<K extends TileKindId>(
  kind: K,
  value: unknown,
): TileKindToRefMap[K] | null {
  return TILE_SCHEMAS[kind].parse(value);
}

function serializeWithSchema<K extends TileKindId>(
  kind: K,
  ref: TileKindToRefMap[K],
): DesktopJsonValue {
  return TILE_SCHEMAS[kind].serialize(ref);
}

/** Rehydrate any persisted tile ref; unknown kinds yield `null`. */
export function parseTileRef(value: unknown): EpicCanvasTileRef | null {
  if (!isRecord(value)) return null;
  if (!isTileKind(value.type)) return null;
  return parseWithSchema(value.type, value);
}

export function serializeTileRef(ref: EpicCanvasTileRef): DesktopJsonValue {
  return serializeWithSchema(ref.type, ref);
}

/** True when the kind is backed by a Y.Doc artifact record. */
export function isTileRefRecordBacked(ref: {
  readonly type: unknown;
}): boolean {
  if (typeof ref.type !== "string") return false;
  if (!isTileKind(ref.type)) return false;
  return TILE_SCHEMAS[ref.type].isRecordBacked;
}
