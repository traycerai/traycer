import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useStore } from "zustand";
import type {
  BotOnboardingChoice,
  BotOnboardingReadResponse,
} from "@traycer/protocol/host/bot/onboarding-schemas";
import {
  chatMaxModeContextForToolbar,
  type MaxModeContext,
} from "@/components/home/data/model-max-mode";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostsAdvertisingMethod } from "@/hooks/host/use-hosts-advertising-method";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import {
  useBotOnboardingChooseMutation,
  useBotOnboardingCompleteMutation,
} from "@/hooks/bots/use-bot-mutations";
import type { HostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";
import {
  chooseBotCreateHost,
  type BotCreateHostChoice,
} from "@/lib/home-bots/bot-create-host";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

/** One team onboarding as its card or its setup dialog drives it. */
export interface TeamOnboardingFlow {
  /** The areas ticked now: the team's kept choice, or the catalog's default. */
  readonly chosen: ReadonlyArray<string>;
  readonly toggle: (area: string, checked: boolean) => void;
  /** The chosen areas whose bot another host has not finished yet. */
  readonly pendingAreas: ReadonlyArray<string>;
  /** Whether nothing is pending, so the host the app picks makes the bots. */
  readonly nothingPending: boolean;
  readonly hostChoice: BotCreateHostChoice;
  /** Where the completion goes, `null` while no host can take it. */
  readonly hostId: string | null;
  readonly toolbarStore: ComposerToolbarStore;
  readonly maxModeContext: MaxModeContext;
  readonly busy: boolean;
  readonly completing: boolean;
  readonly canOpen: boolean;
  /** Creates the chosen bots and opens the first one's channel. */
  readonly openChannels: () => void;
}

/**
 * The choice, the host and the model behind "Open your channels" (Tracy Bots
 * T48), read and chosen through the tab's host: both are the cloud's, so any
 * host answers the same. The create goes to the host the app picks for the
 * environment's bots (`chooseBotCreateHost`), as "Add a bot" does. A bot an
 * earlier try made on another host is that host's to finish
 * (`choice.pending`): the completion goes there when this client reaches it.
 * `onOpened` runs once the first channel is open.
 */
export function useTeamOnboardingFlow(input: {
  readonly environmentId: string;
  readonly connectableHostIds: ReadonlyArray<string>;
  readonly environmentBindings: HostEnvironmentBindings;
  readonly data: BotOnboardingReadResponse;
  readonly onOpened: () => void;
}): TeamOnboardingFlow {
  const {
    environmentId,
    connectableHostIds,
    environmentBindings,
    data,
    onOpened,
  } = input;
  const tabClient = useTabHostClient();
  const choose = useBotOnboardingChooseMutation(tabClient);

  const localHostId = useReactiveLocalHostId();
  const effectiveHostId = useEffectiveHostId();
  const completingHostIds = useHostsAdvertisingMethod(
    connectableHostIds,
    "bot.onboarding.complete",
  );
  const hostChoice = chooseBotCreateHost({
    environmentId,
    localHostId,
    effectiveHostId,
    connectableHostIds,
    bindings: environmentBindings.byHostId,
    failedHostIds: environmentBindings.failedHostIds,
    creatingHostIds: completingHostIds,
  });
  const pending = data.choice?.pending ?? [];
  const hostId = completionHostId(pending, completingHostIds, hostChoice);
  const namedClient = useHostClientForHostId(hostId);
  const createClient = hostId === null ? null : namedClient;
  const complete = useBotOnboardingCompleteMutation(createClient);
  const toolbarStore = useComposerToolbarStore(
    null,
    fallbackSeedSource(null, createClient),
    null,
    // The chosen host's last-used buckets, the machine the bots will run on.
    {
      hostClient: createClient,
      hostId,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
    },
  );
  const modelSlug = useStore(toolbarStore, (s) => s.selection.modelSlug);
  const reasoning = useStore(toolbarStore, (s) => s.reasoning);
  const maxModeContext = useMemo(
    () => chatMaxModeContextForToolbar(reasoning, ""),
    [reasoning],
  );
  const openBotTab = useBotTabsStore((s) => s.openBotTab);
  const navigate = useNavigate();

  const defaultAreas = useMemo(
    () =>
      data.catalog.filter((entry) => entry.tickedByDefault).map((e) => e.area),
    [data.catalog],
  );
  // A choice being sent shows as made; the mutation stays pending until the
  // read carries it back.
  const chosen: ReadonlyArray<string> = choose.isPending
    ? choose.variables.areas
    : (data.choice?.areas ?? defaultAreas);
  const toggle = (area: string, checked: boolean): void => {
    const areas = checked
      ? [...chosen.filter((a) => a !== area), area]
      : chosen.filter((a) => a !== area);
    choose.mutate({ environmentId, areas });
  };

  const busy = choose.isPending || complete.isPending;
  const canOpen =
    data.unlocked &&
    hostId !== null &&
    chosen.length > 0 &&
    modelSlug.length > 0 &&
    !busy;

  const openChannels = (): void => {
    if (!canOpen) return;
    const toolbar = toolbarStore.getState();
    const areas = [...chosen];
    // `mutateAsync`, as the create form's submit: the continuation opens the
    // channel through module-level actions whether or not the surface is
    // still mounted. A failure is already toasted by the mutations.
    void (async () => {
      // The host creates the team's kept choice; one never made is the
      // default the boxes show.
      if (data.choice === null) {
        await choose.mutateAsync({ environmentId, areas });
      }
      const response = await complete.mutateAsync({
        environmentId,
        harness: toolbar.selection.harnessId,
        model: toolbar.selection.modelSlug,
        effort: toolbar.reasoning.length === 0 ? null : toolbar.reasoning,
        profile: toolbar.selection.profileId,
      });
      if (response.bots.length === 0) return;
      const first = response.bots[0];
      const title =
        data.catalog.find((entry) => entry.area === first.area)?.title ??
        first.area;
      openBotTab({ botId: first.botId, hostId, title });
      navigateToTabIntent(navigate, botTabIntent(first.botId), undefined);
      onOpened();
    })().catch(() => undefined);
  };

  return {
    chosen,
    toggle,
    pendingAreas: pending.map((entry) => entry.area),
    nothingPending: pending.length === 0,
    hostChoice,
    hostId,
    toolbarStore,
    maxModeContext,
    busy,
    completing: complete.isPending,
    canOpen,
    openChannels,
  };
}

/**
 * Where "Open your channels" sends the completion. While an area is pending,
 * only its own host can finish it: there, when this client reaches it, or
 * nowhere until it does. Otherwise the host the app picks for the bots.
 */
function completionHostId(
  pending: BotOnboardingChoice["pending"],
  completingHostIds: ReadonlySet<string>,
  hostChoice: BotCreateHostChoice,
): string | null {
  if (pending.length > 0) {
    return (
      pending
        .map((entry) => entry.hostId)
        .find((id) => id !== null && completingHostIds.has(id)) ?? null
    );
  }
  return hostChoice.kind === "chosen" ? hostChoice.hostId : null;
}
