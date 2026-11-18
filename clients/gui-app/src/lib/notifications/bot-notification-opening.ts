import { subscribeTabNavigationActivation } from "@/lib/tab-navigation";
import { useTracyPlaceStore } from "@/stores/bots/tracy-place-store";
import { v4 as uuidv4 } from "uuid";
import { toast } from "sonner";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  BotNotificationTarget,
  NotificationNavigate,
  NotificationPayload,
} from "@/lib/notifications/payload";
import {
  currentBotLifetime,
  retireAtBotLifetimeEdge,
} from "@/lib/bots/bot-lifetime";
import { openBotChannel } from "@/lib/bots/open-bot-channel";
import {
  useBotTabLandingStore,
  type BotTabLanding,
} from "@/stores/bots/bot-tab-landing-store";
import {
  releaseTracyLanding,
  useTracySurfaceStore,
} from "@/stores/bots/tracy-surface-store";
import {
  readEffectiveHostIdSnapshot,
  useSelectionAuthorityStore,
} from "@/stores/host/selection-authority-store";

export const UNAVAILABLE_BOT_CONVERSATION =
  "This conversation cannot be opened in the app yet.";

interface Opening {
  readonly token: string;
  readonly target: BotNotificationTarget;
  readonly hostId: string;
  readonly lifetime: number;
  readonly controller: AbortController;
  readonly onResult: ((outcome: "success" | "failure") => void) | null;
  landing: BotTabLanding | null;
  conversationId: string | null;
  transcriptAttempt: symbol | null;
  transcriptLease: object | null;
}

let active: Opening | null = null;

function current(opening: Opening): boolean {
  return (
    active === opening &&
    opening.lifetime === currentBotLifetime() &&
    opening.hostId === readEffectiveHostIdSnapshot() &&
    !opening.controller.signal.aborted
  );
}

function finish(opening: Opening, outcome: "success" | "failure"): void {
  if (active !== opening) return;
  active = null;
  if (outcome === "failure") opening.controller.abort();
  if (opening.landing !== null)
    releaseTracyLanding(opening.target.botId, opening.landing);
  const store = useBotTabLandingStore.getState();
  if (
    store.byBotId[opening.target.botId]?.notificationToken === opening.token
  ) {
    store.clear(opening.target.botId);
  }
  opening.onResult?.(outcome);
}

retireAtBotLifetimeEdge(() => {
  if (active !== null) finish(active, "failure");
});
useSelectionAuthorityStore.subscribe(() => {
  if (active !== null && !current(active)) finish(active, "failure");
});
useTracySurfaceStore.subscribe((state, previous) => {
  const opening = active;
  if (opening === null) return;
  if (
    !state.open ||
    (state.hostId !== null && state.hostId !== opening.hostId) ||
    (state.botId !== previous.botId && state.botId !== opening.target.botId)
  )
    finish(opening, "failure");
});

export function openBotNotification(input: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly navigate: NotificationNavigate;
  readonly payload: NotificationPayload;
  readonly onResult: ((outcome: "success" | "failure") => void) | null;
  readonly lifetime: number;
  readonly hostId: string | null;
}): boolean {
  const { client, navigate, payload, onResult } = input;
  if (payload.kind !== "chat" || payload.bot === undefined) return false;
  if (
    input.lifetime !== currentBotLifetime() ||
    input.hostId !== readEffectiveHostIdSnapshot()
  ) {
    onResult?.("failure");
    return true;
  }
  const target = payload.bot;
  if (active !== null) finish(active, "failure");
  if (client === null) {
    onResult?.("failure");
    return true;
  }
  const hostId = client.getActiveHostId();
  if (hostId === null) {
    onResult?.("failure");
    return true;
  }
  const opening: Opening = {
    token: uuidv4(),
    target,
    hostId,
    lifetime: currentBotLifetime(),
    controller: new AbortController(),
    onResult,
    landing: null,
    conversationId: null,
    transcriptAttempt: null,
    transcriptLease: null,
  };
  active = opening;
  void validateAndOpen(client, navigate, opening).catch(() => {
    if (!current(opening)) return;
    toast.error(UNAVAILABLE_BOT_CONVERSATION);
    finish(opening, "failure");
  });
  return true;
}

async function validateAndOpen(
  client: HostClient<HostRpcRegistry>,
  navigate: NotificationNavigate,
  opening: Opening,
): Promise<void> {
  const { target, controller } = opening;
  const result = await client.requestWithSignal(
    "bot.read",
    { botId: target.botId },
    controller.signal,
  );
  if (!current(opening)) return;
  const main = result.bot.appConversationChatId;
  if (main === null || target.messageId === null)
    throw new Error("Unavailable destination");
  if (target.threadId === null) {
    if (target.conversationId !== main)
      throw new Error("Unavailable destination");
  } else {
    const list = await client.requestWithSignal(
      "bot.thread.list",
      { botId: target.botId, limit: null, cursor: null },
      controller.signal,
    );
    if (!current(opening)) return;
    const thread = list.threads.find(
      (entry) => entry.threadId === target.threadId,
    );
    if (
      thread === undefined ||
      thread.anchor === null ||
      thread.conversationId !== main ||
      (target.conversationId ?? main) !== main
    )
      throw new Error("Unavailable destination");
  }
  if (!current(opening)) return;
  const surface = useTracySurfaceStore.getState();
  if (surface.open && surface.hostId !== opening.hostId)
    throw new Error("Unavailable destination");
  opening.conversationId = main;
  opening.landing = {
    kind: "thread",
    threadId: target.threadId,
    messageId: target.messageId,
    notificationToken: opening.token,
  };
  const accepted = openBotChannel(navigate, target.botId, {
    landing: opening.landing,
    isConnectable: null,
    signal: controller.signal,
    onRejected: () => finish(opening, "failure"),
  });
  if (!accepted) finish(opening, "failure");
}

export interface BotNotificationTranscript {
  readonly botId: string;
  readonly hostId: string;
  readonly chatId: string;
  readonly kind: "channel" | "thread" | null;
  readonly messageId: string;
  readonly attempt: symbol;
}

export function isBotNotificationLandingLive(
  token: string,
  transcript: BotNotificationTranscript,
): boolean {
  const opening = active;
  if (opening === null || opening.token !== token || !current(opening))
    return false;
  const thread = opening.target.threadId;
  return (
    opening.target.botId === transcript.botId &&
    opening.hostId === transcript.hostId &&
    opening.target.messageId === transcript.messageId &&
    transcript.kind === (thread === null ? "channel" : "thread") &&
    transcript.chatId === (thread ?? opening.conversationId)
  );
}

export function retainBotNotificationTranscript(
  token: string,
  transcript: BotNotificationTranscript,
): () => void {
  const opening = active;
  if (opening === null || opening.token !== token) return () => {};
  if (
    !isBotNotificationLandingLive(token, transcript) ||
    (opening.transcriptAttempt !== null &&
      opening.transcriptAttempt !== transcript.attempt)
  ) {
    finish(opening, "failure");
    return () => {};
  }
  const lease = {};
  opening.transcriptAttempt = transcript.attempt;
  opening.transcriptLease = lease;
  return () => {
    // Strict Mode re-attaches the same instance before this microtask. A real
    // departure, or another instance attempting the token, retires the route.
    queueMicrotask(() => {
      if (opening.transcriptLease === lease) finish(opening, "failure");
    });
  };
}

export function settleBotNotificationLanding(
  token: string,
  transcript: BotNotificationTranscript,
  outcome: "landed" | "exhausted" | "cancelled",
): void {
  const opening = active;
  if (opening === null || opening.token !== token) return;
  const exact =
    isBotNotificationLandingLive(token, transcript) &&
    opening.transcriptAttempt === transcript.attempt;
  finish(opening, exact && outcome === "landed" ? "success" : "failure");
}

export function cancelBotNotificationLanding(token: string): void {
  if (active?.token === token) finish(active, "failure");
}

export function notificationLandingAllowed(input: {
  readonly token: string;
  readonly botId: string;
  readonly conversationId: string | null;
  readonly threadId: string | null;
  readonly messageId: string | null;
}): boolean {
  const { token, botId, conversationId, threadId, messageId } = input;
  const opening = active;
  return (
    opening !== null &&
    opening.token === token &&
    current(opening) &&
    opening.target.botId === botId &&
    opening.conversationId === conversationId &&
    conversationId !== null &&
    opening.target.threadId === threadId &&
    opening.target.messageId === messageId
  );
}

useBotTabLandingStore.subscribe((state, previous) => {
  const opening = active;
  if (opening === null) return;
  const next = state.byBotId[opening.target.botId];
  if (
    next !== previous.byBotId[opening.target.botId] &&
    Object.hasOwn(state.byBotId, opening.target.botId) &&
    next.notificationToken !== opening.token
  )
    finish(opening, "failure");
});

export function retireBotNotificationNavigation(
  botId: string,
  exceptToken: string | undefined,
): void {
  if (
    active !== null &&
    active.target.botId === botId &&
    active.token !== exceptToken
  )
    finish(active, "failure");
}

subscribeTabNavigationActivation((signal) => {
  if (active !== null && active.controller.signal !== signal)
    finish(active, "failure");
});
useTracyPlaceStore.subscribe((state, previous) => {
  if (active !== null && active.landing === null && state !== previous)
    finish(active, "failure");
});
