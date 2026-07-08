import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useHostClient } from "@/lib/host";
import { useOpenEpicId } from "@/lib/epic-selectors";
import {
  MarkdownLinkContext,
  type MarkdownLinkPolicy,
} from "@/markdown/links/markdown-link-context";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { buildChatLinkPolicy } from "@/components/chat/build-chat-link-policy";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

interface ChatMarkdownLinkProviderProps {
  /** The chat tab whose group a file link opens its new tab into. */
  readonly tabId: string;
  /** Host the chat is bound to; file tabs are stamped with it for life. */
  readonly hostId: string | null;
  /** The chat's working directories, used to resolve a link path to a file. */
  readonly workspaceRoots: ReadonlyArray<string>;
  readonly children: ReactNode;
}

/**
 * Wires the chat's file-link handler into context. The link-resolution policy
 * itself lives in `buildChatLinkPolicy` (a pure builder, unit-testable without a
 * React tree); this component owns only the React lifecycle the policy needs:
 * the projection-wait cancel handle and the disposed flag, plus the unmount
 * effect that tears down an in-flight wait. Those are exposed to the builder as
 * accessor deps so a superseding click or an unmount can cancel a wait without
 * the builder owning hooks. See `buildChatLinkPolicy` for the link semantics.
 */
export function ChatMarkdownLinkProvider({
  tabId,
  hostId,
  workspaceRoots,
  children,
}: ChatMarkdownLinkProviderProps) {
  const tileNavigation = useEpicTileNavigation();
  const previewTileInTab = useCallback(
    (targetTabId: string, node: EpicCanvasTileRef): void => {
      tileNavigation.openTilePreviewInTab(targetTabId, node);
    },
    [tileNavigation],
  );
  const queryClient = useQueryClient();
  const client = useHostClient();
  const navigate = useNavigate();
  const activeHostId = useReactiveActiveHostId();
  const openEpicId = useOpenEpicId();
  const epicHandle = useOpenEpicHandle();

  // The same-epic open kicks off a projection wait (`store.subscribe` + a 30s
  // timeout) that settles asynchronously. Retain its cancel handle so a
  // superseding click or an unmount tears it down — otherwise it can fire into
  // a torn-down tab. `disposedRef` additionally suppresses the deferred opens
  // (the resolve `.then` and the wait's `onUnavailable`) once unmounted, since
  // cancelling the wait itself drives `onUnavailable` → the file preview.
  const pendingProjectedOpenCancelRef = useRef<(() => void) | null>(null);
  const disposedRef = useRef(false);
  // Monotonic supersession token: each click bumps it so a slow earlier RPC
  // that settles after a newer click drops instead of clobbering it.
  const clickTokenRef = useRef(0);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      pendingProjectedOpenCancelRef.current?.();
      pendingProjectedOpenCancelRef.current = null;
    };
  }, []);

  const runChatLink = useMemo(
    () =>
      buildChatLinkPolicy({
        tabId,
        hostId,
        workspaceRoots,
        activeHostId,
        openEpicId,
        epicHandle,
        queryClient,
        client,
        navigate,
        previewTileInTab,
      }),
    [
      activeHostId,
      client,
      epicHandle,
      hostId,
      navigate,
      openEpicId,
      previewTileInTab,
      queryClient,
      tabId,
      workspaceRoots,
    ],
  );

  const linkPolicy = useMemo<MarkdownLinkPolicy>(
    () => ({
      // The lifecycle accessors are built HERE, inside the click handler, so
      // reading the refs' `.current` happens at click / wait-settle time (an
      // event context) — never during render. That keeps `buildChatLinkPolicy`
      // a pure, hookless function while the cancel handle + disposed flag stay
      // owned by this component's refs and unmount effect.
      openFileLink: (link) =>
        runChatLink(link, {
          isDisposed: () => disposedRef.current,
          getPendingProjectedOpenCancel: () =>
            pendingProjectedOpenCancelRef.current,
          setPendingProjectedOpenCancel: (cancel) => {
            pendingProjectedOpenCancelRef.current = cancel;
          },
          beginClick: () => {
            clickTokenRef.current += 1;
            return clickTokenRef.current;
          },
          isCurrent: (token) => token === clickTokenRef.current,
        }),
    }),
    [runChatLink],
  );

  return (
    <MarkdownLinkContext.Provider value={linkPolicy}>
      {children}
    </MarkdownLinkContext.Provider>
  );
}
