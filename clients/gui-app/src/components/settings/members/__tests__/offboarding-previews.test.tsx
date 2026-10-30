import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DemotionPreviewDialog } from "@/components/settings/members/demotion-preview";
import { RemovePreviewDialog } from "@/components/settings/members/remove-preview";
import type {
  RemovePreviewModel,
  TeamRole,
} from "@/components/settings/members/types";

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
      memberEmail="priya@acme.test"
      confirmName="Priya"
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

function rowValue(label: string): string {
  const table = screen.getByTestId("members-remove-preview-table");
  const header = within(table).getByText(label, { selector: "th" });
  const cell = header.nextElementSibling;
  if (cell === null) throw new Error(`no value cell for ${label}`);
  return cell.textContent;
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

  it("says None. in the shared sign-ins and linked plan rows when there are none", () => {
    renderRemove({ ...PREVIEW, sharedSignIns: [], linkedPlan: null });
    expect(rowValue("Shared sign-ins")).toBe("None.");
    expect(rowValue("Linked plan")).toBe("None.");
  });

  it("states the work, the timing rule, the sign-in replacement, the plan and what cannot be recalled", () => {
    const text = renderRemove({ ...PREVIEW, terminals: 2 });
    expect(rowValue("Priya's work now")).toBe(
      "1 turn and 2 terminals on This Mac. Priya's access is revoked now; each finishes its current step and starts no new one. If a host does not answer in time, stopping shows as pending until it does.",
    );
    expect(rowValue("Shared sign-ins")).toBe(
      "Acme's sandboxes get a replacement sign-in for the team's connected services; it is complete when each host and the provider confirm. Other members' agents there pause while it lands.",
    );
    expect(rowValue("Linked plan")).toBe("Claude Max");
    expect(rowValue("Can't be recalled")).toBe(
      'Files Priya already copied off a host and work already done upstream with Acme\'s services. What Priya started stays, labelled "started by a former member".',
    );
    expect(text).toContain("Removal shows as pending until it commits.");
  });

  it("leaves the host out of the work row when the window cannot label it", () => {
    renderRemove({ ...PREVIEW, hostName: null });
    expect(rowValue("Priya's work now")).toMatch(
      /^1 turn and 0 terminals\. Priya's access is revoked now;/,
    );
  });

  it("gives work the host cannot count no count, and None. when both are zero", () => {
    renderRemove({ ...PREVIEW, activeTurns: null, terminals: null });
    expect(rowValue("Priya's work now")).toBe(
      "Priya's access is revoked now. Anything they have running finishes its current step and starts no new one; Traycer can't list that work from here.",
    );
    cleanup();
    renderRemove({ ...PREVIEW, activeTurns: 0, terminals: 0 });
    expect(rowValue("Priya's work now")).toBe("None.");
  });

  it("leads with the removal's reach and confirms with the first name", () => {
    renderRemove(PREVIEW);
    expect(
      screen.getByText("Remove Priya (priya@acme.test) from Acme"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Priya loses Acme's settings, hosts and connected services. Here is what the removal stops, for Priya and for everyone else.",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("members-remove-confirm").textContent).toBe(
      "Remove Priya",
    );
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
        memberEmail="priya@acme.test"
        confirmName="Priya"
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
  function renderDemotion(options: {
    readonly currentRole: TeamRole;
    readonly nextRole: TeamRole;
    readonly planLabel: string;
  }): string {
    render(
      <DemotionPreviewDialog
        open
        memberName="Priya"
        teamName="Acme"
        currentRole={options.currentRole}
        nextRole={options.nextRole}
        preview={{
          status: "ready",
          preview: {
            planLabel: options.planLabel,
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
    return screen.getByTestId("members-demotion-preview").textContent;
  }

  it("asks the question, says what is lost and names the role on the button", () => {
    const text = renderDemotion({
      currentRole: "admin",
      nextRole: "editor",
      planLabel: "Claude Max",
    });
    expect(
      screen.getByText("Change Priya's role in Acme to editor?"),
    ).toBeTruthy();
    expect(screen.getByTestId("members-demotion-loss").textContent).toBe(
      "Priya can no longer invite people, change roles or edit the approval policy.",
    );
    expect(screen.getByTestId("members-demotion-confirm").textContent).toBe(
      "Change to editor",
    );
    expect(text).not.toContain("Change role · ");
    expect(text).not.toContain("within a minute");
    expect(text).not.toContain("next turn");
  });

  it("gives an editor going to viewer its own question, loss line and button", () => {
    renderDemotion({
      currentRole: "editor",
      nextRole: "viewer",
      planLabel: "",
    });
    expect(
      screen.getByText("Change Priya's role in Acme to viewer?"),
    ).toBeTruthy();
    expect(screen.getByTestId("members-demotion-loss").textContent).toBe(
      "Priya can no longer change Acme's settings. They can still see them.",
    );
    expect(screen.getByTestId("members-demotion-confirm").textContent).toBe(
      "Change to viewer",
    );
  });

  it("says both losses when an admin goes straight to viewer", () => {
    renderDemotion({
      currentRole: "admin",
      nextRole: "viewer",
      planLabel: "",
    });
    expect(screen.getByTestId("members-demotion-loss").textContent).toBe(
      "Priya can no longer invite people, change roles or edit the approval policy. Priya can no longer change Acme's settings. They can still see them.",
    );
  });

  it("shows the plan rows only for a demotion that unlinks a plan", () => {
    const withPlan = renderDemotion({
      currentRole: "admin",
      nextRole: "editor",
      planLabel: "Claude Max",
    });
    expect(withPlan).toContain("2 turns on Claude Code");
    expect(withPlan).toContain("Sandboxes keep running.");
    expect(screen.getByTestId("members-demotion-preview-table")).toBeTruthy();
    cleanup();

    const withoutPlan = renderDemotion({
      currentRole: "admin",
      nextRole: "editor",
      planLabel: "",
    });
    expect(screen.queryByTestId("members-demotion-preview-table")).toBeNull();
    expect(withoutPlan).not.toContain("Agents on it now");
    expect(withoutPlan).not.toContain("stop using this plan");
  });
});
