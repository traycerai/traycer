import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DemotionPreviewDialog } from "@/components/settings/members/demotion-preview";
import { RemovePreviewDialog } from "@/components/settings/members/remove-preview";
import type { RemovePreviewModel } from "@/components/settings/members/types";

afterEach(cleanup);

const PREVIEW: RemovePreviewModel = {
  activeTurns: 1,
  terminals: 0,
  hostName: "This Mac",
  sharedSignIns: ["github"],
  paidSandboxes: [{ name: "build-box", startedBy: "Priya" }],
  linkedPlan: "Claude Max",
};

function renderRemove(preview: RemovePreviewModel): string {
  render(
    <RemovePreviewDialog
      open
      memberName="Priya"
      teamName="Acme"
      preview={{ status: "ready", preview }}
      busy={false}
      blockedReason={null}
      onOpenChange={() => undefined}
      onRetry={() => undefined}
      onConfirm={() => undefined}
    />,
  );
  return screen.getByTestId("members-remove-preview").textContent;
}

describe("RemovePreviewDialog", () => {
  it("names the activity, the two consequences, the plan and what cannot be recalled", () => {
    const text = renderRemove(PREVIEW);
    expect(text).toContain("1 turn and 0 terminals on This Mac");
    expect(text).toContain("Shared sign-ins");
    expect(text).toContain("replacement sign-in");
    expect(text).toContain("build-box pauses for everyone");
    expect(text).toContain("Claude Max");
    expect(text).toContain("Can't be recalled");
  });

  it("omits the shared sign-in row when there are none", () => {
    const text = renderRemove({ ...PREVIEW, sharedSignIns: [] });
    expect(text).not.toContain("Shared sign-ins");
  });

  it("never names a clock", () => {
    const text = renderRemove(PREVIEW);
    expect(text).not.toContain("within a minute");
    expect(text).not.toContain("next turn");
    expect(text).not.toContain("after 30 days");
  });

  it("shows a refusal and disables Remove", () => {
    render(
      <RemovePreviewDialog
        open
        memberName="Priya"
        teamName="Acme"
        preview={{ status: "ready", preview: PREVIEW }}
        busy={false}
        blockedReason="Promote another admin first."
        onOpenChange={() => undefined}
        onRetry={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    expect(screen.getByTestId("members-remove-refusal").textContent).toBe(
      "Promote another admin first.",
    );
    expect(
      screen.getByTestId<HTMLButtonElement>("members-remove-confirm").disabled,
    ).toBe(true);
  });
});

describe("DemotionPreviewDialog", () => {
  it("shows the plan-unlink table and the lost-powers line, no clock", () => {
    render(
      <DemotionPreviewDialog
        open
        memberName="Priya"
        teamName="Acme"
        nextRoleLabel="Viewer"
        preview={{
          status: "ready",
          preview: {
            planLabel: "Claude Max",
            turnsOnPlan: 2,
            whatKeepsWorking: "Sandboxes keep running.",
          },
        }}
        busy={false}
        blockedReason={null}
        onOpenChange={() => undefined}
        onRetry={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    const text = screen.getByTestId("members-demotion-preview").textContent;
    expect(text).toContain("2 turns on Claude Code");
    expect(text).toContain("Sandboxes keep running.");
    expect(screen.getByTestId("members-demotion-loss").textContent).toBe(
      "Priya can no longer invite, change roles or edit the approval policy.",
    );
    expect(text).toContain("Change role · Viewer");
    expect(text).not.toContain("within a minute");
    expect(text).not.toContain("next turn");
  });
});
