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
      onOpenChange={() => undefined}
      onInvite={onInvite}
    />,
  );
  await user.type(screen.getByLabelText("Email"), "new@acme.test");
  await user.click(screen.getByTestId("members-invite-submit"));
}

describe("InviteDialog", () => {
  it("states the seat rule and the seat delta after a send", async () => {
    await sendInvite({ outcome: "sent", seatDelta: { used: 4, total: 5 } });
    const copy = await screen.findByTestId("members-invite-seat-copy");
    expect(copy.textContent).toBe(
      "Pending invitations count toward Acme's paid seats as soon as they are sent, before acceptance. Acme will use 4 of 5 seats.",
    );
  });

  it("says nothing about seats when seatDelta is null", async () => {
    await sendInvite({ outcome: "sent", seatDelta: null });
    await screen.findByTestId("members-invite-done");
    expect(screen.queryByTestId("members-invite-seat-copy")).toBeNull();
    expect(screen.queryByText(/seats/)).toBeNull();
  });

  it("names the remedy when no seats remain", async () => {
    await sendInvite({ outcome: "seat_limit" });
    const refusal = await screen.findByTestId("members-invite-refusal");
    expect(refusal.textContent).toBe(
      "Acme has no remaining seats. Manage seats and allowances on the dashboard.",
    );
  });

  it("keeps Invite disabled until the address looks valid", async () => {
    const user = userEvent.setup();
    render(
      <InviteDialog
        open
        teamName="Acme"
        busy={false}
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
