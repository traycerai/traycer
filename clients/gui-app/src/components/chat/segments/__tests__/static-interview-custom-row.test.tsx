import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { InterviewQuestion } from "@traycer/protocol/persistence/epic/schemas";
import { StaticInterviewOptions } from "@/components/chat/segments/interview-visuals";

/**
 * The RESOLVED transcript's half of the withdrawn-free-text contract.
 *
 * The pending card stops offering Other when `allowsCustomAnswer` is `false`;
 * the historical card renders the same question from stored answers, and used
 * to append the row unconditionally. That showed the user an answer choice
 * they were never allowed to pick - numbered `options.length + 1`, the exact
 * digit the live card refuses.
 */
function question(
  allowsCustomAnswer: boolean | null,
  labels: ReadonlyArray<string>,
): InterviewQuestion {
  return {
    questionId: "q1",
    question: "Which one?",
    header: null,
    options: labels.map((label) => ({
      label,
      description: null,
      preview: null,
    })),
    multiSelect: false,
    allowsCustomAnswer,
  };
}

function renderOptions(props: {
  readonly question: InterviewQuestion;
  readonly customText: string | null;
}) {
  render(
    <StaticInterviewOptions
      question={props.question}
      selectedOptionIndices={[0]}
      customText={props.customText}
      optionFindUnitIds={props.question.options.map(() => ({
        label: null,
        description: null,
        preview: null,
      }))}
      customFindUnitId={null}
      pinnedDetailOptionIndex={null}
    />,
  );
}

// `globals: false` in this workspace's vitest config, so Testing Library's
// auto-cleanup never registers. Without this each case inherits the previous
// one's DOM and a `getByText` that should find one row finds two.
afterEach(cleanup);

describe("StaticInterviewOptions and the withdrawn custom-answer channel", () => {
  it("omits the Other row for a listed-only question", () => {
    // FALSIFICATION: drop the `showsCustomRow` gate and this reddens while
    // both arms below stay green.
    renderOptions({
      question: question(false, ["Alpha", "Beta"]),
      customText: null,
    });

    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Other")).toBeNull();
  });

  it("CONTROL: keeps it when the channel was never withdrawn", () => {
    // `null` is UNSTATED, and every transcript persisted before the field
    // existed reads that way. Without this arm the first one would pass
    // against a gate that hides the row for everyone.
    renderOptions({
      question: question(null, ["Alpha", "Beta"]),
      customText: null,
    });

    expect(screen.getByText("Other")).toBeTruthy();
  });

  it("keeps a custom answer that was actually given, even once withdrawn", () => {
    // Withdrawal governs what is OFFERED, not what was already said: a row
    // answered under the old contract still carries the user's own words, and
    // hiding it would delete them from the transcript. This is also what keeps
    // the renderer in step with `interview-review-model`, which registers the
    // `custom` find unit on exactly this condition (`customText !== null`) -
    // gating the row any tighter would leave chat-find a target that renders
    // nothing.
    renderOptions({
      question: question(false, ["Alpha", "Beta"]),
      customText: "something the user typed",
    });

    expect(screen.getByText("something the user typed")).toBeTruthy();
  });

  it("renders radio glyphs on listed single-choice rows, not on Other", () => {
    renderOptions({
      question: question(null, ["Alpha", "Beta"]),
      customText: null,
    });

    expect(
      document.querySelectorAll('[data-interview-choice-glyph="radio"]'),
    ).toHaveLength(2);
    expect(
      document.querySelector('[data-interview-choice-glyph="checkbox"]'),
    ).toBeNull();
    expect(screen.getByText("Other")).toBeTruthy();
  });

  it("renders checkbox glyphs on listed multi-choice rows", () => {
    renderOptions({
      question: { ...question(false, ["Alpha", "Beta"]), multiSelect: true },
      customText: null,
    });

    expect(
      document.querySelectorAll('[data-interview-choice-glyph="checkbox"]'),
    ).toHaveLength(2);
    expect(
      document.querySelector('[data-interview-choice-glyph="radio"]'),
    ).toBeNull();
    const selected = document.querySelector(
      '[data-interview-choice-glyph="checkbox"][data-selected="true"]',
    );
    expect(selected).not.toBeNull();
  });
});
