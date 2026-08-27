import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { TeardownDisclosure } from "@/components/worktree/teardown-disclosure";

const OWNER: WorktreeBusyHolder["ownerRef"] = {
  epicId: "epic-1",
  ownerKind: "terminal-agent",
  ownerId: "tui-1",
};

function holder(
  overrides: Partial<WorktreeBusyHolder> &
    Pick<WorktreeBusyHolder, "holdKind" | "activity" | "label">,
): WorktreeBusyHolder {
  return {
    ownerRef: OWNER,
    ...overrides,
  };
}

describe("TeardownDisclosure", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing for an empty holder list", () => {
    const { container } = render(<TeardownDisclosure holders={[]} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("teardown-disclosure")).toBeNull();
  });

  it("calls out working holders loudly and lists idle holders plainly", () => {
    render(
      <TeardownDisclosure
        holders={[
          holder({
            holdKind: "chat-turn",
            activity: "working",
            label: "Planner is working",
          }),
          holder({
            holdKind: "supervised-shell",
            activity: "idle",
            label: "npm test",
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("teardown-disclosure-working").textContent).toContain(
      "Planner is working",
    );
    expect(screen.getByTestId("teardown-disclosure-working").textContent).toContain(
      "1 agent is still working",
    );
    expect(screen.getByTestId("teardown-disclosure-idle").textContent).toContain(
      "1 background process will be stopped",
    );
    expect(screen.getByTestId("teardown-disclosure-idle").textContent).toContain(
      "npm test",
    );
  });

  it("labels each holder kind instead of saying busy", () => {
    render(
      <TeardownDisclosure
        holders={[
          holder({
            holdKind: "terminal-agent-pty",
            activity: "working",
            label: "Claude will restart in the new folder",
          }),
          holder({
            holdKind: "supervised-shell",
            activity: "working",
            label: "npm run dev",
          }),
        ]}
      />,
    );
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByText("Shell")).toBeTruthy();
    expect(screen.queryByText(/busy/i)).toBeNull();
  });
});
