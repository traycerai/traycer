import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InviteAcceptGrant } from "@/components/settings/members/invite-accept";
import { RoleGrant } from "@/components/settings/members/role-grant";
import type { TeamRole } from "@/components/settings/members/types";

afterEach(cleanup);

const VIEWER: TeamRole = "viewer";
const EDITOR: TeamRole = "editor";
const ADMIN: TeamRole = "admin";

const NOTICE =
  "Prompts go to the provider you pick; nothing else leaves the host.";
const EDITOR_PREFIX =
  "You can change Acme's settings; every change reaches every Acme sandbox.";

function grantText(): string {
  return screen.getByTestId("role-grant").textContent;
}

describe("RoleGrant", () => {
  it("opens with the viewer prefix and the common text", () => {
    render(<RoleGrant role={VIEWER} teamName="Acme" noticeText={NOTICE} />);
    expect(screen.getByTestId("role-grant-prefix").textContent).toBe(
      "Read-only environment settings.",
    );
    expect(screen.getByTestId("role-grant-common").textContent).toContain(
      "Every member can interrupt or permanently delete any Acme sandbox",
    );
  });

  it("opens with the editor prefix", () => {
    render(<RoleGrant role={EDITOR} teamName="Acme" noticeText={NOTICE} />);
    expect(screen.getByTestId("role-grant-prefix").textContent).toBe(
      EDITOR_PREFIX,
    );
  });

  it("extends the editor prefix with invite, remove and role changes for an admin", () => {
    render(<RoleGrant role={ADMIN} teamName="Acme" noticeText={NOTICE} />);
    expect(screen.getByTestId("role-grant-prefix").textContent).toBe(
      `${EDITOR_PREFIX} You can invite and remove people and change roles.`,
    );
  });

  it("keeps the data-handling notice closed until How Traycer handles this is opened", async () => {
    const user = userEvent.setup();
    render(<RoleGrant role={EDITOR} teamName="Acme" noticeText={NOTICE} />);
    expect(grantText()).not.toContain(NOTICE);
    await user.click(
      screen.getByRole("button", { name: "How Traycer handles this" }),
    );
    expect(await screen.findByText(NOTICE)).toBeTruthy();
  });
});

describe("InviteAcceptGrant", () => {
  function renderAccept(paidPlan: boolean, onAccept: () => void): void {
    render(
      <InviteAcceptGrant
        role={EDITOR}
        teamName="Acme"
        noticeText={NOTICE}
        paidPlan={paidPlan}
        accepting={false}
        onAccept={onAccept}
      />,
    );
  }

  it("shows both acceptance sentences on a paid plan", () => {
    renderAccept(true, () => undefined);
    const seats = screen.getByTestId("invite-accept-seats").textContent;
    expect(seats).toContain("accepting does not add another");
    expect(seats).toContain(
      "Available Traycer credits and your assigned allowance",
    );
  });

  it("shows only the allowance sentence on a free plan", () => {
    renderAccept(false, () => undefined);
    const seats = screen.getByTestId("invite-accept-seats").textContent;
    expect(seats).not.toContain("accepting does not add another");
    expect(seats).toContain(
      "Available Traycer credits and your assigned allowance",
    );
  });

  it("shows the grant before Accept and calls onAccept", async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    renderAccept(true, onAccept);
    expect(screen.getByTestId("role-grant")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
});
