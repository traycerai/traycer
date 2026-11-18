import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";
import {
  TILE_FIND_NO_CAPABILITIES,
  type TileFindAdapter,
  type TileFindInput,
  type TileFindStateSnapshot,
} from "@/stores/tile-find/types";

const DEFAULT_UNAVAILABLE_MESSAGE =
  "Search is not available for this tile yet.";

function createUnavailableTileFindSnapshot(args: {
  readonly tileKind: TileKindId;
  readonly requestId: number;
  readonly query: string;
  readonly matchCase: boolean;
  readonly replaceText: string;
  readonly message: string | null;
}): TileFindStateSnapshot {
  return {
    requestId: args.requestId,
    status: "unavailable",
    capabilities: TILE_FIND_NO_CAPABILITIES,
    query: args.query,
    matchCase: args.matchCase,
    replaceText: args.replaceText,
    current: 0,
    total: 0,
    coverageMessage: args.message ?? unavailableMessageFor(args.tileKind),
    errorMessage: null,
    activeUnitId: null,
    exactHighlight: "none",
  };
}

export function createUnavailableTileFindAdapter(args: {
  readonly tileInstanceId: string;
  readonly tileKind: TileKindId;
  readonly message: string | null;
}): TileFindAdapter {
  let snapshot = createUnavailableTileFindSnapshot({
    tileKind: args.tileKind,
    requestId: 0,
    query: "",
    matchCase: false,
    replaceText: "",
    message: args.message,
  });
  const listeners = new Set<() => void>();

  const publish = (next: TileFindStateSnapshot): void => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const updateFromSearchInput = (input: TileFindInput): void => {
    publish(
      createUnavailableTileFindSnapshot({
        tileKind: args.tileKind,
        requestId: input.requestId,
        query: input.query,
        matchCase: input.matchCase,
        replaceText: snapshot.replaceText,
        message: args.message,
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
    search: updateFromSearchInput,
    next: () => undefined,
    previous: () => undefined,
    clear: () => undefined,
  };
}

function unavailableMessageFor(tileKind: TileKindId): string {
  if (tileKind === "blank") return "Open a tile before using find.";
  return DEFAULT_UNAVAILABLE_MESSAGE;
}
