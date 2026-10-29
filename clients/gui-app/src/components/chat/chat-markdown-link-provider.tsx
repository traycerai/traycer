import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useOpenEpicId } from "@/lib/epic-selectors";
import {
  MarkdownLinkContext,
  type MarkdownLinkPolicy,
} from "@/markdown/links/markdown-link-context";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { buildChatLinkPolicy } from "@/components/chat/build-chat-link-policy";
import { toast } from "sonner";

interface ChatMarkdownLinkProviderProps {
  /** The chat tab whose group a file link opens its new tab into. */
  readonly tabId: string;
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
  workspaceRoots,
  children,
}: ChatMarkdownLinkProviderProps) {
  const tabHostId = useTabHostId();
  const openEpicId = useOpenEpicId();
  const epicHandle = useOpenEpicHandle();
  return (
    <MarkdownLinkPolicyProvider
      tabId={tabId}
      tabHostId={tabHostId}
      workspaceRoots={workspaceRoots}
      openEpic={{ epicId: openEpicId, handle: epicHandle }}
    >
      {children}
    </MarkdownLinkPolicyProvider>
  );
}

/**
 * The chat link policy on a surface that is no task and has no working
 * directories (a bot's channel): an artifact link opens in its task, as a
 * link to another task does in a chat tile, and a plain file link opens
 * nothing.
 */
export function TasklessMarkdownLinkProvider(props: {
  readonly tabId: string;
  /** The host the surface is bound to; artifacts are resolved through it. */
  readonly tabHostId: string;
  readonly children: ReactNode;
}) {
  return (
    <MarkdownLinkPolicyProvider
      tabId={props.tabId}
      tabHostId={props.tabHostId}
      workspaceRoots={null}
      openEpic={null}
    >
      {props.children}
    </MarkdownLinkPolicyProvider>
  );
}

function MarkdownLinkPolicyProvider({
  tabId,
  tabHostId,
  workspaceRoots,
  openEpic,
  children,
}: {
  readonly tabId: string;
  readonly tabHostId: string;
  /** `null`: no working directories, so no file link opens. */
  readonly workspaceRoots: ReadonlyArray<string> | null;
  /** The task the surface is in; `null` outside one. */
  readonly openEpic: {
    readonly epicId: string;
    readonly handle: OpenEpicStoreHandle;
  } | null;
  readonly children: ReactNode;
}) {
  const { openTile } = useEpicTileNavigation();
  const queryClient = useQueryClient();
  const tabHostClient = useTabHostClient();
  const navigate = useNavigate();
  const openEpicId = openEpic?.epicId ?? "";
  const epicHandle = openEpic?.handle ?? null;
  const opensFiles = workspaceRoots !== null;

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

  const supersedePendingFileLink = useCallback((): number => {
    clickTokenRef.current += 1;
    pendingProjectedOpenCancelRef.current?.();
    pendingProjectedOpenCancelRef.current = null;
    return clickTokenRef.current;
  }, []);

  const runChatLink = useMemo(() => {
    if (tabHostClient === null) return null;
    return buildChatLinkPolicy({
      tabId,
      // No host for a file link where the surface has no working
      // directories: the policy then opens none.
      hostId: opensFiles ? tabHostId : null,
      workspaceRoots: workspaceRoots ?? [],
      activeHostId: tabHostId,
      openEpicId,
      epicHandle,
      queryClient,
      client: tabHostClient,
      workspaceClient: opensFiles ? tabHostClient : null,
      navigate,
      openTile,
    });
  }, [
    epicHandle,
    navigate,
    openEpicId,
    openTile,
    opensFiles,
    queryClient,
    tabHostClient,
    tabHostId,
    tabId,
    workspaceRoots,
  ]);

  const linkPolicy = useMemo<MarkdownLinkPolicy>(
    () => ({
      supersedePendingFileLink,
      // The lifecycle accessors are built HERE, inside the click handler, so
      // reading the refs' `.current` happens at click / wait-settle time (an
      // event context) — never during render. That keeps `buildChatLinkPolicy`
      // a pure, hookless function while the cancel handle + disposed flag stay
      // owned by this component's refs and unmount effect.
      openFileLink: (link) => {
        if (runChatLink === null) {
          toast("Couldn't open link");
          return true;
        }
        return runChatLink(link, {
          isDisposed: () => disposedRef.current,
          getPendingProjectedOpenCancel: () =>
            pendingProjectedOpenCancelRef.current,
          setPendingProjectedOpenCancel: (cancel) => {
            pendingProjectedOpenCancelRef.current = cancel;
          },
          beginClick: supersedePendingFileLink,
          isCurrent: (token) => token === clickTokenRef.current,
          onAsyncFailure: () => toast("Couldn't open link"),
        });
      },
    }),
    [runChatLink, supersedePendingFileLink],
  );

  return (
    <MarkdownLinkContext.Provider value={linkPolicy}>
      {children}
    </MarkdownLinkContext.Provider>
  );
}
