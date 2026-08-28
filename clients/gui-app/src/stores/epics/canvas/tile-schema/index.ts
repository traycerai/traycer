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
import type { EpicArtifactRef, EpicCanvasTileRef, EpicNodeRef } from "../types";
import { isTileKind, type TileKindId } from "../tile-kinds";
import type { TileKindToRefMap } from "../tile-kind-types";
import {
  recordBackedArtifactTileSchema,
  terminalTileSchema,
  workspaceFileTileSchema,
} from "./artifact-tile";
import { browserSessionTileSchema } from "./browser-tile";
import { gitDiffTileSchema } from "./git-diff-tile";
import { snapshotDiffTileSchema } from "./snapshot-diff-tile";
import { managedCommandOutputTileSchema } from "./managed-command-output-tile";
import { commGraphTileSchema } from "./comm-graph-tile";
import { publishedChatTileSchema } from "./published-chat-tile";
import { prDetailTileSchema } from "./pr-detail-tile";
import { prDiffTileSchema } from "./pr-diff-tile";
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
  "browser-session": browserSessionTileSchema,
  "workspace-file": workspaceFileTileSchema,
  "git-diff": gitDiffTileSchema,
  "snapshot-diff": snapshotDiffTileSchema,
  "managed-command-output": managedCommandOutputTileSchema,
  "comm-graph": commGraphTileSchema,
  "published-chat": publishedChatTileSchema,
  "pr-detail": prDetailTileSchema,
  "pr-diff": prDiffTileSchema,
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

/**
 * True when the kind is backed by a Y.Doc artifact record - and narrows to the
 * ref type those kinds carry, so callers stop re-asserting it.
 *
 * The narrowing is honest rather than a dressed-up cast: `RecordBackedTileRef`
 * is derived from the SAME registry the flag is read from, so a kind that flips
 * `isRecordBacked` and a kind whose ref changes both move the predicate's
 * result type with them.
 */
export function isTileRefRecordBacked(ref: {
  readonly type: unknown;
}): ref is RecordBackedTileRef {
  if (typeof ref.type !== "string") return false;
  if (!isTileKind(ref.type)) return false;
  return TILE_SCHEMAS[ref.type].isRecordBacked;
}

/** Refs of the kinds registered with `isRecordBacked: true`. */
type RecordBackedTileRef = TileKindToRefMap[RecordBackedTileKindId];

type RecordBackedTileKindId = {
  [K in TileKindId]: TileKindToRefMap[K] extends EpicArtifactRef ? K : never;
}[TileKindId];

/**
 * The tile kinds whose ref is an Epic NODE - a chat/artifact, a terminal, or a
 * workspace file. Derived from `TileKindToRefMap` rather than spelled out as a
 * `||` ladder over kind literals, so a new node-backed kind is covered the
 * moment it is registered and a non-node kind cannot be added by hand.
 */
const EPIC_NODE_TILE_KINDS: { readonly [K in EpicNodeTileKindId]: true } = {
  chat: true,
  "terminal-agent": true,
  spec: true,
  ticket: true,
  story: true,
  review: true,
  terminal: true,
  "workspace-file": true,
};

type EpicNodeTileKindId = {
  [K in TileKindId]: TileKindToRefMap[K] extends EpicNodeRef ? K : never;
}[TileKindId];

export function isEpicNodeTileRef(ref: EpicCanvasTileRef): ref is EpicNodeRef {
  return ref.type in EPIC_NODE_TILE_KINDS;
}
