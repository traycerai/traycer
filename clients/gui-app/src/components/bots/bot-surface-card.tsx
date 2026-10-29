import { useContext, useEffect, type ReactElement } from "react";
import { v4 as uuidv4 } from "uuid";
import type { BotSurfaceReference } from "@traycer/protocol/persistence/epic/messages";
import type { BotInputNeeded } from "@traycer/protocol/host/bot/schemas";
import type { BotSurfaceAction } from "@traycer/protocol/host/bot/surface-schemas";
import type { RuntimeInterviewAnswer } from "@traycer/protocol/host/agent/gui/agent-runtime";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import {
  QuestionCard,
  type QuestionCardQuestion,
} from "@/components/chat/question-card";
import { EMPTY_QUESTION_CARD_DRAFT } from "@/components/chat/question-card-view";
import { useBotSurfaceOpen } from "@/hooks/bots/use-bot-surface-open";
import {
  answerDraftKey,
  useBotDraftsStore,
  type BotAnswerDraft,
} from "@/stores/bots/bot-drafts-store";
import {
  useBotSurfaceActionsStore,
  type BotSurfaceActionEntry,
} from "@/stores/bots/bot-surface-actions-store";
import { cn } from "@/lib/utils";
import {
  BotSurfaceCardsContext,
  type BotSurfaceCards,
} from "./bot-surface-card-context";
import {
  botSurfaceCardView,
  openSurfaceOf,
  type BotSurfaceCardState,
} from "./bot-surface-card-view";

/** Who asks, on the question card a task agent's question is drawn as. */
const QUESTION_ASKER = "The agent";

/**
 * The card under a bot's post that points into a task (Tracy Bots T89): a
 * question or a tool approval an agent of the task waits on, a page it
 * parked for the person to sign in, or an artifact. It says what the post
 * points at, where it stands, and Open; a question the task's agent waits on
 * is answered here with the question card, an approval allowed or denied
 * here, from any machine. What the person sends is kept until the post
 * shows it settled; one that could not reach the task is given back.
 *
 * Outside a bot's channel (`BotSurfaceCardsContext` absent) nothing is
 * drawn: the post's text stands alone.
 */
export function BotSurfaceCard(props: {
  /** The post, by its message id; `null` before it is written. */
  readonly messageId: string | null;
  readonly surface: BotSurfaceReference;
  /** The post's text, for a title the task's report does not give. */
  readonly postText: string;
}): ReactElement | null {
  const cards = useContext(BotSurfaceCardsContext);
  if (cards === null) return null;
  return <SurfaceCard {...props} cards={cards} />;
}

function SurfaceCard(props: {
  readonly messageId: string | null;
  readonly surface: BotSurfaceReference;
  readonly postText: string;
  readonly cards: BotSurfaceCards;
}): ReactElement {
  const { messageId, surface, postText, cards } = props;
  const { botId } = cards;
  const entry = useBotSurfaceActionsStore((state) =>
    messageId === null ? null : (state.entries[botId]?.[messageId] ?? null),
  );
  const setEntry = useBotSurfaceActionsStore((state) => state.setEntry);
  const openSurfaces = cards.openSurfaces(surface.epicId);
  const view = botSurfaceCardView({
    surface,
    postText,
    openSurfaces,
    entry,
    hostAction: entry === null ? null : cards.hostAction(entry.actionId),
    postActions: messageId === null ? [] : cards.postActions(messageId),
    viewerUserId: cards.viewerUserId,
    memberName: cards.memberName,
    canAct: cards.act !== null && messageId !== null,
  });
  const open = openSurfaceOf(surface, openSurfaces);
  const onOpen = useBotSurfaceOpen(surface, open, view.title);
  // This window's own refused action gives its answers back, once.
  const returnDrafts =
    view.state.kind === "refused" && entry !== null && !entry.draftsReturned;
  const onDraftsReturned = (): void => {
    if (entry === null || messageId === null) return;
    const current =
      useBotSurfaceActionsStore.getState().entries[botId]?.[messageId];
    if (current?.actionId !== entry.actionId) return;
    setEntry(botId, messageId, { ...current, draftsReturned: true });
  };

  // The post's own resolution closes whatever this window had in flight on it.
  const resolved = surface.resolution !== null;
  useEffect(() => {
    if (!resolved || messageId === null) return;
    setEntry(botId, messageId, null);
  }, [botId, messageId, resolved, setEntry]);

  const send = (action: BotSurfaceAction): void => {
    const act = cards.act;
    if (act === null || messageId === null) return;
    // The same action sent again after the call failed unanswered keeps its
    // id: the host may hold it, and takes the resend as the same one. A
    // refusal is an answer: a retry after one is a new action.
    const actionId =
      entry !== null &&
      entry.phase === "unconfirmed" &&
      cards.hostAction(entry.actionId)?.state !== "refused" &&
      sameAction(entry.action, action)
        ? entry.actionId
        : uuidv4();
    const settle = (next: BotSurfaceActionEntry): void => {
      const current =
        useBotSurfaceActionsStore.getState().entries[botId]?.[messageId];
      if (current?.actionId === actionId) setEntry(botId, messageId, next);
    };
    setEntry(botId, messageId, {
      actionId,
      action,
      phase: "sending",
      code: null,
      draftsReturned: false,
    });
    act({
      botId,
      messageId,
      actionId,
      surface,
      action,
    }).then(
      (response) =>
        settle({
          actionId,
          action,
          phase: response.outcome,
          code: response.code,
          draftsReturned: false,
        }),
      () =>
        settle({
          actionId,
          action,
          phase: "unconfirmed",
          code: null,
          draftsReturned: false,
        }),
    );
  };

  return (
    <div
      data-testid="bot-surface-card"
      data-kind={surface.kind}
      data-state={view.state.kind}
      className="mt-1 flex min-w-0 flex-col gap-1.5 border-l-4 border-l-chart-2 py-0.5 pl-3"
    >
      <span
        data-testid="bot-surface-card-title"
        className="truncate text-ui-sm font-semibold text-foreground"
      >
        {view.title}
      </span>
      <SurfaceStateLine state={view.state} />
      {view.actions === "question" &&
      messageId !== null &&
      open?.surface.kind === "question" ? (
        <SurfaceQuestion
          botId={botId}
          messageId={messageId}
          questions={open.surface.questions}
          busy={view.actionsBusy}
          returnDrafts={returnDrafts}
          onDraftsReturned={onDraftsReturned}
          onSend={send}
        />
      ) : null}
      {view.actions === "approval" ? (
        <SurfaceDecision
          busy={view.actionsBusy}
          pending={
            entry?.action.kind === "decide"
              ? entry.action.decision.approved
              : null
          }
          onDecide={(approved) =>
            send({ kind: "decide", decision: { approved } })
          }
        />
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="self-start"
        data-testid="bot-surface-card-open"
        onClick={onOpen}
      >
        Open
      </Button>
    </div>
  );
}

function SurfaceStateLine(props: {
  readonly state: BotSurfaceCardState;
}): ReactElement | null {
  const { state } = props;
  if (state.kind === "unknown" || state.kind === "sending") return null;
  return (
    <p
      data-testid="bot-surface-card-state"
      role={state.kind === "refused" ? "status" : undefined}
      className={cn(
        "text-ui-xs break-words",
        state.kind === "refused"
          ? "text-warning-foreground"
          : "text-muted-foreground",
      )}
    >
      {state.line}
    </p>
  );
}

/**
 * The task agent's questions on T91's question card, the person's answers
 * kept under the bot (`useBotDraftsStore`). Each question is answered or
 * skipped on its own; the task's agent takes them together, so they are sent
 * once every question has one. Skipping all of them skips the question.
 */
function SurfaceQuestion(props: {
  readonly botId: string;
  readonly messageId: string;
  readonly questions: Extract<
    BotInputNeeded["surface"],
    { kind: "question" }
  >["questions"];
  readonly busy: boolean;
  /** This window's action was refused and its answers are not given back yet. */
  readonly returnDrafts: boolean;
  readonly onDraftsReturned: () => void;
  readonly onSend: (action: BotSurfaceAction) => void;
}): ReactElement {
  const {
    botId,
    messageId,
    questions,
    busy,
    returnDrafts,
    onDraftsReturned,
    onSend,
  } = props;
  const drafts = useBotDraftsStore((state) => state.answers[botId]);
  const setAnswer = useBotDraftsStore((state) => state.setAnswer);
  const keyOf = (index: number): string => answerDraftKey(messageId, index);
  // A send that did not land gives the person's answers back to change,
  // once: answering again after that is not undone.
  useEffect(() => {
    if (!returnDrafts) return;
    const current = useBotDraftsStore.getState().answers[botId] ?? {};
    for (const [key, draft] of Object.entries(current)) {
      if (draft === undefined || !key.startsWith(`${messageId}#`)) continue;
      if (draft.sent !== null) setAnswer(botId, key, { ...draft, sent: null });
    }
    onDraftsReturned();
  }, [botId, messageId, onDraftsReturned, returnDrafts, setAnswer]);
  const cardQuestions = questions.map((item, index): QuestionCardQuestion => ({
    index,
    text: item.text,
    options: item.options,
    allowFreeText: item.allowsFreeText || item.options.length === 0,
    settlement: null,
    draft: drafts?.[keyOf(index)] ?? EMPTY_QUESTION_CARD_DRAFT,
  }));
  return (
    <QuestionCard
      asker={QUESTION_ASKER}
      questions={cardQuestions}
      onDraft={
        busy ? null : (index, draft) => setAnswer(botId, keyOf(index), draft)
      }
      onAnswer={() => {
        const current = useBotDraftsStore.getState().answers[botId] ?? {};
        const given = questions.map(
          (_, index) => current[keyOf(index)] ?? null,
        );
        if (given.some((draft) => (draft?.sent ?? null) === null)) return;
        onSend(surfaceAnswer(questions, given));
      }}
      onDiscuss={null}
    />
  );
}

/**
 * The answers as the task's own question card sends them: each question's
 * id and text, the value given, and which option it was or the words typed.
 */
function surfaceAnswer(
  questions: ReadonlyArray<{
    readonly questionId: string | null;
    readonly text: string;
    readonly options: ReadonlyArray<string>;
  }>,
  given: ReadonlyArray<BotAnswerDraft | null>,
): BotSurfaceAction {
  if (given.every((draft) => draft?.sent?.skipped !== false)) {
    return { kind: "skip", draftAnswers: [] };
  }
  const answers = questions.map((question, index): RuntimeInterviewAnswer => {
    const sent = given[index]?.sent ?? null;
    if (sent === null || sent.skipped) {
      return {
        questionId: question.questionId,
        question: question.text,
        values: [],
        notes: null,
        selection: null,
      };
    }
    const optionIndex = question.options.indexOf(sent.text);
    return {
      questionId: question.questionId,
      question: question.text,
      values: [sent.text],
      notes: null,
      selection:
        optionIndex >= 0
          ? {
              questionIndex: index,
              optionIndices: [optionIndex],
              optionLabels: [sent.text],
              customText: null,
            }
          : {
              questionIndex: index,
              optionIndices: [],
              optionLabels: [],
              customText: sent.text,
            },
    };
  });
  return { kind: "answer", answers };
}

/** Allow and Deny; held, with the chosen one's spinner, while it is sent. */
function SurfaceDecision(props: {
  readonly busy: boolean;
  /** The decision on its way; `null` for none. */
  readonly pending: boolean | null;
  readonly onDecide: (approved: boolean) => void;
}): ReactElement {
  const { busy, pending, onDecide } = props;
  const spinner = (
    <AgentSpinningDots
      className={undefined}
      testId="bot-surface-card-sending"
      variant={undefined}
    />
  );
  return (
    <div className="flex items-center gap-1.5">
      <Button
        type="button"
        size="xs"
        disabled={busy}
        data-testid="bot-surface-card-allow"
        onClick={() => onDecide(true)}
      >
        Allow
        {busy && pending === true ? spinner : null}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={busy}
        data-testid="bot-surface-card-deny"
        onClick={() => onDecide(false)}
      >
        Deny
        {busy && pending === false ? spinner : null}
      </Button>
    </div>
  );
}

function sameAction(a: BotSurfaceAction, b: BotSurfaceAction): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
