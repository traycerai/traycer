import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import type { AppRouter } from "@/router";
import {
  PROVIDER_DISPLAY_NAMES,
  TUI_HARNESS_ID_TO_PROVIDER_ID,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useProvidersList } from "@/hooks/providers/use-providers-list-query";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import {
  knownField,
  setSupportContextSnapshot,
  staleField,
  unavailableField,
  type CapturedField,
} from "@/lib/support-context-registry";
import {
  useActiveEpicArtifactRef,
  useActiveEpicId,
  useActiveTabId,
} from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import type {
  OpenEpicState,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";

function toKnown<T>(value: T | null): CapturedField<T> {
  return value === null ? unavailableField() : knownField(value);
}

function isTuiHarnessId(value: string): value is TuiHarnessId {
  return Object.hasOwn(TUI_HARNESS_ID_TO_PROVIDER_ID, value);
}

function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDER_DISPLAY_NAMES, value);
}

/**
 * Maps a chat/terminal-agent's harness id to the `providers.list` id it runs
 * on. TUI harness ids (`claude`, `codex`, ...) differ from their provider id
 * (`claude-code`, ...); GUI ACP harness ids already equal their provider id.
 */
function resolveProviderId(harnessId: string): ProviderId | null {
  if (isTuiHarnessId(harnessId))
    return TUI_HARNESS_ID_TO_PROVIDER_ID[harnessId];
  if (isProviderId(harnessId)) return harnessId;
  return null;
}

/**
 * Reads the current route template directly off the router INSTANCE
 * (`router.state`/`router.subscribe`) rather than via `useRouterState`, which
 * requires a `<RouterProvider>` ancestor context. This bridge is mounted
 * above `RouterProvider` in the tree (`TraycerAuthenticatedRuntime`, a sibling
 * of the deeply-nested `TraycerAppRuntimeSurface` that renders
 * `<RouterProvider>`), so no such context exists there - `useRouterState`
 * throws `Cannot read properties of null (reading 'isServer')` in that
 * position. Taking the live router as a prop and reading it imperatively
 * (the same pattern `HistoryPruneProvider` already uses) works regardless of
 * where in the tree this is mounted.
 */
function useRouteTemplate(router: AppRouter): string | null {
  const subscribe = useCallback(
    (callback: () => void) => router.subscribe("onResolved", () => callback()),
    [router],
  );
  const getSnapshot = useCallback(() => {
    const lastMatch = router.state.matches.at(-1);
    return lastMatch === undefined ? null : lastMatch.routeId;
  }, [router]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

interface ActiveHarnessContext {
  readonly chatId: string | null;
  readonly agentId: string | null;
  readonly harnessId: string | null;
  readonly model: string | null;
  readonly profileId: string | null;
}

const EMPTY_ACTIVE_HARNESS_CONTEXT: ActiveHarnessContext = {
  chatId: null,
  agentId: null,
  harnessId: null,
  model: null,
  profileId: null,
};

function harnessContextsEqual(
  left: ActiveHarnessContext,
  right: ActiveHarnessContext,
): boolean {
  return (
    left.chatId === right.chatId &&
    left.agentId === right.agentId &&
    left.harnessId === right.harnessId &&
    left.model === right.model &&
    left.profileId === right.profileId
  );
}

/**
 * Resolves harness/model/profile for the active tile via the module-scoped
 * open-epic session registry (`getOpenEpicRegistry`) rather than
 * `useOpenEpicHandle`'s React context, since this bridge is mounted once,
 * globally, above any specific epic's provider tree.
 */
function resolveActiveHarnessContext(
  handle: OpenEpicStoreHandle | null,
  artifactRef: EpicCanvasTileRef,
): ActiveHarnessContext {
  if (handle === null) return EMPTY_ACTIVE_HARNESS_CONTEXT;
  const state: OpenEpicState = handle.store.getState();
  if (artifactRef.type === "chat") {
    if (!Object.hasOwn(state.chats.byId, artifactRef.id)) {
      return { ...EMPTY_ACTIVE_HARNESS_CONTEXT, chatId: artifactRef.id };
    }
    const chat = state.chats.byId[artifactRef.id];
    if (chat.settings === null) {
      return { ...EMPTY_ACTIVE_HARNESS_CONTEXT, chatId: artifactRef.id };
    }
    return {
      chatId: artifactRef.id,
      agentId: null,
      harnessId: chat.settings.harnessId,
      model: chat.settings.model,
      profileId: chat.settings.profileId,
    };
  }
  if (artifactRef.type === "terminal-agent") {
    if (!Object.hasOwn(state.tuiAgents.byId, artifactRef.id)) {
      return { ...EMPTY_ACTIVE_HARNESS_CONTEXT, agentId: artifactRef.id };
    }
    const agent = state.tuiAgents.byId[artifactRef.id];
    return {
      chatId: null,
      agentId: artifactRef.id,
      harnessId: agent.harnessId,
      model: agent.model,
      profileId: agent.profileId,
    };
  }
  return EMPTY_ACTIVE_HARNESS_CONTEXT;
}

/**
 * Writes last-known session state into the module-level support-context
 * registry (critique D5). Mounted once inside `TraycerAuthenticatedRuntime`,
 * ABOVE nothing crash-relevant - `ReportIssueDialogHost` (which reads the
 * registry at report-open) is mounted above `RootErrorBoundary`, so a crash
 * that unmounts this bridge must not take the last-observed state with it;
 * that is exactly what the module-scoped registry store guarantees and a
 * React context would not.
 */
export interface SupportContextRegistryBridgeProps {
  /** The live app router - read imperatively, never via `useRouterState`. */
  readonly router: AppRouter;
}

export function SupportContextRegistryBridge(
  props: SupportContextRegistryBridgeProps,
): null {
  const hostId = useReactiveActiveHostId();
  const epicId = useActiveEpicId();
  const tabId = useActiveTabId();
  const artifactRef = useActiveEpicArtifactRef(tabId ?? undefined);
  const routeTemplate = useRouteTemplate(props.router);
  const providersListQuery = useProvidersList({
    enabled: true,
    subscribed: false,
  });
  const [subscribedHarnessContext, setSubscribedHarnessContext] = useState(
    EMPTY_ACTIVE_HARNESS_CONTEXT,
  );
  // Derived at render time rather than reset via effect: with no active
  // epic/artifact there is nothing to subscribe to, so this branch needs no
  // effect at all - only the subscribed branch below is a genuine
  // external-system subscription.
  const activeHarnessContext =
    epicId === null || artifactRef === null
      ? EMPTY_ACTIVE_HARNESS_CONTEXT
      : subscribedHarnessContext;

  const artifactId = artifactRef === null ? null : artifactRef.id;

  useEffect(() => {
    setSupportContextSnapshot({
      routeTemplate: toKnown(routeTemplate),
      hostId: toKnown(hostId),
      epicId: toKnown(epicId),
      tabId: toKnown(tabId),
      artifactId: toKnown(artifactId),
    });
  }, [routeTemplate, hostId, epicId, tabId, artifactId]);

  useEffect(() => {
    if (epicId === null || artifactRef === null) return undefined;
    const registry = getOpenEpicRegistry();
    let subscribedHandle: OpenEpicStoreHandle | null = null;
    let unsubscribeStore: (() => void) | null = null;

    const apply = (handle: OpenEpicStoreHandle | null) => {
      const next = resolveActiveHarnessContext(handle, artifactRef);
      setSubscribedHarnessContext((current) =>
        harnessContextsEqual(current, next) ? current : next,
      );
    };

    const attachCurrentHandle = () => {
      const nextHandle = registry.peek(epicId);
      if (nextHandle === subscribedHandle) {
        apply(nextHandle);
        return;
      }
      if (unsubscribeStore !== null) unsubscribeStore();
      subscribedHandle = nextHandle;
      apply(nextHandle);
      unsubscribeStore =
        nextHandle === null
          ? null
          : nextHandle.store.subscribe(() => apply(nextHandle));
    };

    attachCurrentHandle();
    const unsubscribeRegistry = registry.subscribe(attachCurrentHandle);
    return () => {
      unsubscribeRegistry();
      if (unsubscribeStore !== null) unsubscribeStore();
    };
  }, [epicId, artifactRef]);

  useEffect(() => {
    setSupportContextSnapshot({
      chatId: toKnown(activeHarnessContext.chatId),
      agentId: toKnown(activeHarnessContext.agentId),
      harnessId: toKnown(activeHarnessContext.harnessId),
      model: toKnown(activeHarnessContext.model),
      profileId:
        activeHarnessContext.harnessId === null
          ? unavailableField()
          : knownField(activeHarnessContext.profileId),
    });
  }, [activeHarnessContext]);

  useEffect(() => {
    const providerId =
      activeHarnessContext.harnessId === null
        ? null
        : resolveProviderId(activeHarnessContext.harnessId);
    if (providerId === null) {
      setSupportContextSnapshot({
        providerSelectionClass: unavailableField(),
        providerVersion: unavailableField(),
      });
      return;
    }
    const provider = providersListQuery.data?.providers.find(
      (candidate) => candidate.providerId === providerId,
    );
    if (provider === undefined) {
      setSupportContextSnapshot({
        providerSelectionClass: unavailableField(),
        providerVersion: unavailableField(),
      });
      return;
    }
    const candidate = provider.candidates.find(
      (entry) => entry.kind === provider.selected.kind,
    );
    // A host that stopped answering leaves the last successful response in
    // the query cache but flags it `isError` on the latest attempt - report
    // that as `stale` (last-known) rather than silently reusing it as fresh.
    const makeField = providersListQuery.isError ? staleField : knownField;
    setSupportContextSnapshot({
      providerSelectionClass: makeField(provider.selected.kind),
      providerVersion:
        candidate === undefined
          ? unavailableField()
          : makeField(candidate.version),
    });
  }, [
    activeHarnessContext.harnessId,
    providersListQuery.data,
    providersListQuery.isError,
  ]);

  return null;
}
