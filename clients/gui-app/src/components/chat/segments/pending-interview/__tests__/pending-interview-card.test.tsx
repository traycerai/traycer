import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  InterviewAnswer,
  InterviewQuestion,
} from "@traycer/protocol/persistence/epic/schemas";
import { PendingInterviewCard } from "@/components/chat/segments/pending-interview/pending-interview-card";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import { TooltipProvider } from "@/components/ui/tooltip";

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
  return render(
    <TooltipProvider>
      <PendingInterviewCard
        blockId="interview-1"
        toolName="AskUserQuestion"
        title="AskUserQuestion"
        description="Choose the path to continue."
        questions={questions}
        isActive
        onSubmit={onSubmit}
        onSkip={onSkip}
        onFork={null}
      />
    </TooltipProvider>,
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
          blockId="bg"
          toolName={null}
          title={null}
          description={null}
          questions={[singleSelect("q", "Question?", ["Alpha", "Beta"])]}
          isActive={false}
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
          blockId="fg"
          toolName={null}
          title={null}
          description={null}
          questions={[singleSelect("q", "Question?", ["Alpha", "Beta"])]}
          isActive
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
