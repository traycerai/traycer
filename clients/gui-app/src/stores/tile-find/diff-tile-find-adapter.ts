import {
  buildDiffFindMetadataUnits,
  buildDiffFindIndexFromPatch,
  findDiffMatches,
  type DiffFindIndex,
  type DiffFindMatch,
  type DiffFindMetadataUnitInput,
} from "@/lib/diff/diff-find";
import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";
import {
  TILE_FIND_NO_CAPABILITIES,
  type TileFindAdapter,
  type TileFindCapability,
  type TileFindExactHighlight,
  type TileFindInput,
  type TileFindStateSnapshot,
  type TileFindStatus,
} from "@/stores/tile-find/types";

const FIND_CAPABILITIES: ReadonlySet<TileFindCapability> =
  new Set<TileFindCapability>(["find"]);

export type DiffTileFindSourceKind =
  "loaded" | "metadata-partial" | "loading" | "missing";

export interface DiffTileFindSource {
  readonly kind: DiffTileFindSourceKind;
  readonly index: DiffFindIndex | null;
  readonly coverageMessage: string | null;
}

export interface DiffTileFindRenderer {
  reveal(
    matches: ReadonlyArray<DiffFindMatch>,
    activeMatch: DiffFindMatch | null,
  ): TileFindExactHighlight;
  clear(): void;
}

export function createLoadedDiffTileFindSource(args: {
  readonly patch: string;
  readonly metadataUnits: ReadonlyArray<DiffFindMetadataUnitInput>;
  readonly cacheKey: string;
  readonly isPartial: boolean;
  readonly partialMessage: string | null;
}): DiffTileFindSource {
  return {
    kind: args.isPartial ? "metadata-partial" : "loaded",
    index: buildDiffFindIndexFromPatch({
      patch: args.patch,
      metadataUnits: args.metadataUnits,
      cacheKey: args.cacheKey,
      unitScopeId: null,
    }),
    coverageMessage: args.isPartial ? args.partialMessage : null,
  };
}

export function createDiffTileFindSourceFromIndex(args: {
  readonly index: DiffFindIndex;
  readonly isPartial: boolean;
  readonly coverageMessage: string | null;
}): DiffTileFindSource {
  return {
    kind: args.isPartial ? "metadata-partial" : "loaded",
    index: args.index,
    coverageMessage: args.isPartial ? args.coverageMessage : null,
  };
}

export function createMetadataOnlyDiffTileFindSource(args: {
  readonly metadataUnits: ReadonlyArray<DiffFindMetadataUnitInput>;
  readonly coverageMessage: string;
}): DiffTileFindSource {
  return {
    kind: "metadata-partial",
    index: {
      units: buildDiffFindMetadataUnits(args.metadataUnits),
    },
    coverageMessage: args.coverageMessage,
  };
}

export function createLoadingDiffTileFindSource(args: {
  readonly coverageMessage: string;
}): DiffTileFindSource {
  return {
    kind: "loading",
    index: null,
    coverageMessage: args.coverageMessage,
  };
}

export function createMissingDiffTileFindSource(args: {
  readonly coverageMessage: string;
}): DiffTileFindSource {
  return {
    kind: "missing",
    index: null,
    coverageMessage: args.coverageMessage,
  };
}

export function createDiffTileFindAdapter(args: {
  readonly tileInstanceId: string;
  readonly tileKind: TileKindId;
  readonly source: DiffTileFindSource;
  readonly renderer: DiffTileFindRenderer | null;
}): TileFindAdapter {
  let matches: ReadonlyArray<DiffFindMatch> = [];
  let activeIndex = -1;
  let snapshot = snapshotForSource({
    tileInstanceId: args.tileInstanceId,
    tileKind: args.tileKind,
    source: args.source,
    requestId: 0,
    query: "",
    matchCase: false,
    replaceText: "",
    matches,
    activeIndex,
    exactHighlight: "none",
  });
  const listeners = new Set<() => void>();

  const publish = (next: TileFindStateSnapshot): void => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const publishCurrent = (exactHighlight: TileFindExactHighlight): void => {
    publish(
      snapshotForSource({
        tileInstanceId: args.tileInstanceId,
        tileKind: args.tileKind,
        source: args.source,
        requestId: snapshot.requestId,
        query: snapshot.query,
        matchCase: snapshot.matchCase,
        replaceText: snapshot.replaceText,
        matches,
        activeIndex,
        exactHighlight,
      }),
    );
  };

  const revealCurrent = (): TileFindExactHighlight => {
    const activeMatch = diffMatchAt(matches, activeIndex);
    if (args.renderer === null) return "none";
    if (activeMatch === null) {
      args.renderer.clear();
      return "none";
    }
    return args.renderer.reveal(matches, activeMatch);
  };

  const search = (input: TileFindInput): void => {
    const index = args.source.index;
    if (index === null) {
      matches = [];
      activeIndex = -1;
      args.renderer?.clear();
      publish(
        snapshotForSource({
          tileInstanceId: args.tileInstanceId,
          tileKind: args.tileKind,
          source: args.source,
          requestId: input.requestId,
          query: input.query,
          matchCase: input.matchCase,
          replaceText: snapshot.replaceText,
          matches,
          activeIndex,
          exactHighlight: "none",
        }),
      );
      return;
    }

    matches = findDiffMatches({
      units: index.units,
      query: input.query,
      matchCase: input.matchCase,
    });
    activeIndex = matches.length > 0 ? 0 : -1;
    publish(
      snapshotForSource({
        tileInstanceId: args.tileInstanceId,
        tileKind: args.tileKind,
        source: args.source,
        requestId: input.requestId,
        query: input.query,
        matchCase: input.matchCase,
        replaceText: snapshot.replaceText,
        matches,
        activeIndex,
        exactHighlight: revealCurrent(),
      }),
    );
  };

  const advance = (direction: 1 | -1): void => {
    if (matches.length === 0) return;
    activeIndex = (activeIndex + direction + matches.length) % matches.length;
    publishCurrent(revealCurrent());
  };

  const clear = (): void => {
    matches = [];
    activeIndex = -1;
    args.renderer?.clear();
    publish(
      snapshotForSource({
        tileInstanceId: args.tileInstanceId,
        tileKind: args.tileKind,
        source: args.source,
        requestId: snapshot.requestId,
        query: "",
        matchCase: snapshot.matchCase,
        replaceText: snapshot.replaceText,
        matches,
        activeIndex,
        exactHighlight: "none",
      }),
    );
  };

  return {
    tileInstanceId: args.tileInstanceId,
    tileKind: args.tileKind,
    replace: null,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    search,
    next: () => advance(1),
    previous: () => advance(-1),
    clear,
  };
}

function snapshotForSource(args: {
  readonly tileInstanceId: string;
  readonly tileKind: TileKindId;
  readonly source: DiffTileFindSource;
  readonly requestId: number;
  readonly query: string;
  readonly matchCase: boolean;
  readonly replaceText: string;
  readonly matches: ReadonlyArray<DiffFindMatch>;
  readonly activeIndex: number;
  readonly exactHighlight: TileFindExactHighlight;
}): TileFindStateSnapshot {
  const activeMatch = diffMatchAt(args.matches, args.activeIndex);
  return {
    requestId: args.requestId,
    status: statusForSource(args.source),
    capabilities: capabilitiesForSource(args.source),
    query: args.query,
    matchCase: args.matchCase,
    replaceText: args.replaceText,
    current: activeMatch === null ? 0 : args.activeIndex + 1,
    total: args.matches.length,
    coverageMessage: args.source.coverageMessage,
    errorMessage: null,
    activeUnitId: activeMatch === null ? null : activeMatch.unit.id,
    exactHighlight: args.exactHighlight,
  };
}

function diffMatchAt(
  matches: ReadonlyArray<DiffFindMatch>,
  index: number,
): DiffFindMatch | null {
  if (index < 0) return null;
  return matches.at(index) ?? null;
}

function statusForSource(source: DiffTileFindSource): TileFindStatus {
  if (source.kind === "loaded") return "ready";
  if (source.kind === "metadata-partial") return "partial";
  return "unavailable";
}

function capabilitiesForSource(
  source: DiffTileFindSource,
): ReadonlySet<TileFindCapability> {
  if (source.index === null) return TILE_FIND_NO_CAPABILITIES;
  return FIND_CAPABILITIES;
}
