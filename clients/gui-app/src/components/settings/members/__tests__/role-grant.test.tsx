import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InviteAcceptGrant } from "@/components/settings/members/invite-accept";
import { RoleGrant } from "@/components/settings/members/role-grant";
import type { TeamRole } from "@/components/settings/members/types";

afterEach(cleanup);

const EDITOR: TeamRole = "editor";
const ADMIN: TeamRole = "admin";
const VIEWER: TeamRole = "viewer";

const NOTICE =
  "Prompts go to the provider you pick; nothing else leaves the host.";
const EDITOR_PREFIX =
  "You can change the team's settings; every change reaches every team sandbox.";

function grantText(): string {
  return screen.getByTestId("role-grant").textContent;
}

describe("RoleGrant", () => {
  it("opens with the viewer prefix and the common text", () => {
    render(<RoleGrant role={VIEWER} noticeText={NOTICE} />);
    expect(screen.getByTestId("role-grant-prefix").textContent).toBe(
      "You can see the team's settings but not change them.",
    );
    expect(screen.getByTestId("role-grant-common").textContent).toContain(
      "Every member can interrupt or permanently delete any team sandbox",
    );
  });

  it("opens with the editor prefix and the common text", () => {
    render(<RoleGrant role={EDITOR} noticeText={NOTICE} />);
    expect(screen.getByTestId("role-grant-prefix").textContent).toBe(
      EDITOR_PREFIX,
    );
    expect(screen.getByTestId("role-grant-common").textContent).toContain(
      "Every member can interrupt or permanently delete any team sandbox",
    );
  });

  it("extends the editor prefix with invite, remove and role changes for an admin", () => {
    render(<RoleGrant role={ADMIN} noticeText={NOTICE} />);
    expect(screen.getByTestId("role-grant-prefix").textContent).toBe(
      `${EDITOR_PREFIX} You can invite and remove people and change roles.`,
    );
  });

  it("keeps the data-handling notice closed until How Traycer handles this is opened", async () => {
    const user = userEvent.setup();
    render(<RoleGrant role={EDITOR} noticeText={NOTICE} />);
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
        noticeText={NOTICE}
        paidPlan={paidPlan}
        accepting={false}
        onAccept={onAccept}
      />,
    );
  }

  it("shows the seat line on a paid plan", () => {
    renderAccept(true, () => undefined);
    const seats = screen.getByTestId("invite-accept-seats").textContent;
    expect(seats).toBe(
      "Your seat already counts toward the team's seats; accepting does not add another.",
    );
  });

  it("shows the spending line on a free plan", () => {
    renderAccept(false, () => undefined);
    const seats = screen.getByTestId("invite-accept-seats").textContent;
    expect(seats).toBe(
      "An admin sets how much of the team's credits you can spend.",
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

  it("shows the Viewer grant before Accept", () => {
    render(
      <InviteAcceptGrant
        role={VIEWER}
        noticeText={NOTICE}
        paidPlan
        accepting={false}
        onAccept={() => undefined}
      />,
    );
    expect(screen.getByTestId("role-grant-prefix").textContent).toBe(
      "You can see the team's settings but not change them.",
    );
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
  });
});
