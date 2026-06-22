import { useEffect, useEffectEvent, useRef, useState } from "react";
import type {
  InterviewAnswer,
  InterviewQuestion,
} from "@traycer/protocol/persistence/epic/schemas";
import { registerComposerFocus } from "@/lib/composer/composer-focus-registry";
import {
  draftHasContent,
  draftToAnswerValues,
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
  blockId: string;
  questions: ReadonlyArray<InterviewQuestion>;
  // Whether this card's chat tab is the active one in its pane. Gates focus so
  // a pending interview in a background pane never steals focus, and the card
  // refocuses when its tab/pane becomes active - the same contract the Tiptap
  // composer follows.
  isActive: boolean;
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
  const { blockId, questions, isActive, onSubmit, onSkip } = args;

  // Where the pager is and which way it last moved - the question transition
  // animates along `step`, so the two always change together.
  const [page, setPage] = useState<{ index: number; step: 1 | -1 }>({
    index: 0,
    step: 1,
  });
  const [drafts, setDrafts] = useState<ReadonlyArray<DraftAnswer>>(() =>
    questions.map(() => emptyDraft()),
  );
  // Once the user submits or skips we lock the affordances. The parent
  // remounts this card via `key={blockId}` when the next interview arrives,
  // so this flag never needs to clear on its own.
  const [dispatched, setDispatched] = useState<boolean>(false);
  // The just-picked single-select option, highlighted until auto-advance.
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);

  const containerRef = useRef<HTMLElement | null>(null);
  const advanceTimerRef = useRef<number | null>(null);

  const total = questions.length;
  const safeIndex = Math.min(Math.max(page.index, 0), Math.max(total - 1, 0));
  const question = total > 0 ? questions[safeIndex] : null;
  const draft = drafts[safeIndex] ?? emptyDraft();
  const freeTextQuestion = question !== null && question.options.length === 0;

  const isLast = safeIndex >= total - 1;
  const answeredCount = drafts.filter(draftHasContent).length;
  const canAdvance = total > 0 && safeIndex < total - 1 && !dispatched;
  const canSubmit = total > 0 && onSubmit !== null && !dispatched;
  const canSkip = onSkip !== null && !dispatched;

  const updateDraft = (next: DraftAnswer): ReadonlyArray<DraftAnswer> => {
    const nextDrafts = replaceDraftAt(drafts, safeIndex, next);
    setDrafts(nextDrafts);
    return nextDrafts;
  };

  const clearAdvanceTimer = () => {
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  };

  const navigate = (step: 1 | -1) => {
    clearAdvanceTimer();
    setPendingLabel(null);
    setPage(({ index }) => ({
      index: Math.min(Math.max(index + step, 0), Math.max(total - 1, 0)),
      step,
    }));
  };

  const goNext = () => navigate(1);
  const goPrevious = () => navigate(-1);

  const submitDrafts = (answerDrafts: ReadonlyArray<DraftAnswer>) => {
    if (onSubmit === null || dispatched) return;
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
    const clientActionId = onSubmit(blockId, answers);
    if (clientActionId === null) return;
    setDispatched(true);
  };

  const submit = () => {
    submitDrafts(drafts);
  };

  const proceed = () => {
    if (dispatched) return;
    if (isLast) submit();
    else goNext();
  };

  const skip = () => {
    if (!canSkip) return;
    clearAdvanceTimer();
    setPendingLabel(null);
    const clientActionId = onSkip(blockId, "Skipped by user");
    if (clientActionId === null) return;
    setDispatched(true);
  };

  const toggleOption = (label: string) => {
    if (question === null || dispatched) return;
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
    const nextDrafts = updateDraft({
      ...draft,
      selected: new Set([label]),
      otherSelected: false,
    });
    setPendingLabel(label);
    clearAdvanceTimer();
    advanceTimerRef.current = window.setTimeout(() => {
      advanceTimerRef.current = null;
      if (isLast) submitDrafts(nextDrafts);
      else goNext();
    }, ADVANCE_DELAY_MS);
  };

  const toggleOther = () => {
    if (question === null || dispatched) return;
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
    updateDraft({ ...draft, otherText: text });
  };

  const setFreeText = (text: string) => {
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
    if (dispatched) return;
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
    direction: page.step,
    pendingLabel,
    dispatched,
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
