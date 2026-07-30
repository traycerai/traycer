import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
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
import type { OpenEpicState } from "@/stores/epics/open-epic/store";

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

/**
 * Resolves harness/model/profile for the active tile via the module-scoped
 * open-epic session registry (`getOpenEpicRegistry`) rather than
 * `useOpenEpicHandle`'s React context, since this bridge is mounted once,
 * globally, above any specific epic's provider tree.
 */
function resolveActiveHarnessContext(
  epicId: string,
  artifactRef: EpicCanvasTileRef,
): ActiveHarnessContext {
  const handle = getOpenEpicRegistry().get(epicId);
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
export function SupportContextRegistryBridge(): null {
  const hostId = useReactiveActiveHostId();
  const epicId = useActiveEpicId();
  const tabId = useActiveTabId();
  const artifactRef = useActiveEpicArtifactRef(tabId ?? undefined);
  const routeTemplate = useRouterState({
    select: (state) => {
      const lastMatch = state.matches.at(-1);
      return lastMatch === undefined ? null : lastMatch.routeId;
    },
  });
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
    const apply = () => {
      setSubscribedHarnessContext(
        resolveActiveHarnessContext(epicId, artifactRef),
      );
    };
    apply();
    const handle = getOpenEpicRegistry().get(epicId);
    if (handle === null) return undefined;
    return handle.store.subscribe(apply);
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
