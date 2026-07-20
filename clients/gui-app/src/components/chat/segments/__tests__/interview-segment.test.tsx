import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterviewSegment } from "@/components/chat/segments/interview-segment";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("InterviewSegment", () => {
  afterEach(cleanup);

  it("shows both fork modes on resolved Q&A without opening the answers", () => {
    const onFork = vi.fn();
    render(
      <TooltipProvider>
        <InterviewSegment
          blockId="interview-1"
          findUnitId="question-1"
          status="completed"
          toolName="AskUserQuestion"
          title="Need input"
          description={null}
          questions={[
            {
              questionId: "q1",
              question: "Which path?",
              header: null,
              options: [],
              multiSelect: false,
            },
          ]}
          answers={[
            {
              questionId: "q1",
              question: "Which path?",
              values: ["Option A"],
              notes: null,
            },
          ]}
          error={null}
          forkedWithoutAnswer={false}
          forkAction={{ enabled: true, pending: false, onFork }}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByText("Which path?")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cross Question" }));
    fireEvent.click(screen.getByRole("button", { name: "A/B Fork" }));

    expect(onFork.mock.calls).toEqual([
      ["cross-question", "interview-1"],
      ["ab-worktree", "interview-1"],
    ]);
    expect(screen.queryByText("Which path?")).toBeNull();
  });

  it("hides fork modes on a carried unanswered reference", () => {
    render(
      <TooltipProvider>
        <InterviewSegment
          blockId="interview-carried"
          findUnitId="question-1"
          status="completed"
          toolName="AskUserQuestion"
          title="Need input"
          description={null}
          questions={[]}
          answers={[]}
          error={null}
          forkedWithoutAnswer
          forkAction={{
            enabled: true,
            pending: false,
            onFork: vi.fn(),
          }}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByRole("button", { name: "Cross Question" })).toBeNull();
    expect(screen.queryByRole("button", { name: "A/B Fork" })).toBeNull();
  });

  it("shows both fork modes after the question is skipped", () => {
    const onFork = vi.fn();
    render(
      <TooltipProvider>
        <InterviewSegment
          blockId="interview-skipped"
          findUnitId="question-skipped"
          status="errored"
          toolName="AskUserQuestion"
          title="Need input"
          description={null}
          questions={[
            {
              questionId: "q1",
              question: "Which path?",
              header: null,
              options: [],
              multiSelect: false,
            },
          ]}
          answers={[]}
          error="Skipped by user"
          forkedWithoutAnswer={false}
          forkAction={{ enabled: true, pending: false, onFork }}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "A/B Fork" }));

    expect(onFork).toHaveBeenCalledWith("ab-worktree", "interview-skipped");
  });
});
