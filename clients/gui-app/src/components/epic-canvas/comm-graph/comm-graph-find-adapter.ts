import type {
  TileFindAdapter,
  TileFindCapability,
  TileFindInput,
  TileFindStateSnapshot,
} from "@/stores/tile-find";

const FIND_CAPABILITIES: ReadonlySet<TileFindCapability> = new Set(["find"]);

export interface CommGraphFindNode {
  readonly id: string;
  readonly name: string;
}

export interface CommGraphFindRenderer {
  readonly getNodes: () => ReadonlyArray<CommGraphFindNode>;
  readonly showMatches: (
    agentIds: ReadonlySet<string>,
    requestId: number,
  ) => void;
  readonly frameMatches: (agentIds: ReadonlySet<string>) => void;
  readonly focusMatch: (agentId: string) => void;
  readonly clear: () => void;
}

export function createCommGraphFindAdapter(args: {
  readonly tileInstanceId: string;
  readonly renderer: CommGraphFindRenderer;
}): TileFindAdapter {
  let matches: ReadonlyArray<CommGraphFindNode> = [];
  let activeIndex = -1;
  let snapshot = createSnapshot({
    requestId: 0,
    query: "",
    matchCase: false,
    matches,
    activeIndex,
  });
  const listeners = new Set<() => void>();

  const publish = (next: TileFindStateSnapshot): void => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const publishCurrent = (): void => {
    publish(
      createSnapshot({
        requestId: snapshot.requestId,
        query: snapshot.query,
        matchCase: snapshot.matchCase,
        matches,
        activeIndex,
      }),
    );
  };

  const search = (input: TileFindInput): void => {
    const needle = normalize(input.query, input.matchCase);
    matches =
      needle.length === 0
        ? []
        : args.renderer
            .getNodes()
            .filter((node) =>
              normalize(node.name, input.matchCase).includes(needle),
            );
    activeIndex = matches.length > 0 ? 0 : -1;
    const matchIds = new Set(matches.map((match) => match.id));
    args.renderer.showMatches(matchIds, input.requestId);
    if (matchIds.size > 0) args.renderer.frameMatches(matchIds);
    publish(
      createSnapshot({
        requestId: input.requestId,
        query: input.query,
        matchCase: input.matchCase,
        matches,
        activeIndex,
      }),
    );
  };

  const advance = (direction: 1 | -1): void => {
    if (matches.length === 0) return;
    activeIndex = (activeIndex + direction + matches.length) % matches.length;
    const activeMatch = matches.at(activeIndex);
    if (activeMatch === undefined) return;
    args.renderer.focusMatch(activeMatch.id);
    publishCurrent();
  };

  const clear = (): void => {
    matches = [];
    activeIndex = -1;
    args.renderer.clear();
    publish(
      createSnapshot({
        requestId: snapshot.requestId,
        query: "",
        matchCase: snapshot.matchCase,
        matches,
        activeIndex,
      }),
    );
  };

  return {
    tileInstanceId: args.tileInstanceId,
    tileKind: "comm-graph",
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

function normalize(value: string, matchCase: boolean): string {
  return matchCase ? value : value.toLocaleLowerCase();
}

function createSnapshot(args: {
  readonly requestId: number;
  readonly query: string;
  readonly matchCase: boolean;
  readonly matches: ReadonlyArray<CommGraphFindNode>;
  readonly activeIndex: number;
}): TileFindStateSnapshot {
  const activeMatch = args.matches.at(args.activeIndex) ?? null;
  return {
    requestId: args.requestId,
    status: "ready",
    capabilities: FIND_CAPABILITIES,
    query: args.query,
    matchCase: args.matchCase,
    replaceText: "",
    current: activeMatch === null ? 0 : args.activeIndex + 1,
    total: args.matches.length,
    coverageMessage: null,
    errorMessage: null,
    activeUnitId: activeMatch?.id ?? null,
    exactHighlight: args.matches.length > 0 ? "painted" : "none",
  };
}
