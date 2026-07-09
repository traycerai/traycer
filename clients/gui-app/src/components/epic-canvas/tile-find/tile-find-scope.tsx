import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import {
  TileFindContext,
  type TileFindContextValue,
} from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import { TileFindBar } from "@/components/epic-canvas/tile-find/tile-find-bar";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { cn } from "@/lib/utils";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import {
  createUnavailableTileFindAdapter,
  type TileFindAdapter,
  useTileFindStore,
} from "@/stores/tile-find";

interface TileFindScopeProps {
  readonly node: EpicCanvasTileRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly epicId: string;
  readonly isActive: boolean;
  readonly children: ReactNode;
}

export function TileFindScope(props: TileFindScopeProps): ReactNode {
  const { node, viewTabId, tileId, epicId, isActive, children } = props;
  const paneVisible = usePaneVisible();
  const registerTarget = useTileFindStore((state) => state.registerTarget);
  const unregisterTargetRef = useRef<(() => void) | null>(null);
  const activeAdapterRef = useRef<TileFindAdapter | null>(null);
  const adapterRegistrationIdRef = useRef(0);
  const mountedRef = useRef(false);
  const defaultAdapter = useMemo(
    () =>
      createUnavailableTileFindAdapter({
        tileInstanceId: node.instanceId,
        tileKind: node.type,
        message: null,
      }),
    [node.instanceId, node.type],
  );

  const unregisterCurrentTarget = useCallback((): void => {
    unregisterTargetRef.current?.();
    unregisterTargetRef.current = null;
  }, []);

  const registerAdapterTarget = useCallback(
    (nextAdapter: TileFindAdapter): void => {
      unregisterCurrentTarget();
      activeAdapterRef.current = nextAdapter;
      unregisterTargetRef.current = registerTarget({
        tileInstanceId: node.instanceId,
        contentId: node.id,
        viewTabId,
        tileId,
        epicId,
        tileKind: node.type,
        isEligible: isActive && paneVisible,
        adapter: nextAdapter,
      });
    },
    [
      epicId,
      isActive,
      node.id,
      node.instanceId,
      node.type,
      paneVisible,
      registerTarget,
      tileId,
      unregisterCurrentTarget,
      viewTabId,
    ],
  );

  const registerAdapter = useCallback(
    (nextAdapter: TileFindAdapter) => {
      adapterRegistrationIdRef.current += 1;
      const registrationId = adapterRegistrationIdRef.current;
      registerAdapterTarget(nextAdapter);
      return () => {
        if (adapterRegistrationIdRef.current !== registrationId) return;
        if (!mountedRef.current) return;
        registerAdapterTarget(defaultAdapter);
      };
    },
    [defaultAdapter, registerAdapterTarget],
  );

  const contextValue = useMemo<TileFindContextValue>(
    () => ({
      tileInstanceId: node.instanceId,
      registerAdapter,
    }),
    [node.instanceId, registerAdapter],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      unregisterCurrentTarget();
    };
  }, [unregisterCurrentTarget]);

  useEffect(() => {
    const activeAdapter = activeAdapterRef.current;
    if (
      activeAdapter !== null &&
      activeAdapter.tileInstanceId === node.instanceId
    ) {
      registerAdapterTarget(activeAdapter);
    } else {
      registerAdapterTarget(defaultAdapter);
    }
  }, [defaultAdapter, node.instanceId, registerAdapterTarget]);

  return (
    <TileFindContext.Provider value={contextValue}>
      <div
        className={cn("relative flex h-full min-h-0 w-full flex-1 flex-col")}
        data-testid="tile-find-scope"
        data-tile-find-scope=""
        data-tile-instance-id={node.instanceId}
        data-tile-kind={node.type}
        data-view-tab-id={viewTabId}
        data-tile-id={tileId}
        data-epic-id={epicId}
        data-active={isActive ? "true" : "false"}
      >
        {children}
        <TileFindBar tileInstanceId={node.instanceId} />
      </div>
    </TileFindContext.Provider>
  );
}
