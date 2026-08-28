import { useEffect, useMemo, type ReactNode } from "react";
import { useRegisterTileFindAdapter } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { isSameBrowserViewTile } from "@/lib/browser-view/tiles/browser-view-keys";
import type {
  BrowserViewBridge,
  BrowserViewFindChange,
  BrowserViewTileKey,
} from "@traycer-clients/shared/platform/browser-view";
import type {
  TileFindAdapter,
  TileFindCapability,
  TileFindInput,
  TileFindStateSnapshot,
} from "@/stores/tile-find";

interface BrowserTileFindAdapterBridgeProps {
  readonly browserView: BrowserViewBridge | null;
  readonly tileKey: BrowserViewTileKey;
}

interface BrowserTileFindAdapter extends TileFindAdapter {
  applyChange(change: BrowserViewFindChange): void;
}

const BROWSER_FIND_CAPABILITIES = new Set<TileFindCapability>(["find"]);

export function BrowserTileFindAdapterBridge(
  props: BrowserTileFindAdapterBridgeProps,
): ReactNode {
  const adapter = useMemo(
    () =>
      createBrowserTileFindAdapter({
        browserView: props.browserView,
        tileKey: props.tileKey,
      }),
    [props.browserView, props.tileKey],
  );

  useEffect(() => {
    const browserView = props.browserView;
    if (browserView === null) return;
    const subscription = browserView.onFindChange((change) => {
      if (!isSameBrowserViewTile(change, props.tileKey)) return;
      adapter.applyChange(change);
    });
    return () => {
      subscription.dispose();
    };
  }, [adapter, props.browserView, props.tileKey]);

  useRegisterTileFindAdapter(adapter);
  return null;
}

function createBrowserTileFindAdapter(args: {
  readonly browserView: BrowserViewBridge | null;
  readonly tileKey: BrowserViewTileKey;
}): BrowserTileFindAdapter {
  const listeners = new Set<() => void>();
  let snapshot = createBrowserFindSnapshot({
    requestId: 0,
    status: args.browserView === null ? "unavailable" : "idle",
    query: "",
    matchCase: false,
    current: 0,
    total: 0,
    coverageMessage:
      args.browserView === null
        ? "Native browser views are unavailable."
        : null,
    errorMessage: null,
    exactHighlight: "none",
  });

  const publish = (next: TileFindStateSnapshot): void => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const runSearch = (
    input: TileFindInput,
    forward: boolean,
    findNext: boolean,
  ): void => {
    if (args.browserView === null) {
      publishUnavailable(input);
      return;
    }
    if (input.query.length === 0) {
      clearWithRequest(input.requestId);
      return;
    }
    publish(
      createBrowserFindSnapshot({
        requestId: input.requestId,
        status: "searching",
        query: input.query,
        matchCase: input.matchCase,
        current: 0,
        total: 0,
        coverageMessage: null,
        errorMessage: null,
        exactHighlight: "pending",
      }),
    );
    void args.browserView
      .findInPage({
        ...args.tileKey,
        requestId: input.requestId,
        query: input.query,
        matchCase: input.matchCase,
        forward,
        findNext,
      })
      .catch(ignoreError);
  };

  const navigate = (forward: boolean): void => {
    if (snapshot.query.length === 0) return;
    runSearch(
      {
        requestId: snapshot.requestId,
        query: snapshot.query,
        matchCase: snapshot.matchCase,
      },
      forward,
      true,
    );
  };

  const publishUnavailable = (input: TileFindInput): void => {
    publish(
      createBrowserFindSnapshot({
        requestId: input.requestId,
        status: "unavailable",
        query: input.query,
        matchCase: input.matchCase,
        current: 0,
        total: 0,
        coverageMessage: "Native browser views are unavailable.",
        errorMessage: null,
        exactHighlight: "none",
      }),
    );
  };

  const clearWithRequest = (requestId: number): void => {
    void args.browserView
      ?.stopFindInPage({ ...args.tileKey, requestId })
      .catch(ignoreError);
    publish(
      createBrowserFindSnapshot({
        requestId,
        status: args.browserView === null ? "unavailable" : "idle",
        query: "",
        matchCase: snapshot.matchCase,
        current: 0,
        total: 0,
        coverageMessage:
          args.browserView === null
            ? "Native browser views are unavailable."
            : null,
        errorMessage: null,
        exactHighlight: "none",
      }),
    );
  };

  return {
    tileInstanceId: args.tileKey.tileInstanceId,
    tileKind: "browser-session",
    replace: null,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    search: (input) => {
      runSearch(input, true, false);
    },
    next: () => {
      navigate(true);
    },
    previous: () => {
      navigate(false);
    },
    clear: () => {
      clearWithRequest(snapshot.requestId);
    },
    applyChange: (change) => {
      if (change.requestId < snapshot.requestId) return;
      publish(
        createBrowserFindSnapshot({
          requestId: change.requestId,
          status: change.status,
          query: change.query,
          matchCase: change.matchCase,
          current: change.current,
          total: change.total,
          coverageMessage: null,
          errorMessage: change.errorMessage,
          exactHighlight: change.total > 0 ? "painted" : "none",
        }),
      );
    },
  };
}

function createBrowserFindSnapshot(args: {
  readonly requestId: number;
  readonly status: TileFindStateSnapshot["status"];
  readonly query: string;
  readonly matchCase: boolean;
  readonly current: number;
  readonly total: number;
  readonly coverageMessage: string | null;
  readonly errorMessage: string | null;
  readonly exactHighlight: TileFindStateSnapshot["exactHighlight"];
}): TileFindStateSnapshot {
  return {
    requestId: args.requestId,
    status: args.status,
    capabilities: BROWSER_FIND_CAPABILITIES,
    query: args.query,
    matchCase: args.matchCase,
    replaceText: "",
    current: args.current,
    total: args.total,
    coverageMessage: args.coverageMessage,
    errorMessage: args.errorMessage,
    activeUnitId: args.total > 0 ? `browser-page:${args.requestId}` : null,
    exactHighlight: args.exactHighlight,
  };
}
