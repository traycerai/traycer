import type { UseNavigateResult } from "@tanstack/react-router";
import { activeHostIdOrNull } from "@/lib/host/runtime";
import {
  activateTabIntent,
  subscribeTabNavigationPending,
  tracyChannelNavigationPending,
} from "@/lib/tab-navigation";
import {
  botTabIntent,
  type TabNavigationIntent,
} from "@/lib/tab-navigation/intents";
import type { BotTabLanding } from "@/stores/bots/bot-tab-landing-store";
import {
  rebindUnreachableTracySurface,
  releaseTracyLanding,
  stageTracyLanding,
  useTracySurfaceStore,
} from "@/stores/bots/tracy-surface-store";

export interface OpenBotChannelOptions {
  /** Where the channel lands once it shows; `null` shows it as it was. */
  readonly landing: BotTabLanding | null;
  /**
   * Whether this client can dial a host, `null` while the directory has not
   * answered; an open surface on a host it cannot dial moves to the window's.
   */
  readonly isConnectable: ((hostId: string) => boolean) | null;
  /** The navigation was refused before it ran. */
  readonly onRejected: ((error: Error) => void) | null;
}

/**
 * Opens the Tracy surface on `botId`'s channel (decision 150): every opener
 * of a bot - the channel column, Threads, Home's rows, a created bot, a
 * notification, voice, the mobile drawer, the strip's slot - lands the one
 * surface on that channel, never a tab of its own.
 *
 * The surface keeps its host (a channel switch never moves it), or binds
 * to this window's when it is closed. Any landing is asked for before the
 * navigation, so the channel finds it when it shows. The selection is
 * committed when the navigation is acknowledged (`TabNavigationController`),
 * so a refused one leaves the previous channel; a surface this call opened is
 * closed again when the navigation is refused outright.
 *
 * Returns whether the navigation was accepted; `false`, with nothing opened,
 * while the window has no host to bind a closed surface to.
 */
export function openBotChannel(
  navigate: UseNavigateResult<string>,
  botId: string,
  options: OpenBotChannelOptions,
): boolean {
  return openTracySurface(navigate, botTabIntent(botId), options);
}

/**
 * The fixed entry (the strip's slot, the mobile drawer's row): the surface
 * on the channel it shows, or on none, where it selects the default.
 */
export function openTracyEntry(
  navigate: UseNavigateResult<string>,
  isConnectable: ((hostId: string) => boolean) | null,
): boolean {
  const botId = useTracySurfaceStore.getState().botId;
  return openTracySurface(
    navigate,
    { kind: "tracy", botId },
    {
      landing: null,
      isConnectable,
      onRejected: null,
    },
  );
}

function openTracySurface(
  navigate: UseNavigateResult<string>,
  intent: Extract<TabNavigationIntent, { kind: "tracy" }>,
  options: OpenBotChannelOptions,
): boolean {
  const windowHostId = activeHostIdOrNull();
  const surface = useTracySurfaceStore.getState();
  const wasOpen = surface.open;
  if (wasOpen) {
    if (windowHostId !== null) {
      rebindUnreachableTracySurface(windowHostId, options.isConnectable);
    }
  } else {
    if (windowHostId === null) return false;
    surface.openSurface(windowHostId);
  }
  const { botId } = intent;
  const landing = botId === null ? null : options.landing;
  if (botId !== null && landing !== null) stageTracyLanding(botId, landing);
  const accepted = activateTabIntent(navigate, intent, {
    onRejected: options.onRejected ?? undefined,
  });
  if (botId !== null && landing !== null) {
    if (accepted) releaseLandingIfNeverLanded(botId, landing);
    else releaseTracyLanding(botId, landing);
  }
  if (!accepted && !wasOpen) useTracySurfaceStore.getState().closeSurface();
  return accepted;
}

/**
 * Once no navigation to `botId`'s channel is in flight: if it was not
 * acknowledged (refused, or superseded by another), the landing staged for
 * it is withdrawn, so it never fires on a later visit. An acknowledged one
 * shows the channel, which spends it.
 */
function releaseLandingIfNeverLanded(
  botId: string,
  landing: BotTabLanding,
): void {
  const settled = (): boolean => {
    if (tracyChannelNavigationPending(botId)) return false;
    if (useTracySurfaceStore.getState().botId !== botId) {
      releaseTracyLanding(botId, landing);
    }
    return true;
  };
  if (settled()) return;
  const unsubscribe = subscribeTabNavigationPending(() => {
    // Once the controller's step that announced it is done: an arrival from
    // outside supersedes the navigation in flight before it commits the
    // channel it arrived at.
    queueMicrotask(() => {
      if (settled()) unsubscribe();
    });
  });
}

/**
 * Selects the surface's channel without an opener: the default channel when
 * none is selected or the selected one has gone. Where the surface is shown,
 * that is a navigation replacing the current entry, committed on its
 * acknowledgement like any switch; a surface out of view has no route to
 * move, and the selection is committed at once.
 */
export function selectTracyChannel(
  navigate: UseNavigateResult<string>,
  botId: string | null,
  shown: boolean,
): void {
  if (!shown) {
    useTracySurfaceStore.getState().selectChannel(botId);
    return;
  }
  activateTabIntent(navigate, { kind: "tracy", botId }, { replace: true });
}
