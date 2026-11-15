import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DemotionPreviewDialog } from "@/components/settings/members/demotion-preview";
import { RemovePreviewDialog } from "@/components/settings/members/remove-preview";
import type {
  RemovePreviewModel,
  TeamRole,
} from "@/components/settings/members/types";

afterEach(cleanup);

const WORK = { activeTurns: 1, terminals: 0, hostName: "This Mac" };

const PREVIEW: RemovePreviewModel = {
  sandboxesToRekey: 1,
  workNow: WORK,
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
  it("lists only the three consequences the removal changes", () => {
    renderRemove(PREVIEW);
    const table = screen.getByTestId("members-remove-preview-table");
    expect(
      Array.from(table.querySelectorAll("th"), (cell) => cell.textContent),
    ).toEqual(["Priya's work now", "Shared sign-ins", "Can't be recalled"]);
  });

  it("says None. in shared sign-ins when the team has no sandbox", () => {
    renderRemove({ ...PREVIEW, sandboxesToRekey: 0 });
    expect(rowValue("Shared sign-ins")).toBe("None.");
  });

  it("states that work continues, shared sign-ins are replaced and copied files cannot be recalled", () => {
    const text = renderRemove({
      ...PREVIEW,
      workNow: { ...WORK, terminals: 2 },
    });
    expect(rowValue("Priya's work now")).toBe(
      "1 turn and 2 terminals on This Mac. Their connections close. Work they started keeps running for Acme under their name.",
    );
    expect(rowValue("Shared sign-ins")).toBe(
      "Acme's sandboxes get a replacement sign-in for the team's connected services; it is complete when each host and the provider confirm.",
    );
    expect(rowValue("Can't be recalled")).toBe(
      'Files Priya already copied off a host and work already done upstream with Acme\'s services. What Priya started stays, labelled "started by a former member".',
    );
    expect(text).not.toContain("Removal shows as pending until it commits.");
  });

  it("leaves the host out of the work row when the window cannot label it", () => {
    renderRemove({ ...PREVIEW, workNow: { ...WORK, hostName: null } });
    expect(rowValue("Priya's work now")).toBe(
      "1 turn and 0 terminals. Their connections close. Work they started keeps running for Acme under their name.",
    );
  });

  it("says work continues when no computer counts it, and None. when both counts are zero", () => {
    renderRemove({ ...PREVIEW, workNow: null });
    expect(rowValue("Priya's work now")).toBe(
      "Their connections close. Work they started keeps running for Acme under their name.",
    );
    cleanup();
    renderRemove({ ...PREVIEW, workNow: { ...WORK, activeTurns: 0 } });
    expect(rowValue("Priya's work now")).toBe("None.");
  });

  it("leads with the removal's reach and confirms with the first name", () => {
    renderRemove(PREVIEW);
    expect(
      screen.getByText("Remove Priya (priya@acme.test) from Acme"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Priya loses Acme's settings, hosts and connected services.",
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
    readonly busy: boolean;
    readonly blockedReason: string | null;
  }): void {
    render(
      <DemotionPreviewDialog
        open
        memberName="Priya"
        teamName="Acme"
        currentRole={options.currentRole}
        nextRole={options.nextRole}
        busy={options.busy}
        blockedReason={options.blockedReason}
        onOpenChange={() => undefined}
        onConfirm={() => undefined}
      />,
    );
  }

  it("describes the dialog with what the role loses", () => {
    renderDemotion({
      currentRole: "admin",
      nextRole: "editor",
      busy: false,
      blockedReason: null,
    });

    const dialog = screen.getByTestId("members-demotion-preview");
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      "Priya can no longer invite people, change roles or edit the approval policy.",
    );
  });

  it("asks the question and enables the named role change immediately", () => {
    renderDemotion({
      currentRole: "admin",
      nextRole: "editor",
      busy: false,
      blockedReason: null,
    });

    expect(
      screen.getByText("Change Priya's role in Acme to editor?"),
    ).toBeTruthy();
    const confirm = screen.getByRole<HTMLButtonElement>("button", {
      name: "Change to editor",
    });
    expect(confirm.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByTestId("members-demotion-preview-table")).toBeNull();
  });

  it("keeps the confirm off and shows progress while the change is in flight", () => {
    renderDemotion({
      currentRole: "admin",
      nextRole: "editor",
      busy: true,
      blockedReason: null,
    });

    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Change to editor",
      }).disabled,
    ).toBe(true);
    expect(screen.getByTestId("members-demotion-confirm-busy")).toBeTruthy();
  });

  it("shows a refusal and disables the role change", () => {
    renderDemotion({
      currentRole: "admin",
      nextRole: "editor",
      busy: false,
      blockedReason: "Promote another admin first.",
    });

    expect(screen.getByTestId("members-demotion-refusal").textContent).toBe(
      "Promote another admin first.",
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Change to editor",
      }).disabled,
    ).toBe(true);
  });
});
