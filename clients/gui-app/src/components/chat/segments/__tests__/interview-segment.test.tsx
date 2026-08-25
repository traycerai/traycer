import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  InterviewAnswer,
  InterviewQuestion,
} from "@traycer/protocol/persistence/epic/schemas";
import { deriveInterviewCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import { InterviewSegment } from "@/components/chat/segments/interview-segment";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatFindForceStoreProvider } from "@/stores/chats/chat-find-force-store";
import {
  useSetChatFindActiveTarget,
  useSetChatFindForcedOpen,
} from "@/stores/chats/chat-find-force-store-context";

describe("InterviewSegment", () => {
  afterEach(cleanup);

  function InterviewTestProviders(props: {
    children: ReactNode;
    tileInstanceId?: string;
  }) {
    const tileInstanceId = props.tileInstanceId ?? "interview-test-tile";
    return (
      <ChatFindForceStoreProvider tileInstanceId={tileInstanceId}>
        <TooltipProvider>{props.children}</TooltipProvider>
      </ChatFindForceStoreProvider>
    );
  }

  function FindForceController(props: {
    blockId: string;
    tileInstanceId?: string;
    forcedOpen?: boolean;
    targetUnitId?: string | null;
  }) {
    const setForcedOpen = useSetChatFindForcedOpen();
    const setActiveTarget = useSetChatFindActiveTarget();
    const key = deriveInterviewCollapsibleKey(
      props.tileInstanceId ?? "interview-test-tile",
      props.blockId,
    );
    useLayoutEffect(() => {
      if (props.forcedOpen !== undefined) {
        setForcedOpen(key, props.forcedOpen);
      }
      if (props.targetUnitId !== undefined) {
        setActiveTarget(
          props.targetUnitId === null
            ? null
            : { key, unitId: props.targetUnitId },
        );
      }
    }, [
      key,
      props.forcedOpen,
      props.targetUnitId,
      setActiveTarget,
      setForcedOpen,
    ]);
    return null;
  }

  it("shows both fork modes on resolved Q&A without opening the answers", () => {
    const onFork = vi.fn();
    render(
      <InterviewTestProviders>
        <InterviewSegment
          blockId="interview-1"
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
              selection: null,
            },
          ]}
          draftAnswers={[]}
          outcome="answered"
          settlement={null}
          error={null}
          delivery={null}
          forkedWithoutAnswer={false}
          interviewDeliveryRetry={null}
          forkAction={{ enabled: true, pending: false, onFork }}
        />
      </InterviewTestProviders>,
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
      <InterviewTestProviders>
        <InterviewSegment
          blockId="interview-carried"
          status="completed"
          toolName="AskUserQuestion"
          title="Need input"
          description={null}
          questions={[]}
          answers={[]}
          draftAnswers={[]}
          outcome={null}
          settlement={null}
          error={null}
          delivery={null}
          forkedWithoutAnswer
          interviewDeliveryRetry={null}
          forkAction={{
            enabled: true,
            pending: false,
            onFork: vi.fn(),
          }}
        />
      </InterviewTestProviders>,
    );

    expect(screen.queryByRole("button", { name: "Cross Question" })).toBeNull();
    expect(screen.queryByRole("button", { name: "A/B Fork" })).toBeNull();
  });

  it("keeps carried settled history open and suppresses fork modes", () => {
    render(
      <InterviewTestProviders>
        <InterviewSegment
          blockId="interview-carried-settled"
          status="completed"
          toolName="AskUserQuestion"
          title="Need input"
          description={null}
          questions={[]}
          answers={[]}
          draftAnswers={[]}
          outcome="answered"
          settlement={null}
          error={null}
          delivery={null}
          forkedWithoutAnswer
          interviewDeliveryRetry={null}
          forkAction={{ enabled: true, pending: false, onFork: vi.fn() }}
        />
      </InterviewTestProviders>,
    );

    expect(screen.getAllByText("Answered 0 questions")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Cross Question" })).toBeNull();
    expect(screen.queryByRole("button", { name: "A/B Fork" })).toBeNull();
  });

  it("shows both fork modes after the question is skipped", () => {
    const onFork = vi.fn();
    render(
      <InterviewTestProviders>
        <InterviewSegment
          blockId="interview-skipped"
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
          draftAnswers={[]}
          outcome="skipped"
          settlement={null}
          error="Skipped by user"
          delivery={null}
          forkedWithoutAnswer={false}
          interviewDeliveryRetry={null}
          forkAction={{ enabled: true, pending: false, onFork }}
        />
      </InterviewTestProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: "A/B Fork" }));

    expect(onFork).toHaveBeenCalledWith("ab-worktree", "interview-skipped");
  });

  it("expands into a read-only pager with framing, headers, and static options", () => {
    render(
      <InterviewTestProviders>
        <InterviewSegment
          blockId="interview-exact"
          status="completed"
          toolName="AskUserQuestion"
          title="Deployment strategy"
          description="Choose how the rollout should proceed."
          questions={[
            {
              questionId: "q1",
              question: "Which scope?",
              header: "Scope",
              options: [
                { label: "Alpha", description: null, preview: null },
                { label: "Beta", description: "Beta details", preview: null },
              ],
              multiSelect: false,
            },
            {
              questionId: "q2",
              question: "Which rollout?",
              header: "Rollout",
              options: [
                { label: "Canary", description: null, preview: null },
                { label: "Full", description: null, preview: null },
              ],
              multiSelect: false,
            },
          ]}
          answers={[
            {
              questionId: "q1",
              question: "Which scope?",
              values: ["Beta"],
              notes: null,
              selection: {
                questionIndex: 0,
                optionIndices: [1],
                optionLabels: ["Beta"],
                customText: null,
              },
            },
            {
              questionId: "q2",
              question: "Which rollout?",
              values: ["Canary"],
              notes: null,
              selection: {
                questionIndex: 1,
                optionIndices: [0],
                optionLabels: ["Canary"],
                customText: null,
              },
            },
          ]}
          draftAnswers={[]}
          outcome="answered"
          settlement={null}
          error={null}
          delivery={null}
          forkedWithoutAnswer={false}
          interviewDeliveryRetry={null}
          forkAction={null}
        />
      </InterviewTestProviders>,
    );

    const disclosure = screen.getByRole("button", {
      name: /Answered 2 questions/,
    });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(disclosure);

    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText("Deployment strategy")).toHaveLength(2);
    expect(
      screen.getByText("Choose how the rollout should proceed."),
    ).toBeTruthy();
    expect(screen.getByText("Scope")).toBeTruthy();
    expect(screen.getByText("Which scope?")).toBeTruthy();
    expect(screen.getByText("Selected answer")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Beta" })).toBeNull();
    expect(screen.getByRole("button", { name: "Beta details" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next question" }));

    expect(screen.getByText("Rollout")).toBeTruthy();
    expect(screen.getByText("Which rollout?")).toBeTruthy();
    expect(screen.getByText("Canary")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Previous question" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("renders skipped drafts with explicit unsent semantics", () => {
    render(
      <InterviewTestProviders>
        <InterviewSegment
          blockId="interview-draft"
          status="completed"
          toolName="AskUserQuestion"
          title={null}
          description={null}
          questions={[
            {
              questionId: "q1",
              question: "Which scope?",
              header: null,
              options: [
                { label: "Alpha", description: null, preview: null },
                { label: "Beta", description: null, preview: null },
              ],
              multiSelect: false,
            },
          ]}
          answers={[]}
          draftAnswers={[
            {
              questionId: "q1",
              question: "Which scope?",
              values: ["Beta"],
              notes: null,
              selection: {
                questionIndex: 0,
                optionIndices: [1],
                optionLabels: ["Beta"],
                customText: null,
              },
            },
          ]}
          outcome="skipped"
          settlement={null}
          error={null}
          delivery={null}
          forkedWithoutAnswer={false}
          interviewDeliveryRetry={null}
          forkAction={null}
        />
      </InterviewTestProviders>,
    );

    const disclosure = screen.getByRole("button", {
      name: /Interview skipped · 1 draft saved/,
    });
    fireEvent.click(disclosure);

    expect(screen.getByText("Draft — not sent to agent")).toBeTruthy();
    expect(screen.queryByText("Selected answer")).toBeNull();
    expect(screen.queryByRole("button", { name: "Beta" })).toBeNull();
  });

  it("uses a neutral heading for an unlabelled saved draft", () => {
    render(
      <InterviewTestProviders>
        <InterviewSegment
          blockId="interview-unlabelled-draft"
          status="completed"
          toolName="AskUserQuestion"
          title={null}
          description={null}
          questions={[]}
          answers={[]}
          draftAnswers={[
            {
              questionId: null,
              question: null,
              values: ["Private draft"],
              notes: null,
              selection: null,
            },
          ]}
          outcome="skipped"
          settlement={null}
          error={null}
          delivery={null}
          forkedWithoutAnswer={false}
          interviewDeliveryRetry={null}
          forkAction={null}
        />
      </InterviewTestProviders>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Interview skipped · 1 draft saved/,
      }),
    );
    expect(screen.getByText("Recorded responses")).toBeTruthy();
    expect(screen.queryByText("Submitted answers")).toBeNull();
    expect(screen.getByText("Draft — not sent to agent")).toBeTruthy();
  });

  it("clamps a stale review page when the historical projection shrinks", () => {
    const firstQuestion: InterviewQuestion = {
      questionId: "q1",
      question: "First question?",
      header: null,
      options: [],
      multiSelect: false,
    };
    const secondQuestion: InterviewQuestion = {
      questionId: "q2",
      question: "Second question?",
      header: null,
      options: [],
      multiSelect: false,
    };
    const firstAnswer: InterviewAnswer = {
      questionId: "q1",
      question: "First question?",
      values: ["First answer"],
      notes: null,
      selection: null,
    };
    const secondAnswer: InterviewAnswer = {
      questionId: "q2",
      question: "Second question?",
      values: ["Second answer"],
      notes: null,
      selection: null,
    };
    const review = (
      questions: ReadonlyArray<InterviewQuestion>,
      answers: ReadonlyArray<InterviewAnswer>,
    ) => (
      <InterviewTestProviders>
        <InterviewSegment
          blockId="interview-shrink"
          status="completed"
          toolName="AskUserQuestion"
          title={null}
          description={null}
          questions={questions}
          answers={answers}
          draftAnswers={[]}
          outcome="answered"
          settlement={null}
          error={null}
          delivery={null}
          forkedWithoutAnswer={false}
          interviewDeliveryRetry={null}
          forkAction={null}
        />
      </InterviewTestProviders>
    );
    const { rerender } = render(
      review([firstQuestion, secondQuestion], [firstAnswer, secondAnswer]),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Answered 2 questions/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    expect(screen.getByText("Second question?")).toBeTruthy();

    rerender(review([firstQuestion], [firstAnswer]));

    expect(screen.getByText("First question?")).toBeTruthy();
    expect(screen.queryByText("Second question?")).toBeNull();
    expect(screen.queryByRole("button", { name: "Next question" })).toBeNull();
  });

  it("does not persist local disclosure open when a forced target is absent", async () => {
    const view = (forcedOpen: boolean, targetUnitId: string | null) => (
      <InterviewTestProviders>
        <FindForceController
          blockId="interview-force"
          forcedOpen={forcedOpen}
          targetUnitId={targetUnitId}
        />
        <InterviewSegment
          blockId="interview-force"
          status="completed"
          toolName="AskUserQuestion"
          title={null}
          description={null}
          questions={[
            {
              questionId: "q1",
              question: "Which scope?",
              header: null,
              options: [],
              multiSelect: false,
            },
          ]}
          answers={[
            {
              questionId: "q1",
              question: "Which scope?",
              values: ["Staging"],
              notes: null,
              selection: null,
            },
          ]}
          draftAnswers={[]}
          outcome="answered"
          settlement={null}
          error={null}
          delivery={null}
          forkedWithoutAnswer={false}
          interviewDeliveryRetry={null}
          forkAction={null}
        />
      </InterviewTestProviders>
    );
    const { rerender } = render(view(false, null));
    const disclosure = screen.getByRole("button", {
      name: /Answered 1 question/,
    });

    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    rerender(view(true, null));
    await act(
      () =>
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        }),
    );
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    rerender(view(false, null));
    await act(() => Promise.resolve());
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  });

  it("commits local disclosure open only after a valid target mounts", async () => {
    const targetUnitId =
      "interview:interview-force-valid:question:0:question-text";
    const view = (forcedOpen: boolean, target: string | null) => (
      <InterviewTestProviders>
        <FindForceController
          blockId="interview-force-valid"
          forcedOpen={forcedOpen}
          targetUnitId={target}
        />
        <InterviewSegment
          blockId="interview-force-valid"
          status="completed"
          toolName="AskUserQuestion"
          title={null}
          description={null}
          questions={[
            {
              questionId: "q1",
              question: "Which scope?",
              header: null,
              options: [],
              multiSelect: false,
            },
          ]}
          answers={[
            {
              questionId: "q1",
              question: "Which scope?",
              values: ["Staging"],
              notes: null,
              selection: null,
            },
          ]}
          draftAnswers={[]}
          outcome="answered"
          settlement={null}
          error={null}
          delivery={null}
          forkedWithoutAnswer={false}
          interviewDeliveryRetry={null}
          forkAction={null}
        />
      </InterviewTestProviders>
    );
    const { rerender } = render(view(false, null));
    const disclosure = screen.getByRole("button", {
      name: /Answered 1 question/,
    });

    rerender(view(true, targetUnitId));
    await act(
      () =>
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        }),
    );
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    rerender(view(false, targetUnitId));
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  });

  it("does not commit a valid target when force releases before the frame", async () => {
    const targetUnitId =
      "interview:interview-force-rapid:question:0:question-text";
    const view = (forcedOpen: boolean, target: string | null) => (
      <InterviewTestProviders>
        <FindForceController
          blockId="interview-force-rapid"
          forcedOpen={forcedOpen}
          targetUnitId={target}
        />
        <InterviewSegment
          blockId="interview-force-rapid"
          status="completed"
          toolName="AskUserQuestion"
          title={null}
          description={null}
          questions={[
            {
              questionId: "q1",
              question: "Which scope?",
              header: null,
              options: [],
              multiSelect: false,
            },
          ]}
          answers={[]}
          draftAnswers={[]}
          outcome="answered"
          settlement={null}
          error={null}
          delivery={null}
          forkedWithoutAnswer={false}
          interviewDeliveryRetry={null}
          forkAction={null}
        />
      </InterviewTestProviders>
    );
    const { rerender } = render(view(false, null));
    const disclosure = screen.getByRole("button", {
      name: /Answered 0 of 1 questions/,
    });

    rerender(view(true, targetUnitId));
    rerender(view(false, targetUnitId));
    await act(
      () =>
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        }),
    );
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  });

  it("pages to a targeted question and restores the manual page when find clears", () => {
    const view = (
      targetUnitId: string | null | undefined,
      forcedOpen: boolean | undefined,
    ) => (
      <InterviewTestProviders>
        <FindForceController
          blockId="interview-target-page"
          targetUnitId={targetUnitId}
          forcedOpen={forcedOpen}
        />
        <InterviewSegment
          blockId="interview-target-page"
          status="completed"
          toolName="AskUserQuestion"
          title={null}
          description={null}
          questions={[
            {
              questionId: "q1",
              question: "First question?",
              header: null,
              options: [],
              multiSelect: false,
            },
            {
              questionId: "q2",
              question: "Second question?",
              header: null,
              options: [],
              multiSelect: false,
            },
          ]}
          answers={[
            {
              questionId: "q1",
              question: "First question?",
              values: ["First answer"],
              notes: null,
              selection: null,
            },
            {
              questionId: "q2",
              question: "Second question?",
              values: ["Second answer"],
              notes: null,
              selection: null,
            },
          ]}
          draftAnswers={[]}
          outcome="answered"
          settlement={null}
          error={null}
          delivery={null}
          forkedWithoutAnswer={false}
          interviewDeliveryRetry={null}
          forkAction={null}
        />
      </InterviewTestProviders>
    );
    const { rerender } = render(view(undefined, undefined));

    fireEvent.click(
      screen.getByRole("button", { name: /Answered 2 questions/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    expect(screen.getByText("Second question?")).toBeTruthy();

    rerender(
      view("interview:interview-target-page:question:0:question-text", true),
    );
    expect(screen.getByText("First question?")).toBeTruthy();
    expect(screen.queryByText("Second question?")).toBeNull();

    rerender(view(null, false));
    expect(screen.getByText("Second question?")).toBeTruthy();
    expect(screen.queryByText("First question?")).toBeNull();
  });

  it("clears a find target when manual paging starts", () => {
    const view = (forcedOpen: boolean | undefined) => (
      <InterviewTestProviders>
        <FindForceController
          blockId="interview-manual-page"
          forcedOpen={forcedOpen}
          targetUnitId={
            forcedOpen === undefined
              ? undefined
              : "interview:interview-manual-page:question:0:question-text"
          }
        />
        <InterviewSegment
          blockId="interview-manual-page"
          status="completed"
          toolName="AskUserQuestion"
          title={null}
          description={null}
          questions={[
            {
              questionId: "q1",
              question: "First question?",
              header: null,
              options: [],
              multiSelect: false,
            },
            {
              questionId: "q2",
              question: "Second question?",
              header: null,
              options: [],
              multiSelect: false,
            },
          ]}
          answers={[]}
          draftAnswers={[]}
          outcome="answered"
          settlement={null}
          error={null}
          delivery={null}
          forkedWithoutAnswer={false}
          interviewDeliveryRetry={null}
          forkAction={null}
        />
      </InterviewTestProviders>
    );
    const { rerender } = render(view(true));

    expect(screen.getByText("First question?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    expect(screen.getByText("Second question?")).toBeTruthy();

    rerender(view(undefined));
    expect(screen.getByText("Second question?")).toBeTruthy();
    expect(screen.queryByText("First question?")).toBeNull();
  });

  it("mounts targeted option details inline with a find anchor", () => {
    render(
      <InterviewTestProviders>
        <FindForceController
          blockId="interview-details"
          forcedOpen
          targetUnitId="interview:interview-details:question:0:option-description:option:1"
        />
        <InterviewSegment
          blockId="interview-details"
          status="completed"
          toolName="AskUserQuestion"
          title={null}
          description={null}
          questions={[
            {
              questionId: "q1",
              question: "Which scope?",
              header: null,
              options: [
                { label: "Alpha", description: null, preview: null },
                { label: "Beta", description: "Beta details", preview: null },
              ],
              multiSelect: false,
            },
          ]}
          answers={[]}
          draftAnswers={[]}
          outcome="answered"
          settlement={null}
          error={null}
          delivery={null}
          forkedWithoutAnswer={false}
          interviewDeliveryRetry={null}
          forkAction={null}
        />
      </InterviewTestProviders>,
    );

    const detail = screen.getByText("Beta details");
    expect(detail.getAttribute("data-chat-find-unit")).toBe(
      "interview:interview-details:question:0:option-description:option:1",
    );
    const detailButton = screen.getByRole("button", {
      name: "Beta details",
    });
    fireEvent.focus(detailButton);
    const describedBy = detailButton.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? "")).toBe(
      detail.closest("[role='note']"),
    );
    expect(screen.queryAllByRole("tooltip")).toHaveLength(0);
    expect(screen.getAllByText("Beta details")).toHaveLength(1);
  });

  it("scopes pinned option detail ids to each mounted card view", () => {
    const blockId = "interview-details";
    const card = (tileInstanceId: string) => (
      <InterviewTestProviders tileInstanceId={tileInstanceId}>
        <div data-testid={`interview-view-${tileInstanceId}`}>
          <FindForceController
            blockId={blockId}
            tileInstanceId={tileInstanceId}
            forcedOpen
            targetUnitId={`interview:${blockId}:question:0:option-description:option:1`}
          />
          <InterviewSegment
            blockId={blockId}
            status="completed"
            toolName="AskUserQuestion"
            title={null}
            description={null}
            questions={[
              {
                questionId: "q1",
                question: "Which scope?",
                header: null,
                options: [
                  { label: "Alpha", description: null, preview: null },
                  { label: "Beta", description: "Beta details", preview: null },
                ],
                multiSelect: false,
              },
            ]}
            answers={[]}
            draftAnswers={[]}
            outcome="answered"
            settlement={null}
            error={null}
            delivery={null}
            forkedWithoutAnswer={false}
            interviewDeliveryRetry={null}
            forkAction={null}
          />
        </div>
      </InterviewTestProviders>
    );

    render(
      <>
        {card("interview-details-view-a")}
        {card("interview-details-view-b")}
      </>,
    );

    const viewRoots = [
      screen.getByTestId("interview-view-interview-details-view-a"),
      screen.getByTestId("interview-view-interview-details-view-b"),
    ];
    const detailButtons = viewRoots.map((root) =>
      within(root).getByRole("button", { name: "Beta details" }),
    );
    const describedBy = detailButtons.map((button) =>
      button.getAttribute("aria-describedby"),
    );
    expect(describedBy).toHaveLength(2);
    expect(new Set(describedBy).size).toBe(2);
    describedBy.forEach((id, index) => {
      expect(id).not.toBeNull();
      const describedNode = document.getElementById(id ?? "");
      expect(describedNode?.getAttribute("role")).toBe("note");
      expect(viewRoots[index]?.contains(describedNode)).toBe(true);
    });
    expect(screen.queryAllByRole("tooltip")).toHaveLength(0);
  });

  it("shows delivery state without inventing a Retry action", () => {
    render(
      <InterviewTestProviders>
        <InterviewSegment
          blockId="interview-delivery"
          status="completed"
          toolName="AskUserQuestion"
          title={null}
          description={null}
          questions={[
            {
              questionId: "q1",
              question: "Which scope?",
              header: null,
              options: [],
              multiSelect: false,
            },
          ]}
          answers={[
            {
              questionId: "q1",
              question: "Which scope?",
              values: ["Alpha"],
              notes: null,
              selection: null,
            },
          ]}
          draftAnswers={[]}
          outcome="answered"
          settlement={null}
          error={null}
          delivery={{
            deliveryId: "delivery-1",
            status: "pending",
            retryable: true,
            generation: 0,
          }}
          forkedWithoutAnswer={false}
          interviewDeliveryRetry={null}
          forkAction={null}
        />
      </InterviewTestProviders>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Answer saved · Delivery pending/ }),
    );

    expect(screen.getByText("Delivery pending")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("renders the historical Retry action only for an exact retryable failure", () => {
    const onRetry = vi.fn();
    const isPending = vi.fn(() => false);
    render(
      <InterviewTestProviders>
        <InterviewSegment
          blockId="interview-delivery-retry"
          status="completed"
          toolName="AskUserQuestion"
          title={null}
          description={null}
          questions={[
            {
              questionId: "q1",
              question: "Which scope?",
              header: null,
              options: [],
              multiSelect: false,
            },
          ]}
          answers={[
            {
              questionId: "q1",
              question: "Which scope?",
              values: ["Alpha"],
              notes: null,
              selection: null,
            },
          ]}
          draftAnswers={[]}
          outcome="answered"
          settlement={{ settlementId: "settlement-1", source: "gui" }}
          error={null}
          delivery={{
            deliveryId: "delivery-1",
            status: "failed",
            retryable: true,
            generation: 3,
          }}
          forkedWithoutAnswer={false}
          forkAction={null}
          interviewDeliveryRetry={{
            isPending,
            onRetry,
          }}
        />
      </InterviewTestProviders>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Answered 1 question · Delivery failed/,
      }),
    );
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);

    expect(isPending).toHaveBeenCalledWith({
      blockId: "interview-delivery-retry",
      settlementId: "settlement-1",
      deliveryId: "delivery-1",
      generation: 3,
    });
    expect(onRetry).toHaveBeenCalledWith({
      blockId: "interview-delivery-retry",
      settlementId: "settlement-1",
      deliveryId: "delivery-1",
      generation: 3,
    });
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });
});
