import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InviteDialog } from "@/components/settings/members/invite-dialog";
import type { MembersInviteOutcome } from "@/components/settings/members/types";

afterEach(cleanup);

async function sendInvite(outcome: MembersInviteOutcome): Promise<void> {
  const user = userEvent.setup();
  const onInvite = vi.fn(() => Promise.resolve(outcome));
  render(
    <InviteDialog
      open
      teamName="Acme"
      busy={false}
      seatLine={null}
      onOpenChange={() => undefined}
      onInvite={onInvite}
    />,
  );
  await user.type(screen.getByLabelText("Email"), "new@acme.test");
  await user.click(screen.getByTestId("members-invite-submit"));
}

describe("InviteDialog", () => {
  it("names the remedy when no seats remain", async () => {
    await sendInvite({ outcome: "seat_limit" });
    const refusal = await screen.findByTestId("members-invite-refusal");
    expect(refusal.textContent).toBe(
      "Acme has no remaining seats. Manage seats and allowances on the dashboard.",
    );
  });

  it("describes the picked role under the picker, which the picker names as its description", async () => {
    const user = userEvent.setup();
    render(
      <InviteDialog
        open
        teamName="Acme"
        busy={false}
        seatLine={null}
        onOpenChange={() => undefined}
        onInvite={() => Promise.resolve({ outcome: "sent", seatDelta: null })}
      />,
    );
    const line = screen.getByTestId("members-invite-role-line");
    const picker = screen.getByRole("combobox", { name: "Role" });
    expect(picker.getAttribute("aria-describedby")).toBe(line.id);
    expect(line.textContent).toBe(
      "Can change Acme's settings; every change reaches every Acme sandbox.",
    );

    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: "Viewer" }));
    expect(line.textContent).toBe(
      "Can see Acme's settings but not change them.",
    );

    await user.click(picker);
    await user.click(await screen.findByRole("option", { name: "Admin" }));
    expect(line.textContent).toBe(
      "Can change Acme's settings, invite and remove people, and change roles.",
    );
  });

  it("keeps Invite disabled until the address looks valid", async () => {
    const user = userEvent.setup();
    render(
      <InviteDialog
        open
        teamName="Acme"
        busy={false}
        seatLine={null}
        onOpenChange={() => undefined}
        onInvite={() => Promise.resolve({ outcome: "sent", seatDelta: null })}
      />,
    );
    const submit = screen.getByTestId("members-invite-submit");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Email"), "not-an-address");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });
});
