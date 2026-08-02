import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  InterviewAnswer,
  InterviewQuestion,
} from "@traycer/protocol/persistence/epic/schemas";
import { PendingInterviewCard } from "@/components/chat/segments/pending-interview/pending-interview-card";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import { TooltipProvider } from "@/components/ui/tooltip";
import { interviewDraftKey } from "@/lib/persist";
import {
  readInterviewDraftSnapshot,
  rehydrateInterviewDraftsFromStorage,
  useInterviewDraftStore,
} from "@/stores/composer/interview-draft-store";
import type { ChatForkMode } from "@/components/chat/chat-message";

// Slightly longer than the card's ~110ms highlight-then-advance window.
const ADVANCE_MS = 200;

function singleSelect(
  id: string,
  question: string,
  labels: ReadonlyArray<string>,
): InterviewQuestion {
  return {
    questionId: id,
    question,
    header: null,
    options: labels.map((label) => ({
      label,
      description: null,
      preview: null,
    })),
    multiSelect: false,
  };
}

function multiSelect(
  id: string,
  question: string,
  labels: ReadonlyArray<string>,
): InterviewQuestion {
  return { ...singleSelect(id, question, labels), multiSelect: true };
}

function renderCard(
  questions: ReadonlyArray<InterviewQuestion>,
  onSubmit:
    | ((
        blockId: string,
        answers: ReadonlyArray<InterviewAnswer>,
      ) => string | null)
    | null,
  onSkip: ((blockId: string, reason: string) => string | null) | null,
) {
  return renderCardFor({
    chatId: "chat-1",
    blockId: "interview-1",
    questions,
    isBusy: false,
    onSubmit,
    onSkip,
    onFork: null,
  });
}

function renderCardFor(args: {
  readonly chatId: string;
  readonly blockId: string;
  readonly questions: ReadonlyArray<InterviewQuestion>;
  readonly isBusy: boolean;
  readonly onSubmit:
    | ((
        blockId: string,
        answers: ReadonlyArray<InterviewAnswer>,
      ) => string | null)
    | null;
  readonly onSkip: ((blockId: string, reason: string) => string | null) | null;
  readonly onFork: ((mode: ChatForkMode) => void) | null;
}) {
  return render(
    <TooltipProvider>
      <PendingInterviewCard
        chatId={args.chatId}
        blockId={args.blockId}
        toolName="AskUserQuestion"
        title="AskUserQuestion"
        description="Choose the path to continue."
        questions={args.questions}
        isActive
        isBusy={args.isBusy}
        onSubmit={args.onSubmit}
        onSkip={args.onSkip}
        onFork={args.onFork}
      />
    </TooltipProvider>,
  );
}

function cardElement(args: {
  readonly chatId: string;
  readonly blockId: string;
  readonly questions: ReadonlyArray<InterviewQuestion>;
  readonly isBusy: boolean;
  readonly onSubmit:
    | ((
        blockId: string,
        answers: ReadonlyArray<InterviewAnswer>,
      ) => string | null)
    | null;
  readonly onSkip: ((blockId: string, reason: string) => string | null) | null;
  readonly onFork: ((mode: ChatForkMode) => void) | null;
}) {
  return (
    <PendingInterviewCard
      chatId={args.chatId}
      blockId={args.blockId}
      toolName="AskUserQuestion"
      title="AskUserQuestion"
      description="Choose the path to continue."
      questions={args.questions}
      isActive
      isBusy={args.isBusy}
      onSubmit={args.onSubmit}
      onSkip={args.onSkip}
      onFork={args.onFork}
    />
  );
}

function card(): HTMLElement {
  return screen.getByTestId("interview-card");
}

// The proceed (Next/Submit) action button, identified by its ⏎ shortcut hint -
// distinct from the pager's "Next question" / "Previous question" buttons.
function proceedButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: /↵/ });
}

describe("PendingInterviewCard keyboard navigation", () => {
  afterEach(() => {
    cleanup();
    useInterviewDraftStore.setState({ draftsByChat: {} });
    window.localStorage.clear();
  });

  it("restores each chat's current question and answers after remount", () => {
    const questions = [
      multiSelect("q1", "Pick some", ["Alpha", "Beta"]),
      singleSelect("q2", "Describe it", []),
    ];
    const firstChat = renderCardFor({
      chatId: "chat-1",
      blockId: "shared-block-id",
      questions,
      isBusy: false,
      onSubmit: vi.fn(),
      onSkip: null,
      onFork: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "1. Alpha" }));
    fireEvent.click(proceedButton());
    fireEvent.change(screen.getByLabelText("Interview answer"), {
      target: { value: "Keep this draft" },
    });
    firstChat.unmount();

    const otherChat = renderCardFor({
      chatId: "chat-2",
      blockId: "shared-block-id",
      questions,
      isBusy: false,
      onSubmit: vi.fn(),
      onSkip: null,
      onFork: null,
    });
    expect(screen.getByText("Pick some")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "1. Alpha", pressed: false }),
    ).toBeTruthy();
    otherChat.unmount();

    renderCardFor({
      chatId: "chat-1",
      blockId: "shared-block-id",
      questions,
      isBusy: false,
      onSubmit: vi.fn(),
      onSkip: null,
      onFork: null,
    });
    expect(screen.getByText("Describe it")).toBeTruthy();
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Interview answer").value,
    ).toBe("Keep this draft");
    fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
    expect(
      screen.getByRole("button", { name: "1. Alpha", pressed: true }),
    ).toBeTruthy();
  });

  it("retains the persisted draft after Submit returns an action id", () => {
    renderCard(
      [singleSelect("free", "Describe it", [])],
      vi.fn(() => "action-1"),
      null,
    );
    fireEvent.change(screen.getByLabelText("Interview answer"), {
      target: { value: "Ready to send" },
    });
    expect(
      useInterviewDraftStore.getState().draftsByChat["chat-1"]?.["interview-1"],
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    // Clearing is deferred to the host interviewAnswered frame; the isolated
    // card never clears on dispatch acceptance.
    expect(
      useInterviewDraftStore.getState().draftsByChat["chat-1"]?.["interview-1"],
    ).toBeDefined();
  });

  it("retains the persisted draft after Skip returns an action id", () => {
    renderCard(
      [singleSelect("free", "Describe it", [])],
      vi.fn(),
      vi.fn(() => "action-1"),
    );
    fireEvent.change(screen.getByLabelText("Interview answer"), {
      target: { value: "Keep this draft for retry" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));

    expect(
      useInterviewDraftStore.getState().draftsByChat["chat-1"]?.["interview-1"],
    ).toBeDefined();
  });

  it("locks the card while busy, retains the draft, and unlocks for retry after rejection", () => {
    const onSubmit = vi.fn(() => "action-1");
    const onSkip = vi.fn(() => "skip-1");
    const questions = [singleSelect("free", "Describe it", [])];
    const view = render(
      <TooltipProvider>
        {cardElement({
          chatId: "chat-1",
          blockId: "interview-1",
          questions: questions,
          isBusy: false,
          onSubmit: onSubmit,
          onSkip: onSkip,
          onFork: null,
        })}
      </TooltipProvider>,
    );

    fireEvent.change(screen.getByLabelText("Interview answer"), {
      target: { value: "Retryable answer" },
    });
    expect(
      useInterviewDraftStore.getState().draftsByChat["chat-1"]?.["interview-1"],
    ).toBeDefined();

    // Simulate in-flight/accepted action: parent drives isBusy true.
    view.rerender(
      <TooltipProvider>
        {cardElement({
          chatId: "chat-1",
          blockId: "interview-1",
          questions: questions,
          isBusy: true,
          onSubmit: onSubmit,
          onSkip: onSkip,
          onFork: null,
        })}
      </TooltipProvider>,
    );

    const submitWhileBusy = screen.getByRole<HTMLButtonElement>("button", {
      name: /Submit/,
    });
    const skipWhileBusy = screen.getByRole<HTMLButtonElement>("button", {
      name: /Skip/,
    });
    expect(submitWhileBusy.disabled).toBe(true);
    expect(skipWhileBusy.disabled).toBe(true);
    fireEvent.click(submitWhileBusy);
    fireEvent.click(skipWhileBusy);
    fireEvent.change(screen.getByLabelText("Interview answer"), {
      target: { value: "should not overwrite" },
    });
    fireEvent.keyDown(card(), { key: "Enter", metaKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Interview answer").value,
    ).toBe("Retryable answer");
    expect(
      useInterviewDraftStore.getState().draftsByChat["chat-1"]?.["interview-1"],
    ).toBeDefined();

    // Rejected ack clears busy; draft retained for retry.
    view.rerender(
      <TooltipProvider>
        {cardElement({
          chatId: "chat-1",
          blockId: "interview-1",
          questions: questions,
          isBusy: false,
          onSubmit: onSubmit,
          onSkip: onSkip,
          onFork: null,
        })}
      </TooltipProvider>,
    );
    const submitUnlocked = screen.getByRole<HTMLButtonElement>("button", {
      name: /Submit/,
    });
    expect(submitUnlocked.disabled).toBe(false);
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Interview answer").value,
    ).toBe("Retryable answer");
    fireEvent.click(submitUnlocked);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(
      useInterviewDraftStore.getState().draftsByChat["chat-1"]?.["interview-1"],
    ).toBeDefined();
  });

  it("refocuses the answer field when a rejection clears the busy gate", () => {
    vi.useFakeTimers();
    try {
      const questions = [singleSelect("free", "Describe it", [])];
      const view = render(
        <TooltipProvider>
          {cardElement({
            chatId: "chat-1",
            blockId: "interview-1",
            questions: questions,
            isBusy: true,
            onSubmit: vi.fn(() => "action-1"),
            onSkip: null,
            onFork: null,
          })}
        </TooltipProvider>,
      );
      act(() => {
        vi.runAllTimers();
      });
      screen.getByLabelText<HTMLTextAreaElement>("Interview answer").blur();

      // Rejected ack clears busy; the field must regain focus so the user
      // can retype without an extra click - a disabled field cannot take
      // focus, so this only works if the ref re-runs once busy clears.
      view.rerender(
        <TooltipProvider>
          {cardElement({
            chatId: "chat-1",
            blockId: "interview-1",
            questions: questions,
            isBusy: false,
            onSubmit: vi.fn(),
            onSkip: null,
            onFork: null,
          })}
        </TooltipProvider>,
      );
      act(() => {
        vi.runAllTimers();
      });

      expect(document.activeElement).toBe(
        screen.getByLabelText("Interview answer"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("locks every affordance while isBusy", () => {
    const onSubmit = vi.fn(() => "action-1");
    const onSkip = vi.fn(() => "skip-1");
    const onFork = vi.fn();
    const questions = [
      singleSelect("q1", "First question?", ["Alpha", "Beta"]),
      singleSelect("q2", "Second question?", ["Gamma"]),
    ];
    useInterviewDraftStore.getState().saveDraft("chat-1", "interview-1", {
      pageIndex: 0,
      answers: [
        { selected: ["Alpha"], otherText: "", otherSelected: false },
        { selected: [], otherText: "", otherSelected: false },
      ],
    });

    render(
      <TooltipProvider>
        {cardElement({
          chatId: "chat-1",
          blockId: "interview-1",
          questions: questions,
          isBusy: true,
          onSubmit: onSubmit,
          onSkip: onSkip,
          onFork: onFork,
        })}
      </TooltipProvider>,
    );

    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /Skip/ }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /↵/ }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Previous question",
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Next question",
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Cross Question",
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "A/B Fork" })
        .disabled,
    ).toBe(true);
    // Option and Other affordances must be natively disabled too, not just
    // rejected in the callback, so they are neither focusable nor exposed as
    // actionable to assistive tech while busy.
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "2. Beta" })
        .disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Other" }).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "2. Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    fireEvent.click(screen.getByRole("button", { name: "Cross Question" }));
    fireEvent.click(screen.getByRole("button", { name: "A/B Fork" }));
    fireEvent.keyDown(card(), { key: "2" });
    fireEvent.keyDown(card(), { key: "ArrowRight" });
    fireEvent.keyDown(card(), { key: "Enter", metaKey: true });
    fireEvent.keyDown(card(), { key: "Escape" });

    expect(screen.getByText("First question?")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "1. Alpha", pressed: true }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "2. Beta", pressed: false }),
    ).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
    expect(onFork).not.toHaveBeenCalled();
    expect(readInterviewDraftSnapshot("chat-1", "interview-1")).toEqual({
      pageIndex: 0,
      answers: [
        { selected: ["Alpha"], otherText: "", otherSelected: false },
        { selected: [], otherText: "", otherSelected: false },
      ],
    });
  });

  it("natively disables the free-text and Other answer fields while isBusy", () => {
    renderCardFor({
      chatId: "chat-1",
      blockId: "interview-1",
      questions: [singleSelect("q1", "Describe it", [])],
      isBusy: true,
      onSubmit: vi.fn(),
      onSkip: null,
      onFork: null,
    });
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Interview answer").disabled,
    ).toBe(true);
  });

  it("keeps duplicate live cards in sync through the canonical store row", () => {
    const questions = [multiSelect("m", "Pick some", ["Alpha", "Beta"])];
    render(
      <TooltipProvider>
        {cardElement({
          chatId: "chat-1",
          blockId: "interview-1",
          questions: questions,
          isBusy: false,
          onSubmit: vi.fn(),
          onSkip: null,
          onFork: null,
        })}
        {cardElement({
          chatId: "chat-1",
          blockId: "interview-1",
          questions: questions,
          isBusy: false,
          onSubmit: vi.fn(),
          onSkip: null,
          onFork: null,
        })}
      </TooltipProvider>,
    );

    const cards = screen.getAllByTestId("interview-card");
    expect(cards).toHaveLength(2);
    const cardA = within(cards[0]);
    const cardB = within(cards[1]);

    fireEvent.click(cardA.getByRole("button", { name: "1. Alpha" }));
    expect(
      cardA.getByRole("button", { name: "1. Alpha", pressed: true }),
    ).toBeTruthy();
    expect(
      cardB.getByRole("button", { name: "1. Alpha", pressed: true }),
    ).toBeTruthy();

    fireEvent.click(cardB.getByRole("button", { name: "2. Beta" }));
    expect(
      cardA.getByRole("button", { name: "2. Beta", pressed: true }),
    ).toBeTruthy();
    expect(
      cardB.getByRole("button", { name: "2. Beta", pressed: true }),
    ).toBeTruthy();
    // Multi-select: Alpha must still be selected after Beta is added in B.
    expect(
      cardA.getByRole("button", { name: "1. Alpha", pressed: true }),
    ).toBeTruthy();
    expect(
      cardB.getByRole("button", { name: "1. Alpha", pressed: true }),
    ).toBeTruthy();
  });

  it("does not auto-advance when a duplicate view supersedes a single-select during the timer", () => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn();
      const questions = [
        singleSelect("q1", "First question?", ["Alpha", "Beta"]),
        singleSelect("q2", "Second question?", ["Gamma"]),
      ];
      render(
        <TooltipProvider>
          {cardElement({
            chatId: "chat-1",
            blockId: "interview-1",
            questions: questions,
            isBusy: false,
            onSubmit: onSubmit,
            onSkip: null,
            onFork: null,
          })}
          {cardElement({
            chatId: "chat-1",
            blockId: "interview-1",
            questions: questions,
            isBusy: false,
            onSubmit: onSubmit,
            onSkip: null,
            onFork: null,
          })}
        </TooltipProvider>,
      );

      const cards = screen.getAllByTestId("interview-card");
      const cardA = within(cards[0]);
      const cardB = within(cards[1]);

      fireEvent.click(cardA.getByRole("button", { name: "1. Alpha" }));
      fireEvent.click(cardB.getByRole("button", { name: "Other" }));
      act(() => {
        vi.advanceTimersByTime(ADVANCE_MS);
      });

      expect(cardA.getByText("First question?")).toBeTruthy();
      expect(cardB.getByText("First question?")).toBeTruthy();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(readInterviewDraftSnapshot("chat-1", "interview-1")).toEqual({
        pageIndex: 0,
        answers: [
          { selected: [], otherText: "", otherSelected: true },
          { selected: [], otherText: "", otherSelected: false },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not stale-submit when a duplicate view supersedes the last-question choice", () => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn();
      const questions = [
        singleSelect("only", "Only question?", ["Alpha", "Beta"]),
      ];
      render(
        <TooltipProvider>
          {cardElement({
            chatId: "chat-1",
            blockId: "interview-1",
            questions: questions,
            isBusy: false,
            onSubmit: onSubmit,
            onSkip: null,
            onFork: null,
          })}
          {cardElement({
            chatId: "chat-1",
            blockId: "interview-1",
            questions: questions,
            isBusy: false,
            onSubmit: onSubmit,
            onSkip: null,
            onFork: null,
          })}
        </TooltipProvider>,
      );

      const cards = screen.getAllByTestId("interview-card");
      const cardA = within(cards[0]);
      const cardB = within(cards[1]);

      fireEvent.click(cardA.getByRole("button", { name: "1. Alpha" }));
      fireEvent.click(cardB.getByRole("button", { name: "Other" }));
      act(() => {
        vi.advanceTimersByTime(ADVANCE_MS);
      });

      expect(onSubmit).not.toHaveBeenCalled();
      expect(readInterviewDraftSnapshot("chat-1", "interview-1")).toEqual({
        pageIndex: 0,
        answers: [{ selected: [], otherText: "", otherSelected: true }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-submits the latest canonical single-select choice when not superseded", () => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn();
      renderCard(
        [singleSelect("only", "Only question?", ["Alpha", "Beta"])],
        onSubmit,
        null,
      );

      fireEvent.click(screen.getByRole("button", { name: "1. Alpha" }));
      act(() => {
        vi.advanceTimersByTime(ADVANCE_MS);
      });

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith("interview-1", [
        expect.objectContaining({ questionId: "only", values: ["Alpha"] }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not submit or advance when another action makes the interview busy before the timer fires", () => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn(() => "action-1");
      const questions = [
        singleSelect("only", "Only question?", ["Alpha", "Beta"]),
      ];
      const view = render(
        <TooltipProvider>
          {cardElement({
            chatId: "chat-1",
            blockId: "interview-1",
            questions: questions,
            isBusy: false,
            onSubmit: onSubmit,
            onSkip: null,
            onFork: null,
          })}
        </TooltipProvider>,
      );

      fireEvent.click(screen.getByRole("button", { name: "1. Alpha" }));
      // Another live view's Submit/Skip is accepted before this timer fires:
      // the parent flips isBusy for the block. The scheduling-time
      // `submitDrafts` closure captured `isBusy: false` and would otherwise
      // still fire.
      view.rerender(
        <TooltipProvider>
          {cardElement({
            chatId: "chat-1",
            blockId: "interview-1",
            questions: questions,
            isBusy: true,
            onSubmit: onSubmit,
            onSkip: null,
            onFork: null,
          })}
        </TooltipProvider>,
      );
      act(() => {
        vi.advanceTimersByTime(ADVANCE_MS);
      });

      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not stale-submit when a duplicate view navigates off the last question during the timer", () => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn();
      const questions = [
        singleSelect("q1", "First question?", ["Alpha", "Beta"]),
        singleSelect("q2", "Second question?", ["Gamma", "Delta"]),
      ];
      render(
        <TooltipProvider>
          {cardElement({
            chatId: "chat-1",
            blockId: "interview-1",
            questions: questions,
            isBusy: false,
            onSubmit: onSubmit,
            onSkip: null,
            onFork: null,
          })}
          {cardElement({
            chatId: "chat-1",
            blockId: "interview-1",
            questions: questions,
            isBusy: false,
            onSubmit: onSubmit,
            onSkip: null,
            onFork: null,
          })}
        </TooltipProvider>,
      );

      const cards = screen.getAllByTestId("interview-card");
      const cardA = within(cards[0]);
      const cardB = within(cards[1]);

      // The page index is canonical, so advancing in A moves both views to the
      // last question. A then picks a single-select there, arming its submit
      // timer; B explicitly navigates back before it fires.
      fireEvent.click(cardA.getByRole("button", { name: "Next question" }));
      fireEvent.click(cardA.getByRole("button", { name: "1. Gamma" }));
      fireEvent.click(cardB.getByRole("button", { name: "Previous question" }));
      act(() => {
        vi.advanceTimersByTime(ADVANCE_MS);
      });

      // The stale timer must not submit or drag both views back to the last
      // page B just left.
      expect(onSubmit).not.toHaveBeenCalled();
      expect(cardA.getByText("First question?")).toBeTruthy();
      expect(cardB.getByText("First question?")).toBeTruthy();
      expect(readInterviewDraftSnapshot("chat-1", "interview-1")).toEqual({
        pageIndex: 0,
        answers: [
          { selected: [], otherText: "", otherSelected: false },
          { selected: ["Gamma"], otherText: "", otherSelected: false },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rewind the page when a duplicate view advances further during the timer", () => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn();
      const questions = [
        singleSelect("q1", "First question?", ["Alpha", "Beta"]),
        singleSelect("q2", "Second question?", ["Gamma", "Delta"]),
        singleSelect("q3", "Third question?", ["Epsilon", "Zeta"]),
      ];
      render(
        <TooltipProvider>
          {cardElement({
            chatId: "chat-1",
            blockId: "interview-1",
            questions: questions,
            isBusy: false,
            onSubmit: onSubmit,
            onSkip: null,
            onFork: null,
          })}
          {cardElement({
            chatId: "chat-1",
            blockId: "interview-1",
            questions: questions,
            isBusy: false,
            onSubmit: onSubmit,
            onSkip: null,
            onFork: null,
          })}
        </TooltipProvider>,
      );

      const cards = screen.getAllByTestId("interview-card");
      const cardA = within(cards[0]);
      const cardB = within(cards[1]);

      // A picks a single-select on the first question, arming its +1 advance
      // timer; B scans two pages ahead before it fires.
      fireEvent.click(cardA.getByRole("button", { name: "1. Alpha" }));
      fireEvent.click(cardB.getByRole("button", { name: "Next question" }));
      fireEvent.click(cardB.getByRole("button", { name: "Next question" }));
      act(() => {
        vi.advanceTimersByTime(ADVANCE_MS);
      });

      // The stale timer must not replay its +1 advance and rewind the views
      // from the page B reached.
      expect(onSubmit).not.toHaveBeenCalled();
      expect(cardA.getByText("Third question?")).toBeTruthy();
      expect(cardB.getByText("Third question?")).toBeTruthy();
      expect(readInterviewDraftSnapshot("chat-1", "interview-1")).toEqual({
        pageIndex: 2,
        answers: [
          { selected: ["Alpha"], otherText: "", otherSelected: false },
          { selected: [], otherText: "", otherSelected: false },
          { selected: [], otherText: "", otherSelected: false },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores page, selected options, and free-text from per-key storage on cold start", () => {
    const questions = [
      multiSelect("q1", "Pick some", ["Alpha", "Beta"]),
      singleSelect("q2", "Describe it", []),
    ];
    const draft = {
      pageIndex: 1,
      answers: [
        {
          selected: ["Alpha"],
          otherText: "",
          otherSelected: false,
        },
        {
          selected: [],
          otherText: "Restored free text",
          otherSelected: true,
        },
      ],
    };
    window.localStorage.setItem(
      interviewDraftKey("chat-1", "interview-1"),
      JSON.stringify(draft),
    );
    // Simulate a cold process: empty in-memory map, then hydrate from keys.
    useInterviewDraftStore.setState({ draftsByChat: {} });
    rehydrateInterviewDraftsFromStorage();

    renderCard(questions, vi.fn(), null);

    expect(screen.getByText("Describe it")).toBeTruthy();
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Interview answer").value,
    ).toBe("Restored free text");

    fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
    expect(
      screen.getByRole("button", { name: "1. Alpha", pressed: true }),
    ).toBeTruthy();
  });

  it("enforces single-select mutual exclusivity when a stored answer has both a selected option and Other", () => {
    const questions = [singleSelect("q1", "Pick one", ["Alpha", "Beta"])];
    const draft = {
      pageIndex: 0,
      answers: [
        {
          // A malformed/legacy stored answer: both a selected option and
          // Other are set for a single-select question.
          selected: ["Alpha"],
          otherText: "custom",
          otherSelected: true,
        },
      ],
    };
    window.localStorage.setItem(
      interviewDraftKey("chat-1", "interview-1"),
      JSON.stringify(draft),
    );
    useInterviewDraftStore.setState({ draftsByChat: {} });
    rehydrateInterviewDraftsFromStorage();

    renderCard(questions, vi.fn(), null);

    // Other wins: the option must not also read as selected.
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Other answer").value,
    ).toBe("custom");
    expect(
      screen.getByRole("button", { name: "1. Alpha", pressed: false }),
    ).toBeTruthy();
  });

  it("selects a single-select option by number and auto-advances", () => {
    vi.useFakeTimers();
    try {
      renderCard(
        [
          singleSelect("q1", "First question?", ["Alpha", "Beta"]),
          singleSelect("q2", "Second question?", ["Gamma"]),
        ],
        vi.fn(),
        null,
      );

      expect(screen.getByText("First question?")).toBeTruthy();
      fireEvent.keyDown(card(), { key: "2" });
      // Selection registers immediately; advance is deferred.
      expect(
        screen.getByRole("button", { name: "2. Beta", pressed: true }),
      ).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(ADVANCE_MS);
      });
      expect(screen.getByText("Second question?")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits on the last single-select question when a number is pressed", () => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn();
      renderCard(
        [singleSelect("only", "Only question?", ["Alpha", "Beta"])],
        onSubmit,
        null,
      );

      fireEvent.keyDown(card(), { key: "1" });
      act(() => {
        vi.advanceTimersByTime(ADVANCE_MS);
      });

      expect(onSubmit).toHaveBeenCalledWith("interview-1", [
        expect.objectContaining({ questionId: "only", values: ["Alpha"] }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a quick re-pick during the advance window replace the choice", () => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn();
      renderCard(
        [singleSelect("only", "Only question?", ["Alpha", "Beta"])],
        onSubmit,
        null,
      );

      fireEvent.keyDown(card(), { key: "1" });
      // Correct the mis-press before the auto-advance fires.
      fireEvent.keyDown(card(), { key: "2" });
      act(() => {
        vi.advanceTimersByTime(ADVANCE_MS);
      });

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith("interview-1", [
        expect.objectContaining({ questionId: "only", values: ["Beta"] }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits with empty values for unanswered questions on Cmd+Enter", () => {
    const onSubmit = vi.fn();
    renderCard(
      [
        singleSelect("q1", "First question?", ["Alpha"]),
        singleSelect("q2", "Second question?", ["Beta"]),
      ],
      onSubmit,
      null,
    );

    // Cmd+Enter on a non-last question advances; on the last it submits the
    // whole interview, leaving the skipped questions empty.
    fireEvent.keyDown(card(), { key: "Enter", metaKey: true });
    expect(screen.getByText("Second question?")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(card(), { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith("interview-1", [
      expect.objectContaining({ questionId: "q1", values: [] }),
      expect.objectContaining({ questionId: "q2", values: [] }),
    ]);
  });

  it("defers plain Enter to a focused button instead of proceeding", () => {
    const onSubmit = vi.fn();
    const onSkip = vi.fn();
    renderCard(
      [
        singleSelect("q1", "First question?", ["Alpha"]),
        singleSelect("q2", "Second question?", ["Beta"]),
      ],
      onSubmit,
      onSkip,
    );

    // Enter on the focused Skip button must activate Skip, not Next/Submit.
    const skipButton = screen.getByRole<HTMLButtonElement>("button", {
      name: /Skip/,
    });
    skipButton.focus();
    fireEvent.keyDown(skipButton, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
    // Still on the first question - the card-level Enter handler deferred.
    expect(screen.getByText("First question?")).toBeTruthy();
  });

  it("toggles multiple options without advancing on a multi-select question", () => {
    renderCard(
      [multiSelect("m", "Pick some", ["Alpha", "Beta", "Gamma"])],
      vi.fn(),
      null,
    );

    fireEvent.keyDown(card(), { key: "1" });
    fireEvent.keyDown(card(), { key: "3" });
    expect(
      screen.getByRole("button", { name: "1. Alpha", pressed: true }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "3. Gamma", pressed: true }),
    ).toBeTruthy();
    // Still on the same question - no auto-advance for multi-select.
    expect(screen.getByText("Pick some")).toBeTruthy();

    fireEvent.keyDown(card(), { key: "1" });
    expect(
      screen.getByRole("button", { name: "1. Alpha", pressed: false }),
    ).toBeTruthy();
  });

  it("morphs the Other row into a textarea when picked with the N+1 number", () => {
    renderCard(
      [singleSelect("q", "Question?", ["Alpha", "Beta"])],
      vi.fn(),
      null,
    );

    // Unselected: a pickable "Other" row, no textarea yet.
    expect(screen.getByRole("button", { name: "Other" })).toBeTruthy();
    expect(screen.queryByLabelText("Other answer")).toBeNull();

    fireEvent.keyDown(card(), { key: "3" });

    // Selected: the row is replaced in place by the multi-line text field.
    expect(screen.queryByRole("button", { name: "Other" })).toBeNull();
    const textarea = screen.getByLabelText("Other answer");
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea.getAttribute("rows")).toBe("1");
    expect(textarea.className).toContain("field-sizing-content");
    expect(textarea.className).toContain("max-h-[3lh]");
    expect(textarea.className).toContain("overflow-y-auto");
  });

  it("ignores digit shortcuts on free-text questions", () => {
    const onSubmit = vi.fn();
    renderCard([singleSelect("free", "Describe it", [])], onSubmit, null);

    const textarea = screen.getByLabelText("Interview answer");
    fireEvent.change(textarea, { target: { value: "typed details" } });
    fireEvent.keyDown(card(), { key: "1" });
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    expect(onSubmit).toHaveBeenCalledWith("interview-1", [
      expect.objectContaining({
        questionId: "free",
        values: ["typed details"],
      }),
    ]);
  });

  it("keeps plain Enter in the Other textarea and submits it with Cmd+Enter", () => {
    const onSubmit = vi.fn();
    renderCard(
      [singleSelect("q", "Question?", ["Alpha", "Beta"])],
      onSubmit,
      null,
    );

    fireEvent.keyDown(card(), { key: "3" });
    const textarea = screen.getByLabelText("Other answer");
    fireEvent.change(textarea, { target: { value: "my own answer" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    expect(onSubmit).toHaveBeenCalledWith("interview-1", [
      expect.objectContaining({ values: ["my own answer"] }),
    ]);
  });

  it("uses a two-stage Escape: blur the input first, then skip", () => {
    const onSkip = vi.fn();
    renderCard(
      [singleSelect("q", "Question?", ["Alpha", "Beta"])],
      vi.fn(),
      onSkip,
    );

    fireEvent.keyDown(card(), { key: "3" });
    const input = screen.getByLabelText("Other answer");

    // First Escape (from the input) returns focus to the card, no skip.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onSkip).not.toHaveBeenCalled();

    // Second Escape (from the card) skips the interview.
    fireEvent.keyDown(card(), { key: "Escape" });
    expect(onSkip).toHaveBeenCalledWith("interview-1", "Skipped by user");
  });

  it("keeps Submit enabled and submits even with nothing answered (mouse)", () => {
    const onSubmit = vi.fn();
    renderCard(
      [
        singleSelect("q1", "First question?", ["Alpha"]),
        singleSelect("q2", "Second question?", ["Beta"]),
      ],
      onSubmit,
      null,
    );

    const next = proceedButton();
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(screen.getByText("Second question?")).toBeTruthy();

    const submit = screen.getByRole<HTMLButtonElement>("button", {
      name: /Submit/,
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledWith("interview-1", [
      expect.objectContaining({ values: [] }),
      expect.objectContaining({ values: [] }),
    ]);
  });

  it("keeps Submit retryable when dispatch cannot send yet", () => {
    const onSubmit = vi.fn(() => null);
    renderCard([singleSelect("q", "Question?", ["Alpha"])], onSubmit, null);

    const submit = screen.getByRole<HTMLButtonElement>("button", {
      name: /Submit/,
    });
    fireEvent.click(submit);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("keeps Skip retryable when dispatch cannot send yet", () => {
    const onSkip = vi.fn(() => null);
    renderCard([singleSelect("q", "Question?", ["Alpha"])], vi.fn(), onSkip);

    const skip = screen.getByRole<HTMLButtonElement>("button", {
      name: /Skip/,
    });
    fireEvent.click(skip);

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(skip.disabled).toBe(false);

    fireEvent.click(skip);
    expect(onSkip).toHaveBeenCalledTimes(2);
  });

  it("scans between questions with the Right and Left arrow keys", () => {
    renderCard(
      [
        singleSelect("q1", "First question?", ["Alpha"]),
        singleSelect("q2", "Second question?", ["Beta"]),
      ],
      vi.fn(),
      null,
    );

    // ArrowRight advances without answering...
    fireEvent.keyDown(card(), { key: "ArrowRight" });
    expect(screen.getByText("Second question?")).toBeTruthy();

    // ...and ArrowLeft goes back.
    fireEvent.keyDown(card(), { key: "ArrowLeft" });
    expect(screen.getByText("First question?")).toBeTruthy();
  });

  it("cancels a pending auto-submit when the interview is skipped", () => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn();
      const onSkip = vi.fn();
      renderCard(
        [singleSelect("only", "Only question?", ["Alpha"])],
        onSubmit,
        onSkip,
      );

      fireEvent.keyDown(card(), { key: "1" });
      fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
      act(() => {
        vi.advanceTimersByTime(ADVANCE_MS);
      });

      expect(onSkip).toHaveBeenCalledWith("interview-1", "Skipped by user");
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not steal focus while its tab is inactive", () => {
    render(
      <TooltipProvider>
        <PendingInterviewCard
          chatId="chat-1"
          blockId="bg"
          toolName={null}
          title={null}
          description={null}
          questions={[singleSelect("q", "Question?", ["Alpha", "Beta"])]}
          isActive={false}
          isBusy={false}
          onSubmit={vi.fn()}
          onSkip={null}
          onFork={null}
        />
      </TooltipProvider>,
    );

    expect(document.activeElement).not.toBe(
      screen.getByTestId("interview-card"),
    );
  });

  it("refocuses through the composer focus registry when active", () => {
    render(
      <TooltipProvider>
        <PendingInterviewCard
          chatId="chat-1"
          blockId="fg"
          toolName={null}
          title={null}
          description={null}
          questions={[singleSelect("q", "Question?", ["Alpha", "Beta"])]}
          isActive
          isBusy={false}
          onSubmit={vi.fn()}
          onSkip={null}
          onFork={null}
        />
      </TooltipProvider>,
    );

    const cardEl = screen.getByTestId("interview-card");
    cardEl.blur();
    // The active-pane focus flow (and ⌘L) reaches the card through the registry.
    expect(focusActiveComposer()).toBe(true);
    expect(document.activeElement).toBe(cardEl);
  });
});
