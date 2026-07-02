import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPlanActionsContext } from "@/components/chat/chat-plan-actions-context";
import type { ChatPlanActionsContextValue } from "@/components/chat/chat-plan-actions-context";
import { PlanSegment } from "@/components/chat/segments/plan-segment";
import type { PlanSegmentModel } from "@/stores/composer/chat-store";

interface CapturedPlanQueryArgs {
  readonly epicId: string;
  readonly chatId: string;
  readonly planId: string;
  readonly contentIdentity: string;
  readonly enabled: boolean;
}

interface PlanQueryState {
  readonly data:
    | {
        readonly planId: string;
        readonly markdown: string;
        readonly source: PlanSegmentModel["source"];
        readonly planStatus: PlanSegmentModel["planStatus"];
        readonly contentHash: string | null;
        readonly unavailableReason: "blob_missing" | null;
      }
    | undefined;
  readonly isFetching: boolean;
  readonly isError: boolean;
}

const planQuery = vi.hoisted<{
  readonly calls: CapturedPlanQueryArgs[];
  value: PlanQueryState;
}>(() => ({
  calls: [],
  value: {
    data: undefined,
    isFetching: false,
    isError: false,
  },
}));

vi.mock("@/hooks/agent/use-agent-plan-query", () => ({
  useAgentPlanQuery: (args: CapturedPlanQueryArgs) => {
    planQuery.calls.push(args);
    return planQuery.value;
  },
}));

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark", themePreset: "neutral" }),
}));

const implement = vi.fn(() => true);

describe("PlanSegment", () => {
  beforeEach(() => {
    planQuery.calls.length = 0;
    planQuery.value = {
      data: undefined,
      isFetching: false,
      isError: false,
    };
    implement.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders an actionable preview card with a single Implement action", () => {
    renderPlan(planSegment({ fullContentRef: null }));

    const card = screen.getByTestId("plan-segment");
    // The header shows the plan title plus a decorative harness icon; the card
    // refactor dropped the harness name text and the generic "Plan" kind label.
    expect(within(card).getByText("Renderer plan")).toBeTruthy();
    expect(within(card).getByText("Wire plan card UI")).toBeTruthy();
    // Expand and Implement are grouped together as the card's actions (the
    // Expand button now sits alongside Implement, not as a separate affordance).
    expect(
      within(card).getByRole("button", { name: "Expand plan" }),
    ).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "Implement" }),
    ).toBeTruthy();
    // Plan mode is non-blocking and uniform: a single Implement action, no Reject.
    expect(within(card).queryByRole("button", { name: "Reject" })).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Implement" }));

    // Implement always sends a follow-up message; there is no approval to resolve.
    expect(implement).toHaveBeenCalledTimes(1);
  });

  it("sends an implement message for a ready plan and shows no Reject action", () => {
    renderPlan(planSegment({ approvalId: null, planStatus: "ready" }));

    const card = screen.getByTestId("plan-segment");
    expect(within(card).queryByRole("button", { name: "Reject" })).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Implement" }));
    expect(implement).toHaveBeenCalledTimes(1);
  });

  it("opens the modal without fetching when preview content is sufficient", () => {
    renderPlan(planSegment({ fullContentRef: null }));

    fireEvent.click(screen.getByRole("button", { name: "Expand plan" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText("Preview-only plan body")).toBeTruthy();
    expect(planQuery.calls.at(-1)?.enabled).toBe(false);
  });

  it("fetches full markdown lazily when expanded with a full-content ref", () => {
    planQuery.value = {
      data: {
        planId: "plan-1",
        markdown: "## Full plan body\n\nDetailed implementation notes.",
        source: planSource(),
        planStatus: "awaiting_approval",
        contentHash: "hash-1",
        unavailableReason: null,
      },
      isFetching: false,
      isError: false,
    };
    renderPlan(
      planSegment({
        fullContentRef: { kind: "plan_content", hash: "hash-1" },
        contentIdentity: "hash-1",
      }),
    );

    expect(planQuery.calls.at(-1)?.enabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Expand plan" }));

    const latest = planQuery.calls.at(-1);
    expect(latest).toEqual({
      epicId: "epic-1",
      chatId: "chat-1",
      planId: "plan-1",
      contentIdentity: "hash-1",
      enabled: true,
    });
    expect(screen.getByText("Detailed implementation notes.")).toBeTruthy();
  });

  it("falls back to preview markdown when full content is unavailable", () => {
    planQuery.value = {
      data: {
        planId: "plan-1",
        markdown: "host fallback",
        source: planSource(),
        planStatus: "awaiting_approval",
        contentHash: null,
        unavailableReason: "blob_missing",
      },
      isFetching: false,
      isError: false,
    };
    renderPlan(
      planSegment({
        fullContentRef: { kind: "plan_content", hash: "missing-hash" },
        contentIdentity: "missing-hash",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand plan" }));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        "Full plan content is unavailable. Showing the saved preview.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("Preview-only plan body")).toBeTruthy();
  });

  it("refreshes expanded full markdown when content identity changes under a stable plan id", () => {
    planQuery.value = {
      data: {
        planId: "plan-1",
        markdown: "## Full plan body\n\nFirst revision.",
        source: planSource(),
        planStatus: "awaiting_approval",
        contentHash: "hash-1",
        unavailableReason: null,
      },
      isFetching: false,
      isError: false,
    };
    const first = planSegment({
      fullContentRef: { kind: "plan_content", hash: "hash-1" },
      contentIdentity: "hash-1",
    });
    const view = renderPlan(first);

    fireEvent.click(screen.getByRole("button", { name: "Expand plan" }));
    expect(screen.getByText("First revision.")).toBeTruthy();

    planQuery.value = {
      data: {
        planId: "plan-1",
        markdown: "## Full plan body\n\nSecond revision.",
        source: planSource(),
        planStatus: "awaiting_approval",
        contentHash: "hash-2",
        unavailableReason: null,
      },
      isFetching: false,
      isError: false,
    };
    view.rerender(
      planElement(
        planSegment({
          fullContentRef: { kind: "plan_content", hash: "hash-2" },
          contentIdentity: "hash-2",
        }),
        planActionContext({ canAct: true, pending: false }),
      ),
    );

    expect(planQuery.calls.at(-1)).toMatchObject({
      planId: "plan-1",
      contentIdentity: "hash-2",
      enabled: true,
    });
    expect(screen.getByText("Second revision.")).toBeTruthy();
  });

  it("keeps long expanded plans scrollable with sticky footer actions", () => {
    const longMarkdown = Array.from(
      { length: 80 },
      (_value, index) => `- Detailed verification item ${index + 1}`,
    ).join("\n");
    planQuery.value = {
      data: {
        planId: "plan-1",
        markdown: longMarkdown,
        source: planSource(),
        planStatus: "awaiting_approval",
        contentHash: "hash-long",
        unavailableReason: null,
      },
      isFetching: false,
      isError: false,
    };
    renderPlan(
      planSegment({
        fullContentRef: { kind: "plan_content", hash: "hash-long" },
        contentIdentity: "hash-long",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand plan" }));

    const dialog = screen.getByRole("dialog");
    const scrollRegion = dialog.querySelector(".overflow-y-auto");
    if (scrollRegion === null) throw new Error("expected scroll region");
    expect(scrollRegion.className).toContain("min-h-0");
    expect(
      within(dialog).getByText("Detailed verification item 80"),
    ).toBeTruthy();

    const footer = screen.getByRole("button", { name: "Copy" }).closest("div");
    if (footer === null) throw new Error("expected modal footer");
    expect(footer.className).toContain("sticky");
    expect(footer.className).toContain("bottom-0");
    expect(
      within(dialog).getByRole("button", { name: "Implement" }),
    ).toBeTruthy();
  });

  it("supports keyboard dismissal and keeps focus inside the expanded modal", () => {
    renderPlan(planSegment({ fullContentRef: null }));

    fireEvent.click(screen.getByRole("button", { name: "Expand plan" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables preview and modal Implement while an action is pending", () => {
    renderPlanWithContext(
      planSegment({ fullContentRef: null }),
      planActionContext({ canAct: true, pending: true }),
    );

    const card = screen.getByTestId("plan-segment");
    expectDisabledButton(
      within(card).getByRole("button", { name: "Implement" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand plan" }));

    const dialog = screen.getByRole("dialog");
    expectDisabledButton(
      within(dialog).getByRole("button", { name: "Implement" }),
    );
  });

  it("keeps superseded plans compact but inspectable", () => {
    renderPlan(
      planSegment({
        planStatus: "superseded",
        approvalId: null,
        actions: [],
        supersededByPlanId: "plan-2",
      }),
    );

    const card = screen.getByTestId("plan-segment");
    // The superseded state is conveyed by the status badge alone; the card
    // refactor dropped the "Superseded by <planId>" detail line.
    expect(within(card).getByText("Superseded")).toBeTruthy();
    // Compact: a terminal (superseded) plan exposes no actions - neither
    // Implement nor Expand (card actions are only shown while drafting/ready).
    expect(
      within(card).queryByRole("button", { name: "Implement" }),
    ).toBeNull();
    expect(
      within(card).queryByRole("button", { name: "Expand plan" }),
    ).toBeNull();
    // Still inspectable: the preview title and body stay rendered inline.
    expect(within(card).getByText("Renderer plan")).toBeTruthy();
    expect(within(card).getByText("Preview-only plan body")).toBeTruthy();
  });

  it("renders exactly the find-indexed card text inside the find-unit anchor", () => {
    const steps = Array.from({ length: 6 }, (_value, index) => ({
      id: `step-${index}`,
      text: `Plan step ${index}`,
      status: "pending" as const,
      activeForm: null,
    }));
    render(
      <ChatPlanActionsContext.Provider
        value={planActionContext({ canAct: true, pending: false })}
      >
        <PlanSegment
          segment={planSegment({
            planStatus: "approved",
            actions: [],
            approvalId: null,
            title: "Refactor the search index",
            summary: "Split projection from rendering",
            markdownPreview:
              "## Hidden heading\n\nSecret dialog-only paragraph.",
            steps,
          })}
          findUnitId="plan-find-unit"
        />
      </ChatPlanActionsContext.Provider>,
    );

    // The card IS the find-unit anchor; reach it from the visible headline.
    // Its mounted text must equal what the projection indexes - headline,
    // status label, subtitle, first four steps.
    const card = screen
      .getByRole("heading", { name: "Refactor the search index" })
      .closest<HTMLElement>("[data-chat-find-unit]");
    expect(card?.dataset.chatFindUnit).toBe("plan-find-unit");
    const text = card?.textContent ?? "";
    expect(text).toContain("Refactor the search index");
    expect(text).toContain("Approved");
    expect(text).toContain("Split projection from rendering");
    expect(text).toContain("Plan step 0");
    expect(text).toContain("Plan step 3");
    // Dialog-only content (extra steps + full preview) is NOT on the card.
    expect(text).not.toContain("Plan step 4");
    expect(text).not.toContain("Plan step 5");
    expect(text).not.toContain("Hidden heading");
    expect(text).not.toContain("Secret dialog-only paragraph");
  });
});

function renderPlan(segment: PlanSegmentModel) {
  return renderPlanWithContext(
    segment,
    planActionContext({ canAct: true, pending: false }),
  );
}

function renderPlanWithContext(
  segment: PlanSegmentModel,
  context: ChatPlanActionsContextValue,
) {
  return render(planElement(segment, context));
}

function planElement(
  segment: PlanSegmentModel,
  context: ChatPlanActionsContextValue,
) {
  return (
    <ChatPlanActionsContext.Provider value={context}>
      <PlanSegment segment={segment} findUnitId={null} />
    </ChatPlanActionsContext.Provider>
  );
}

function planActionContext(input: {
  readonly canAct: boolean;
  readonly pending: boolean;
}): ChatPlanActionsContextValue {
  return {
    epicId: "epic-1",
    chatId: "chat-1",
    canAct: input.canAct,
    pending: input.pending,
    onImplement: implement,
  };
}

function expectDisabledButton(button: HTMLElement): void {
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("expected button element");
  }
  expect(button.disabled).toBe(true);
}

function planSource(): PlanSegmentModel["source"] {
  return {
    harnessId: "codex",
    sessionId: "session-1",
    turnId: "turn-1",
    kind: "structured",
  };
}

function planSegment(overrides: Partial<PlanSegmentModel>): PlanSegmentModel {
  return {
    id: "plan:block-1",
    kind: "plan",
    planId: "plan-1",
    planStatus: "ready",
    harnessId: "codex",
    source: planSource(),
    title: "Renderer plan",
    summary: "Preview-only plan body",
    markdownPreview: "## Preview-only plan body\n\n- Wire plan card UI",
    fullContentRef: null,
    steps: [
      {
        id: "step-1",
        text: "Wire plan card UI",
        status: "pending",
        activeForm: null,
      },
    ],
    actions: [
      {
        id: "reject",
        label: "Reject",
        decision: "reject",
        variant: "secondary",
      },
      {
        id: "implement",
        label: "Implement",
        decision: "approve",
        variant: "primary",
      },
    ],
    approvalId: "approval-1",
    supersededByPlanId: null,
    isStreaming: false,
    contentIdentity: "revision-1",
    ...overrides,
  };
}
