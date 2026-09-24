import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatApprovalStateSchema } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerSlotApprovalQueue } from "@/components/chat/segments/composer-slot-approval-queue";
import type { AutoModeRuleDraftWorkspace } from "@/lib/auto-mode/auto-mode-rule-copy";

afterEach(() => {
  cleanup();
});

function approval(overrides: Partial<ChatApprovalState>): ChatApprovalState {
  return chatApprovalStateSchema.parse({
    approvalId: "approval-1",
    toolName: "bash",
    description: "Run a shell command",
    input: null,
    requestedAt: 1,
    kind: "tool",
    planId: null,
    actions: [],
    reason: null,
    reviewing: null,
    ...overrides,
  });
}

const UNKNOWN_WORKSPACE: AutoModeRuleDraftWorkspace = {
  remote: null,
  branch: null,
};

function renderQueue(
  approvals: ChatApprovalState[],
  onDecision: (approvalId: string, approved: boolean) => void,
): void {
  render(
    <ComposerSlotApprovalQueue
      approvals={approvals}
      canAct
      onDecision={onDecision}
      highlightedApprovalId={null}
      ruleDraftWorkspace={UNKNOWN_WORKSPACE}
      onOpenSettings={vi.fn()}
    />,
  );
}

/** The rendered row for one approval id, by its `data-approval-id`. */
function rowFor(approvalId: string): HTMLElement {
  const row = screen
    .getAllByTestId("approval-row")
    .find((element) => element.dataset["approvalId"] === approvalId);
  if (row === undefined) throw new Error(`no approval row ${approvalId}`);
  return row;
}

function threeRows(): ChatApprovalState[] {
  return [
    approval({ approvalId: "a" }),
    approval({ approvalId: "b", cautious: true }),
    approval({ approvalId: "c" }),
  ];
}

describe("approval display facts", () => {
  it("shows Reason, Path and Rule on a Bash card whose input panel shows only the command", () => {
    renderQueue(
      [
        approval({
          toolName: "Bash",
          input: { command: "rm -rf build" },
          displayFacts: [
            { label: "Reason", value: "Rule requires a prompt" },
            { label: "Path", value: "/tmp/project/build" },
            { label: "Rule", value: "An ask rule in project settings" },
          ],
        }),
      ],
      vi.fn(),
    );
    const list = screen.getByTestId("approval-display-facts");
    const rows = within(list).getAllByTestId("approval-display-fact");
    expect(rows.map((row) => row.textContent)).toEqual([
      "ReasonRule requires a prompt",
      "Path/tmp/project/build",
      "RuleAn ask rule in project settings",
    ]);
    expect(screen.getByText("Rule requires a prompt")).toBeTruthy();
  });

  it("shows facts on a grep card too", () => {
    renderQueue(
      [
        approval({
          toolName: "Grep",
          input: { pattern: "foo" },
          displayFacts: [{ label: "Path", value: "/etc" }],
        }),
      ],
      vi.fn(),
    );
    expect(screen.getByText("Path")).toBeTruthy();
    expect(screen.getByText("/etc")).toBeTruthy();
  });

  it("renders no facts list when the row has no displayFacts", () => {
    renderQueue([approval({ toolName: "Bash" })], vi.fn());
    expect(screen.queryByTestId("approval-display-facts")).toBeNull();
  });
});

describe("individual approval on cautious rows", () => {
  it("says '1 needs individual approval', approves only non-cautious rows, denies all", () => {
    const onDecision = vi.fn();
    renderQueue(threeRows(), onDecision);
    expect(screen.getByTestId("approval-individual-count").textContent).toBe(
      "1 needs individual approval",
    );
    screen.getByRole("button", { name: /Approve all/ }).click();
    expect(onDecision.mock.calls).toEqual([
      ["a", true],
      ["c", true],
    ]);
    onDecision.mockClear();
    screen.getByRole("button", { name: /Deny all/ }).click();
    expect(onDecision.mock.calls).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
    ]);
  });

  it("marks only the cautious row", () => {
    renderQueue(threeRows(), vi.fn());
    expect(screen.getAllByTestId("approval-row")).toHaveLength(3);
    expect(
      within(rowFor("a")).queryByTestId("approval-individual-marker"),
    ).toBeNull();
    expect(
      within(rowFor("b")).getByTestId("approval-individual-marker"),
    ).toBeTruthy();
    expect(
      within(rowFor("c")).queryByTestId("approval-individual-marker"),
    ).toBeNull();
  });

  it("says '2 need individual approval' in the plural", () => {
    renderQueue(
      [
        approval({ approvalId: "a" }),
        approval({ approvalId: "b", cautious: true }),
        approval({ approvalId: "c", cautious: true }),
      ],
      vi.fn(),
    );
    expect(screen.getByTestId("approval-individual-count").textContent).toBe(
      "2 need individual approval",
    );
  });

  it("disables Approve all when every answerable row is cautious, and Deny all still works", () => {
    const onDecision = vi.fn();
    renderQueue(
      [
        approval({ approvalId: "a", cautious: true }),
        approval({ approvalId: "b", cautious: true }),
      ],
      onDecision,
    );
    const approveAll = screen.getByRole("button", { name: /Approve all/ });
    expect(approveAll).toHaveProperty("disabled", true);
    screen.getByRole("button", { name: /Deny all/ }).click();
    expect(onDecision.mock.calls).toEqual([
      ["a", false],
      ["b", false],
    ]);
  });

  it("a lone cautious card shows no bulk bar and no marker, and its own Approve works", () => {
    const onDecision = vi.fn();
    renderQueue([approval({ approvalId: "solo", cautious: true })], onDecision);
    expect(screen.queryByRole("button", { name: /Approve all/ })).toBeNull();
    expect(screen.queryByTestId("approval-individual-marker")).toBeNull();
    expect(screen.queryByTestId("approval-individual-count")).toBeNull();
    const row = screen.getByTestId("approval-row");
    within(row).getByRole("button", { name: "Approve" }).click();
    expect(onDecision).toHaveBeenCalledWith("solo", true);
  });

  it("a judging row plus cautious rows: Approve all excludes both, count is answerable-cautious only", () => {
    const onDecision = vi.fn();
    renderQueue(
      [
        approval({
          approvalId: "judging",
          reviewing: "checking",
          cautious: true,
        }),
        approval({ approvalId: "plain" }),
        approval({ approvalId: "careful", cautious: true }),
        approval({ approvalId: "plain-2" }),
      ],
      onDecision,
    );
    expect(screen.getByTestId("approval-individual-count").textContent).toBe(
      "1 needs individual approval",
    );
    screen.getByRole("button", { name: /Approve all/ }).click();
    expect(onDecision.mock.calls).toEqual([
      ["plain", true],
      ["plain-2", true],
    ]);
  });

  it("keeps the judge tier line exactly as before beside cautious and facts", () => {
    renderQueue(
      [
        approval({
          cautious: true,
          reason: {
            rule: "Force Push",
            text: "Rewrites history.",
            tier: "hard",
          },
          displayFacts: [{ label: "Reason", value: "why" }],
        }),
      ],
      vi.fn(),
    );
    expect(screen.getByTestId("approval-judge-tier-line").textContent).toBe(
      "Always sent to you.",
    );
    expect(screen.getByTestId("approval-display-facts")).toBeTruthy();
  });
});
