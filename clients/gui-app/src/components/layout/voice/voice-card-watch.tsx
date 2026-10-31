import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import type { BotConversationSendResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import type {
  BotInputNeeded,
  BotRecord,
} from "@traycer/protocol/host/bot/schemas";
import type {
  BotSurfaceActRequest,
  BotSurfaceActResponse,
} from "@traycer/protocol/host/bot/surface-schemas";
import type { OpenMessage } from "@traycer/protocol/host/agent/gui/open-harness-wire";
import { openSurfaceOf } from "@/components/bots/bot-surface-card-view";
import { useBotConversationListQuery } from "@/hooks/bots/use-bot-conversation-list-query";
import { useBotConversationSendMutation } from "@/hooks/bots/use-bot-mutations";
import { useBotSendTakesAnswers } from "@/hooks/bots/use-bot-send-version";
import { useBotSubscriptionForHost } from "@/hooks/bots/use-bot-subscription";
import { useBotSurfaceActMutation } from "@/hooks/bots/use-bot-surface-act";
import { useBotSurfaceOpen } from "@/hooks/bots/use-bot-surface-open";
import { useEnvironmentMemberDirectory } from "@/hooks/bots/use-environment-members-query";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type {
  VoiceQueueOwner,
  VoiceSurfaceOpen,
} from "@/hooks/voice/use-voice-queue-owner";
import { firstLineOf } from "@/lib/bots/bot-trunk-model";
import { routeNotificationForHost } from "@/lib/notifications/payload";
import { useChatSessionHandleForContainer } from "@/lib/registries/chat-session-registry";
import type {
  CardApi,
  CardContent,
  CardDesk,
  CardFacts,
  SurfaceActOutcome,
} from "@/lib/voice/card-desk";
import { channelConversation } from "@/lib/voice/directory";
import { replyTextOf } from "@/lib/voice/focused-replies";
import { confirmationWords, type SpeechScheduler } from "@/lib/voice/scheduler";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useBotSurfaceActionsStore,
  type BotSurfaceActionEntry,
} from "@/stores/bots/bot-surface-actions-store";
import {
  useVoiceSessionStore,
  type ActiveCard,
} from "@/stores/voice/voice-session-store";

type AssistantRow = Extract<OpenMessage, { readonly role: "assistant" }>;

const NO_SUBSCRIBE = (): (() => void) => () => undefined;

/**
 * What the voice's cards read while a session runs (VT5): the active card's
 * records, and each page or artifact asked open.
 */
export function VoiceCards(props: {
  readonly owner: VoiceQueueOwner;
  /** `null` until the first session built it: nothing is opened before. */
  readonly speech: SpeechScheduler | null;
  readonly botTitle: (botId: string) => string;
  readonly placeOf: (botId: string, threadId: string | null) => string;
}): ReactNode {
  const { owner, speech, botTitle, placeOf } = props;
  const activeCard = useVoiceSessionStore((state) => state.activeCard);
  const desk = owner.cardDesk;
  return (
    <>
      {activeCard === null || desk === null ? null : (
        <VoiceCardWatch
          key={activeCard.opening}
          card={activeCard}
          desk={desk}
          bot={
            owner.bots.find((bot) => bot.botId === activeCard.ids.botId) ?? null
          }
          botTitle={botTitle(activeCard.ids.botId)}
          place={placeOf(activeCard.ids.botId, activeCard.ids.threadId)}
        />
      )}
      {speech === null
        ? null
        : owner.surfaceOpens.map((request) => (
            <VoiceSurfaceOpener
              key={request.seq}
              request={request}
              speech={speech}
              onOpened={owner.onSurfaceOpened}
            />
          ))}
    </>
  );
}

/**
 * Reads the active card's records for the desk (Tracy Bots voice, VT5): the
 * bot's row (its question and its settlement, or the surface and its
 * resolution), the task's open surface from the bot's stream, the
 * subscriber's forwarded acts, and who settled it, by the names the
 * channel shows. Binds the card's three APIs on the host the bot's records
 * are served from, the way the channel's own cards send: a bot's question
 * through `bot.conversation.send` with `answer`, a surfaced question or
 * approval through `bot.surface.act` (recorded in the surface-actions store,
 * so the card in the channel shows the same act).
 */
function VoiceCardWatch(props: {
  readonly card: ActiveCard;
  readonly desk: CardDesk;
  readonly bot: BotRecord | null;
  readonly botTitle: string;
  /** Where the card is, as said. */
  readonly place: string;
}): null {
  const { card, desk, bot, botTitle, place } = props;
  const { ids, family } = card;
  const { botId, hostId, messageId } = ids;
  const handle = useChatSessionHandleForContainer(
    botId,
    ids.chatId,
    hostId,
    true,
  );
  const row = useSyncExternalStore(
    handle === null ? NO_SUBSCRIBE : handle.store.subscribe,
    () =>
      handle?.store
        .getState()
        .messages.find(
          (message): message is AssistantRow =>
            message.messageId === messageId && message.role === "assistant",
        ) ?? null,
  );
  const surfaced = family !== "bot-question";
  const subscription = useBotSubscriptionForHost({
    botId,
    hostId,
    enabled: surfaced,
  });
  const snapshot = subscription.snapshot;
  const client = useHostClientForHostId(hostId);
  const actSupported = useHostMethodSupport(hostId, "bot.surface.act") === true;
  const answersTaken = useBotSendTakesAnswers(hostId);
  const conversations = useBotConversationListQuery(client, botId, true);
  const channelId = useMemo(() => {
    const rows = conversations.data?.conversations.filter(
      (row) => row.botId === botId,
    );
    if (rows === undefined) return null;
    return (
      channelConversation(rows, bot?.appConversationChatId ?? null)
        ?.conversationId ?? null
    );
  }, [bot?.appConversationChatId, botId, conversations.data]);
  const environmentId = bot?.environmentId ?? null;
  const membersSupported =
    useHostMethodSupport(hostId, "environment.members") === true;
  const { resolve: resolveMember } = useEnvironmentMemberDirectory(
    client,
    environmentId,
    membersSupported && environmentId !== null,
  );
  const viewerUserId = useAuthStore((state) => state.profile?.userId ?? null);
  const { mutateAsync: sendAsync } = useBotConversationSendMutation(client);
  const { mutateAsync: actAsync } = useBotSurfaceActMutation(client);

  const facts = useMemo((): CardFacts => {
    const nameOf = (userId: string): string =>
      userId === viewerUserId
        ? "you"
        : (resolveMember(userId)?.displayName ?? "a teammate");
    const forwarded: CardFacts["forwarded"] = (actionId) =>
      snapshot?.surfaceActions?.find(
        (action) => action.actionId === actionId,
      ) ?? null;
    if (row === null) return { ...NOT_READ, forwarded };
    const said = { family, botTitle, place, postText: replyTextOf(row) };
    if (!surfaced) {
      // The send needs the bot's channel: until the list says, the card is
      // not read yet.
      const loading =
        conversations.data === undefined && !conversations.isError;
      return {
        ...botQuestionFacts(row, said, {
          loading,
          actable: answersTaken && channelId !== null,
          nameOf,
        }),
        forwarded,
      };
    }
    const openSurfaces = (
      taskId: string,
    ): ReadonlyArray<BotInputNeeded> | null | undefined =>
      snapshot === null
        ? undefined
        : (snapshot.tasks.find((task) => task.taskId === taskId)?.inputNeeded ??
          null);
    return {
      ...surfaceFacts(row, said, {
        openSurfaces,
        canAct: actSupported && client !== null,
        nameOf,
      }),
      forwarded,
    };
  }, [
    actSupported,
    answersTaken,
    botTitle,
    channelId,
    client,
    conversations.data,
    conversations.isError,
    family,
    place,
    resolveMember,
    row,
    snapshot,
    surfaced,
    viewerUserId,
  ]);

  const rowSurface = row?.surface ?? null;
  const api = useMemo((): CardApi | null => {
    if (client === null) return null;
    const surface =
      rowSurface?.kind === "approval" || rowSurface?.kind === "question"
        ? rowSurface
        : null;
    if (surfaced && (surface === null || !actSupported)) return null;
    if (!surfaced && (channelId === null || !answersTaken)) return null;
    const send = (
      text: string,
      answer: BotAnswer | null,
    ): Promise<BotConversationSendResponse> =>
      sendAsync({
        botId,
        conversationId: channelId ?? "",
        text,
        threadId: ids.threadId,
        announcementId: null,
        redeliver: null,
        supersedes: null,
        answer,
      });
    return {
      answerBotQuestion: async ({ text, questionIndex, skipped }) => {
        try {
          const response = await send(text, {
            questionMessageId: messageId,
            questionIndex,
            skipped,
          });
          return { kind: "sent", delivery: response.delivery };
        } catch {
          return { kind: "failed" };
        }
      },
      actSurface: async (action, actionId) => {
        if (surface === null) return { kind: "failed" };
        return actOnCard(actAsync, {
          botId,
          messageId,
          actionId,
          surface,
          action,
        });
      },
      postInThread: async (text) => {
        if (channelId === null) return false;
        try {
          await send(text, null);
          return true;
        } catch {
          return false;
        }
      },
    };
  }, [
    actAsync,
    actSupported,
    answersTaken,
    botId,
    channelId,
    client,
    ids.threadId,
    messageId,
    rowSurface,
    sendAsync,
    surfaced,
  ]);

  useEffect(() => {
    desk.observe(ids.itemId, facts, api);
  }, [api, desk, facts, ids.itemId]);
  return null;
}

/** The facts of a card whose records have not loaded. */
const NOT_READ: Omit<CardFacts, "forwarded"> = {
  content: null,
  settledBy: () => null,
  gone: false,
};

/** What every card says of itself, whatever its family. */
type CardSaid = Pick<CardContent, "family" | "botTitle" | "place" | "postText">;

/**
 * A bot's own question, read from its row: its first open question and its
 * choices, and who settled each question (the bot, by its default, or a
 * member). Gone once the row asks nothing.
 */
function botQuestionFacts(
  row: AssistantRow,
  said: CardSaid,
  context: {
    readonly loading: boolean;
    readonly actable: boolean;
    readonly nameOf: (userId: string) => string;
  },
): Omit<CardFacts, "forwarded"> {
  const questions = row.question?.questions ?? [];
  const openIndex = questions.findIndex(
    (question) => question.settlement === null,
  );
  const open = openIndex >= 0 ? questions[openIndex] : null;
  const content: CardContent | null =
    open === null || context.loading
      ? null
      : {
          ...said,
          questions: [
            {
              text: open.text,
              options: open.options,
              takesText: open.allowFreeText || open.options.length === 0,
              questionId: null,
            },
          ],
          questionIndex: openIndex,
          approval: null,
          actable: context.actable,
        };
  return {
    content,
    settledBy: (index) => {
      const by = questions.at(index)?.settlement?.by ?? null;
      if (by === null) return null;
      return by.kind === "bot" ? said.botTitle : context.nameOf(by.userId);
    },
    gone: row.question === undefined,
  };
}

/**
 * A task agent's question or approval a bot's post surfaced: its resolution
 * on the post (who decided, or ended with nobody deciding), else the task's
 * open surface as the bot's stream reports it, in the card's words.
 * `openSurfaces` is `undefined` while the stream has not answered, `null`
 * when it cannot say.
 */
function surfaceFacts(
  row: AssistantRow,
  said: CardSaid,
  context: {
    readonly openSurfaces: (
      taskId: string,
    ) => ReadonlyArray<BotInputNeeded> | null | undefined;
    readonly canAct: boolean;
    readonly nameOf: (userId: string) => string;
  },
): Omit<CardFacts, "forwarded"> {
  const surface = row.surface;
  if (
    surface === undefined ||
    (surface.kind !== "approval" && surface.kind !== "question")
  ) {
    return { ...NOT_READ, gone: true };
  }
  const resolution = surface.resolution;
  if (resolution !== null) {
    // Ended with its turn, or resumed, with nobody deciding: no longer
    // waiting, and nobody to name.
    const decided =
      resolution.state !== "ended" && resolution.state !== "resumed";
    if (!decided) return { ...NOT_READ, gone: true };
    const by =
      resolution.by === null ? "someone" : context.nameOf(resolution.by.userId);
    return { content: null, settledBy: () => by, gone: false };
  }
  const openSurfaces = context.openSurfaces(surface.epicId);
  if (openSurfaces === undefined) return NOT_READ;
  const open = openSurfaceOf(surface, openSurfaces);
  const base = { ...said, questionIndex: 0 };
  const actable = context.canAct && open?.acceptsActions !== false;
  if (open?.surface.kind === "approval") {
    return {
      ...NOT_READ,
      content: {
        ...base,
        questions: [],
        approval: {
          tool: open.surface.tool,
          summary: firstLineOf(open.surface.summary) ?? "",
        },
        actable,
      },
    };
  }
  if (open?.surface.kind === "question") {
    return {
      ...NOT_READ,
      content: {
        ...base,
        questions: open.surface.questions.map((question) => ({
          text: question.text,
          options: question.options,
          takesText: question.allowsFreeText || question.options.length === 0,
          questionId: question.questionId,
        })),
        approval: null,
        actable,
      },
    };
  }
  // The task's surface is not among its open ones as the bot's host reads
  // them: the card cannot be answered from here either.
  return {
    ...NOT_READ,
    content: { ...base, questions: [], approval: null, actable: false },
  };
}

type BotAnswer = {
  readonly questionMessageId: string;
  readonly questionIndex: number;
  readonly skipped: boolean;
};

/**
 * One act from the voice, recorded as the channel's card records its own
 * (`useBotSurfaceActionsStore`): the card shows it sending, forwarded,
 * settled or refused, and keeps it until the post shows the resolution.
 */
async function actOnCard(
  act: (request: BotSurfaceActRequest) => Promise<BotSurfaceActResponse>,
  request: BotSurfaceActRequest,
): Promise<SurfaceActOutcome> {
  const { botId, messageId, actionId, action } = request;
  const store = useBotSurfaceActionsStore.getState();
  const settle = (next: BotSurfaceActionEntry): void => {
    const current =
      useBotSurfaceActionsStore.getState().entries[botId]?.[messageId];
    if (current?.actionId === actionId) store.setEntry(botId, messageId, next);
  };
  const entry = (
    phase: BotSurfaceActionEntry["phase"],
    code: BotSurfaceActionEntry["code"],
  ): BotSurfaceActionEntry => ({
    actionId,
    action,
    phase,
    code,
    draftsReturned: false,
  });
  store.setEntry(botId, messageId, entry("sending", null));
  try {
    const response = await act(request);
    settle(entry(response.outcome, response.code));
    return { kind: "answered", response };
  } catch {
    settle(entry("unconfirmed", null));
    return { kind: "failed" };
  }
}

/**
 * Opens a page waiting for the person to sign in, or the task an artifact
 * is in, the way a tapped notification of it lands (Tracy Bots voice, VT5),
 * once, and says what is waiting and where. Never types into the page.
 */
function VoiceSurfaceOpener(props: {
  readonly request: VoiceSurfaceOpen;
  readonly speech: Pick<SpeechScheduler, "enqueue">;
  readonly onOpened: (seq: number) => void;
}): null {
  const { request, speech, onOpened } = props;
  const { surface, item, botTitle } = request;
  const navigate = useNavigate();
  const effectiveHostId = useEffectiveHostId();
  const title = item.title.length > 0 ? item.title : botTitle;
  // A parked page the post names no tab of opens on its live park's tab, as
  // the channel's card opens it: the task's open surfaces, from the bot's
  // stream, are read first.
  const needsPark = surface.kind === "browser" && surface.tabId === null;
  const subscription = useBotSubscriptionForHost({
    botId: item.botId,
    hostId: item.hostId,
    enabled: needsPark,
  });
  const snapshot = subscription.snapshot;
  const open = useMemo(
    () =>
      snapshot === null
        ? null
        : openSurfaceOf(
            surface,
            snapshot.tasks.find((task) => task.taskId === surface.epicId)
              ?.inputNeeded ?? null,
          ),
    [snapshot, surface],
  );
  const [waited, setWaited] = useState(!needsPark);
  useEffect(() => {
    if (waited) return;
    const timer = window.setTimeout(
      () => setWaited(true),
      PARK_READ_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [waited]);
  const ready =
    !needsPark ||
    open !== null ||
    snapshot !== null ||
    subscription.error !== null ||
    waited;
  const openPage = useBotSurfaceOpen(surface, open, title);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !ready) return;
    done.current = true;
    const now = useVoiceSessionStore.getState();
    if (now.phase === "idle" || now.sessionToken !== request.sessionToken) {
      onOpened(request.seq);
      return;
    }
    let text: string;
    if (surface.kind === "browser") {
      openPage();
      // With no tab known, the opener lands on the task (or the chat that
      // parked the page), not the page: the voice says which.
      const tabKnown =
        surface.tabId !== null || open?.surface.kind === "browser";
      text = tabKnown
        ? `${botTitle}'s page "${title}" is waiting for you to sign in. It is open now, in its task.`
        : `${botTitle}'s page "${title}" is waiting for you to sign in. Its task is open now.`;
    } else {
      // The channel's link policy opens an artifact in place; from here,
      // the task it is in is opened, as its notification does.
      routeNotificationForHost(
        navigate,
        { kind: "epic", epicId: surface.epicId },
        Date.now(),
        { originHostId: surface.hostId, effectiveHostId },
      );
      text = `${botTitle} pointed you to "${title}". The task it is in is open now.`;
    }
    speech.enqueue({
      id: `open:${request.seq}`,
      priority: "focused",
      text,
      delegationId:
        now.engineGeneration === request.engineGeneration
          ? request.delegationId
          : null,
      confirmWords: confirmationWords({ botTitle, threadTitle: title, text }),
      onDelivered: null,
      onGivenUp: null,
    });
    onOpened(request.seq);
  }, [
    botTitle,
    effectiveHostId,
    navigate,
    onOpened,
    open,
    openPage,
    ready,
    request,
    speech,
    surface,
    title,
  ]);
  return null;
}

/** How long a parked page waits for its task's open surfaces before it opens without them. */
export const PARK_READ_TIMEOUT_MS = 4_000;
