import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";

export type TileFindCapability = "find" | "replace" | "replaceAll";

export type TileFindStatus =
  | "idle"
  | "searching"
  | "ready"
  | "partial"
  | "unavailable"
  | "error";

export type TileFindExactHighlight = "none" | "pending" | "painted";

export interface TileFindStateSnapshot {
  readonly requestId: number;
  readonly status: TileFindStatus;
  readonly capabilities: ReadonlySet<TileFindCapability>;
  readonly query: string;
  readonly matchCase: boolean;
  readonly replaceText: string;
  readonly current: number;
  readonly total: number;
  readonly coverageMessage: string | null;
  readonly errorMessage: string | null;
  readonly activeUnitId: string | null;
  readonly exactHighlight: TileFindExactHighlight;
}

export interface TileFindInput {
  readonly requestId: number;
  readonly query: string;
  readonly matchCase: boolean;
}

export interface TileReplaceInput extends TileFindInput {
  readonly replaceText: string;
}

export interface TileFindAdapter {
  readonly tileInstanceId: string;
  readonly tileKind: TileKindId;
  getSnapshot(): TileFindStateSnapshot;
  subscribe(listener: () => void): () => void;
  search(input: TileFindInput): void | Promise<void>;
  next(): void | Promise<void>;
  previous(): void | Promise<void>;
  clear(): void;
  replaceCurrent(input: TileReplaceInput): void | Promise<void>;
  replaceAll(input: TileReplaceInput): void | Promise<void>;
}

export interface TileFindTargetRegistration {
  readonly tileInstanceId: string;
  readonly contentId: string;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly epicId: string;
  readonly tileKind: TileKindId;
  readonly isEligible: boolean;
  readonly adapter: TileFindAdapter;
}

export interface TileFindTargetRecord extends TileFindTargetRegistration {
  readonly registeredAt: number;
}

export interface TileFindActiveOwner {
  readonly tileInstanceId: string;
  readonly contentId: string;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly epicId: string;
  readonly tileKind: TileKindId;
}

export type TileFindOwnerBlockerReason =
  | "non-canvas-route"
  | "command-palette"
  | "system-overlay"
  | "app-dialog"
  | "desktop-dialog"
  | "migration-dialog"
  | "notification-popover"
  | "dom-dialog";

export interface TileFindOwnerBlocker {
  readonly reason: TileFindOwnerBlockerReason;
  readonly ownerId: string;
}

export interface TileFindUiState {
  readonly isOpen: boolean;
  readonly query: string;
  readonly matchCase: boolean;
  readonly replaceText: string;
  readonly replaceExpanded: boolean;
  readonly currentRequestId: number;
  readonly focusRequestNonce: number;
  readonly lastSnapshot: TileFindStateSnapshot;
}

export const TILE_FIND_NO_CAPABILITIES: ReadonlySet<TileFindCapability> =
  new Set<TileFindCapability>();
