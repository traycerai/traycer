import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import type { StateSnapshot, VirtuosoHandle } from "react-virtuoso";
import { useTileBodyVisible } from "@/components/epic-canvas/hooks/use-tile-body-visible";
import type { ScrollRestorationAdapter } from "@/hooks/scroll/scroll-restoration-adapter";
import { useScrollRestoration } from "@/hooks/scroll/use-scroll-restoration";
import {
  readReadingPosition,
  readingPositionIdentityForTileInstance,
} from "@/lib/reading-position";
import { isTileScrollAnchor } from "@/hooks/scroll/scroll-anchor-types";

interface BundleDiffScrollRestoration {
  readonly virtuosoRef: RefObject<VirtuosoHandle | null>;
  readonly restoreStateFrom: StateSnapshot | undefined;
  readonly isScrolling: (scrolling: boolean) => void;
}

/** Snapshot on isScrolling(false) while visible. getState at hide would read zeroed scrollTop. */
export function useBundleDiffScrollRestoration(
  instanceId: string,
  contentReady: boolean,
): BundleDiffScrollRestoration {
  const visible = useTileBodyVisible();
  const identity = useMemo(
    () => readingPositionIdentityForTileInstance(instanceId),
    [instanceId],
  );
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const lastStateRef = useRef<StateSnapshot | null>(null);

  // Seed the initial mount from any anchor saved before a prior unmount.
  const [restoreStateFrom] = useState<StateSnapshot | undefined>(() => {
    const anchor = readReadingPosition(
      identity,
      "bundle-diff",
      isTileScrollAnchor,
    );
    return anchor !== null && anchor.kind === "bundle-diff"
      ? anchor.virtuosoState
      : undefined;
  });

  const adapter = useMemo<ScrollRestorationAdapter>(
    () => ({
      surfaceKind: "bundle-diff",
      captureAnchor: () => {
        const state = lastStateRef.current;
        if (state === null) return null;
        return { kind: "bundle-diff", virtuosoState: state };
      },
      applyAnchor: (anchor) => {
        if (anchor.kind !== "bundle-diff") return "gave-up";
        const handle = virtuosoRef.current;
        if (handle === null) return "retry";
        handle.scrollTo({ top: anchor.virtuosoState.scrollTop });
        return "applied";
      },
    }),
    [],
  );

  const { commit } = useScrollRestoration(
    identity,
    adapter,
    visible,
    contentReady,
  );

  const isScrolling = useCallback(
    (scrolling: boolean): void => {
      if (scrolling) return;
      virtuosoRef.current?.getState((state) => {
        lastStateRef.current = state;
        commit();
      });
    },
    [commit],
  );

  return { virtuosoRef, restoreStateFrom, isScrolling };
}
