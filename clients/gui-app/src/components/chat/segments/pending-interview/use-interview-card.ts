import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type {
  InterviewAnswer,
  InterviewQuestion,
} from "@traycer/protocol/persistence/epic/schemas";
import { registerComposerFocus } from "@/lib/composer/composer-focus-registry";
import {
  readInterviewDraftSnapshot,
  selectInterviewDraft,
  useInterviewDraftStore,
} from "@/stores/composer/interview-draft-store";
import {
  draftFromStoredAnswer,
  draftHasContent,
  draftHasState,
  draftToAnswerValues,
  draftToStoredAnswer,
  emptyDraft,
  replaceDraftAt,
  type DraftAnswer,
} from "./interview-draft";

// Brief window where the just-picked single-select option stays highlighted
// before the card auto-advances, so the choice visibly registers. The page
// transition runs at the same speed so the two motions read as one.
const ADVANCE_DELAY_MS = 110;
export const QUESTION_TRANSITION = {
  duration: ADVANCE_DELAY_MS / 1000,
  ease: "easeOut",
} as const;

// True when the key event originated inside a text field, so digit shortcuts
// must defer to normal typing.
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "TEXTAREA" ||
    target.tagName === "INPUT" ||
    target.isContentEditable
  );
}

// Only a multi-line textarea needs Enter for newlines; the single-line Other
// input lets Enter proceed/submit.
function isMultilineField(target: EventTarget | null): boolean {
  return (
    (target instanceof HTMLElement && target.tagName === "TEXTAREA") ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

// Buttons self-activate on Enter natively (options, Skip, the pager, Submit),
// so the card-level Enter handler defers to whichever button has focus.
function isButtonTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLButtonElement;
}

// Maps a bare "1".."9" key to its number; everything else is null.
function digitFromEventKey(key: string): number | null {
  if (key.length !== 1 || key < "1" || key > "9") return null;
  return Number.parseInt(key, 10);
}

interface UseInterviewCardArgs {
  chatId: string;
  blockId: string;
  questions: ReadonlyArray<InterviewQuestion>;
  // Whether this card's chat tab is the active one in its pane. Gates focus so
  // a pending interview in a background pane never steals focus, and the card
  // refocuses when its tab/pane becomes active - the same contract the Tiptap
  // composer follows.
  isActive: boolean;
  // True while a Submit/Skip this card sent is still in flight or accepted but
  // not yet resolved by the host (derived from the chat session's pending /
  // accepted actions, scoped to this block). Gates every affordance so the same
  // action cannot be double-sent; it clears on a rejected/failed ack, leaving
  // the retained draft for retry.
  isBusy: boolean;
  onSubmit:
    | ((
        blockId: string,
        answers: ReadonlyArray<InterviewAnswer>,
      ) => string | null)
    | null;
  onSkip: ((blockId: string, reason: string) => string | null) | null;
}

// Owns every behavior of the pending interview card - draft state, paging,
// the highlight-then-advance timer, dispatch locking, and the keyboard
// shortcuts - so the components stay purely presentational. Attach
// `containerRef` to the focusable card element.
export function useInterviewCard(args: UseInterviewCardArgs) {
  const { chatId, blockId, questions, isActive, isBusy, onSubmit, onSkip } =
    args;
  const total = questions.length;

  // The persisted row for THIS (chat, block) is the canonical draft state.
  // Subscribing (rather than reading it once) keeps duplicate live views of the
  // same chat in lockstep and means a write always merges against the latest
  // answers, so one view can never overwrite another's progress with a stale
  // full snapshot. The row is a stable reference between unrelated store writes,
  // so this selector never churns renders. `selectInterviewDraft` reads through
  // own-property checks so a `"__proto__"` id resolves to null, not the
  // prototype.
  const storedDraft = useInterviewDraftStore((state) =>
    selectInterviewDraft(state.draftsByChat, chatId, blockId),
  );
  const saveStoredDraft = useInterviewDraftStore((state) => state.saveDraft);
  const clearStoredDraft = useInterviewDraftStore((state) => state.clearDraft);

  // The pager INDEX is canonical (persisted with the row); `step` is per-view
  // ephemeral animation direction and never persists.
  const [step, setStep] = useState<1 | -1>(1);
  // The just-picked single-select option, highlighted until auto-advance.
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);

  const containerRef = useRef<HTMLElement | null>(null);
  const advanceTimerRef = useRef<number | null>(null);
  // The single-select advance timer (~110ms) closes over `submitDrafts`/
  // `navigate` from the render that scheduled it, which in turn closed over
  // that render's `isBusy`. If another live view sends an action before the
  // timer fires, this render's `isBusy` guard inside those functions is
  // already stale. Track the latest value in a ref so the timer can re-check
  // it at fire time instead of trusting its own scheduling-time snapshot.
  const latestIsBusyRef = useRef(isBusy);
  useEffect(() => {
    latestIsBusyRef.current = isBusy;
  }, [isBusy]);

  const drafts = useMemo(
    () =>
      questions.map((question, index) =>
        draftFromStoredAnswer(storedDraft?.answers[index], question),
      ),
    [questions, storedDraft],
  );

  const safeIndex = Math.min(
    Math.max(storedDraft?.pageIndex ?? 0, 0),
    Math.max(total - 1, 0),
  );
  const question = total > 0 ? questions[safeIndex] : null;
  const draft = drafts[safeIndex] ?? emptyDraft();
  const freeTextQuestion = question !== null && question.options.length === 0;

  const isLast = safeIndex >= total - 1;
  const answeredCount = drafts.filter(draftHasContent).length;
  // `isBusy` is the ack-aware gate: an interview action this card sent is in
  // flight or accepted-but-unresolved. It blocks re-sends, edits, paging,
  // keyboard actions, and forks. It clears on a rejected/failed ack (the
  // interview stays pending), so the retained draft is retryable then - but not
  // an immediate double-submit while the first send is still live.
  const canAdvance = total > 0 && safeIndex < total - 1 && !isBusy;
  const canSubmit = total > 0 && onSubmit !== null && !isBusy;
  const canSkip = onSkip !== null && !isBusy;

  // Read the LATEST canonical row at call time rather than trusting a
  // render-time closure. A delayed single-select callback (see `toggleOption`)
  // fires ~110ms later, by which point a duplicate view may have edited the
  // answers or navigated to another page; replaying a captured snapshot would
  // clobber it. The page index is clamped exactly like `safeIndex` so the two
  // are comparable.
  const readCanonicalState = () => {
    const latest = readInterviewDraftSnapshot(chatId, blockId);
    return {
      pageIndex: Math.min(
        Math.max(latest?.pageIndex ?? 0, 0),
        Math.max(total - 1, 0),
      ),
      drafts: questions.map((question, index) =>
        draftFromStoredAnswer(latest?.answers[index], question),
      ),
    };
  };

  // Write with the originating action so a tab switch cannot unmount the card
  // before an effect flushes. Untouched interviews never create stored rows.
  const persistDraft = (
    nextPageIndex: number,
    nextDrafts: ReadonlyArray<DraftAnswer>,
  ) => {
    if (nextPageIndex === 0 && !nextDrafts.some(draftHasState)) {
      clearStoredDraft(chatId, blockId);
      return;
    }
    saveStoredDraft(chatId, blockId, {
      pageIndex: nextPageIndex,
      answers: nextDrafts.map(draftToStoredAnswer),
    });
  };

  const updateDraft = (next: DraftAnswer): ReadonlyArray<DraftAnswer> => {
    const nextDrafts = replaceDraftAt(drafts, safeIndex, next);
    // Persisting is the only write: the store subscription re-derives `drafts`
    // and re-renders, so there is no separate local copy to drift out of sync.
    persistDraft(safeIndex, nextDrafts);
    return nextDrafts;
  };

  const clearAdvanceTimer = () => {
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  };

  const navigate = (
    direction: 1 | -1,
    answerDrafts: ReadonlyArray<DraftAnswer>,
  ) => {
    if (isBusy) return;
    clearAdvanceTimer();
    setPendingLabel(null);
    const nextIndex = Math.min(
      Math.max(safeIndex + direction, 0),
      Math.max(total - 1, 0),
    );
    setStep(direction);
    // The index is canonical: persist it so the subscription moves this view
    // (and any duplicate view) to the new page.
    persistDraft(nextIndex, answerDrafts);
  };

  const goNext = () => navigate(1, drafts);
  const goPrevious = () => navigate(-1, drafts);

  const submitDrafts = (answerDrafts: ReadonlyArray<DraftAnswer>) => {
    if (onSubmit === null || isBusy) return;
    clearAdvanceTimer();
    // Submit is unconditional: unanswered questions go through with empty
    // values (draftToAnswerValues returns [] for an empty draft).
    const answers: InterviewAnswer[] = questions.map((q, i) => ({
      questionId: q.questionId,
      question: q.question,
      values: [...draftToAnswerValues(answerDrafts[i] ?? emptyDraft())],
      notes: null,
    }));
    setPendingLabel(null);
    // Fire and keep the draft: a returned client action id only proves the
    // renderer sent the action, not that the host accepted it. The draft is
    // cleared authoritatively when the interviewAnswered lifecycle frame lands
    // (chat-session-store); a rejection keeps it for retry.
    onSubmit(blockId, answers);
  };

  const submit = () => {
    submitDrafts(drafts);
  };

  const proceed = () => {
    if (isBusy) return;
    if (isLast) submit();
    else goNext();
  };

  const skip = () => {
    if (!canSkip) return;
    clearAdvanceTimer();
    setPendingLabel(null);
    // Same lifecycle contract as submit: keep the draft until the authoritative
    // interviewErrored frame clears it, so a rejected skip stays retryable.
    onSkip(blockId, "Skipped by user");
  };

  const toggleOption = (label: string) => {
    if (question === null || isBusy) return;
    if (question.multiSelect) {
      const next = new Set(draft.selected);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      updateDraft({ ...draft, selected: next });
      return;
    }
    // Single-select: commit the choice, hold a brief highlight, then advance.
    // Re-picking during the highlight window replaces the choice and restarts
    // the timer, so a quick correction is never swallowed.
    updateDraft({
      ...draft,
      selected: new Set([label]),
      otherSelected: false,
    });
    setPendingLabel(label);
    clearAdvanceTimer();
    advanceTimerRef.current = window.setTimeout(() => {
      advanceTimerRef.current = null;
      // Re-check busy state at fire time: another live view may have sent an
      // action during the highlight window, making this scheduling-time
      // snapshot stale. Submitting or advancing now would mutate state (or
      // double-dispatch) while busy.
      if (latestIsBusyRef.current) {
        setPendingLabel(null);
        return;
      }
      // Re-derive from the LATEST canonical row at fire time. A duplicate view
      // may have changed this answer or the page during the highlight window.
      const latest = readCanonicalState();
      // No-op when the canonical page moved off the question this timer was
      // armed on: a duplicate view explicitly navigated (Previous/Next), and
      // submitting or advancing from here would override that navigation -
      // e.g. stale-submitting the last question the other view just left, or
      // rewinding a view that advanced further ahead.
      if (latest.pageIndex !== safeIndex) {
        setPendingLabel(null);
        return;
      }
      const currentAnswer = latest.drafts[safeIndex] ?? emptyDraft();
      // No-op when this single-select choice was superseded (another view
      // picked Other, a different option, or cleared it): that view drives its
      // own advance, and replaying our stale choice would clobber it.
      const stillOurChoice =
        !currentAnswer.otherSelected &&
        currentAnswer.selected.size === 1 &&
        currentAnswer.selected.has(label);
      if (!stillOurChoice) {
        setPendingLabel(null);
        return;
      }
      // Submit / page-advance against the LATEST canonical answers, never the
      // captured snapshot.
      if (isLast) submitDrafts(latest.drafts);
      else navigate(1, latest.drafts);
    }, ADVANCE_DELAY_MS);
  };

  const toggleOther = () => {
    if (question === null || isBusy) return;
    // Diverting to a custom answer cancels any pending single-select advance.
    clearAdvanceTimer();
    setPendingLabel(null);
    if (question.multiSelect) {
      updateDraft({ ...draft, otherSelected: !draft.otherSelected });
      return;
    }
    updateDraft({
      ...draft,
      selected: new Set(),
      otherSelected: !draft.otherSelected,
    });
  };

  const setOtherText = (text: string) => {
    if (isBusy) return;
    updateDraft({ ...draft, otherText: text });
  };

  const setFreeText = (text: string) => {
    if (isBusy) return;
    updateDraft({ ...draft, otherText: text, otherSelected: true });
  };

  // Pick the option/Other bound to a bare digit; returns false when the key is
  // not a usable digit so the caller leaves the event untouched.
  const selectByDigit = (key: string): boolean => {
    if (question === null) return false;
    const digit = digitFromEventKey(key);
    if (digit === null) return false;
    const optionCount = question.options.length;
    if (optionCount === 0) return false;
    if (digit >= 1 && digit <= optionCount) {
      toggleOption(question.options[digit - 1].label);
      return true;
    }
    if (digit === optionCount + 1) {
      toggleOther();
      return true;
    }
    return false;
  };

  // mod+Enter always proceeds. Plain Enter proceeds too, unless focus is in a
  // multi-line textarea (newline) or on any button (it self-activates). The
  // single-line Other input lets plain Enter proceed/submit.
  const handleEnter = (event: KeyboardEvent): boolean => {
    const modKey = event.metaKey || event.ctrlKey;
    if (
      !modKey &&
      (isMultilineField(event.target) ||
        event.shiftKey ||
        isButtonTarget(event.target))
    )
      return false;
    proceed();
    return true;
  };

  // Two-stage Escape: a focused text field blurs back to the card first; a
  // second Escape on the card then skips the interview.
  const handleEscape = (editable: boolean): boolean => {
    if (editable) containerRef.current?.focus({ preventScroll: true });
    else skip();
    return true;
  };

  const handleDigitKey = (event: KeyboardEvent, editable: boolean): boolean => {
    const modKey = event.metaKey || event.ctrlKey;
    if (editable || modKey || event.shiftKey || event.altKey) return false;
    return selectByDigit(event.key);
  };

  // The card-level key handler owns the number / Enter / Arrow / Escape
  // shortcuts while the inner option buttons keep native focus order and
  // Enter/Space activation. It is a native listener (not JSX onKeyDown)
  // because no honest ARIA widget role fits this container, and
  // jsx-a11y/no-noninteractive-element-interactions correctly rejects JSX key
  // handlers on non-widget elements; useEffectEvent keeps it on fresh state.
  const handleKey = useEffectEvent((event: KeyboardEvent) => {
    if (isBusy) return;
    const editable = isEditableTarget(event.target);
    let handled = false;
    if (event.key === "Enter") handled = handleEnter(event);
    else if (event.key === "Escape") handled = handleEscape(editable);
    else if (event.key === "ArrowLeft" && !editable) {
      goPrevious();
      handled = true;
    } else if (event.key === "ArrowRight" && !editable) {
      // Forward scan: advance to the next question without answering (capped at
      // the last; it never submits, unlike Enter).
      goNext();
      handled = true;
    } else handled = handleDigitKey(event, editable);
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  useEffect(() => {
    const node = containerRef.current;
    if (node === null) return;
    const listener = (event: KeyboardEvent) => handleKey(event);
    node.addEventListener("keydown", listener);
    return () => node.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    const timerRef = advanceTimerRef;
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // Auto-focus the card when active, on appear and on every question change, so
  // number keys work with zero clicks. Skipped while inactive so a pending
  // interview in a background pane never steals focus; refocuses when the tab
  // becomes active (isActive is a dependency). Free-text and Other inputs focus
  // themselves via their callback ref, so the card yields to them.
  //
  // The focus is deferred one frame because activating a pane fires on the
  // pane's pointerdown (TabGroupView's onPointerDownCapture). React flushes this
  // effect right before the trailing mousedown, whose native focus would
  // otherwise land on the clicked transcript/pane element and steal focus away
  // from the card. rAF runs after that native focus, so the card keeps it.
  // Keyboard activation (⌘L) has no trailing pointer focus and is unaffected.
  const wantsFieldFocus = freeTextQuestion || draft.otherSelected;
  useEffect(() => {
    if (!isActive || wantsFieldFocus) return;
    const frame = window.requestAnimationFrame(() => {
      containerRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [safeIndex, isActive, wantsFieldFocus]);

  // Join the composer focus registry so the active-pane focus flow and the
  // "focus editor" shortcut reach this card - it stands in for the Tiptap
  // composer it replaced. Prefer the open text field, else the card itself.
  useEffect(() => {
    return registerComposerFocus(() => {
      const node = containerRef.current;
      if (node === null) return;
      const field = node.querySelector<HTMLElement>("textarea, input");
      (field ?? node).focus({ preventScroll: true });
    }, isActive);
  }, [isActive]);

  return {
    containerRef,
    total,
    safeIndex,
    question,
    draft,
    direction: step,
    pendingLabel,
    isLast,
    answeredCount,
    canAdvance,
    canSubmit,
    canSkip,
    goNext,
    goPrevious,
    skip,
    submit,
    toggleOption,
    toggleOther,
    setOtherText,
    setFreeText,
  };
}
