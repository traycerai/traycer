import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { dashboardRunnerHost } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { MembersView } from "@/components/settings/members/members-view";
import type {
  MembersInviteOutcome,
  MembersListMember,
  MembersRemoveOutcome,
  MembersSetRoleOutcome,
  PlanUnlinkPreviewModel,
  RemovePreviewModel,
  TeamRole,
} from "@/components/settings/members/types";
import { RunnerHostContext } from "@/providers/runner-host-context";

afterEach(cleanup);

function Providers(props: { readonly children: ReactNode }): ReactNode {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <RunnerHostContext.Provider value={dashboardRunnerHost()}>
        {props.children}
      </RunnerHostContext.Provider>
    </QueryClientProvider>
  );
}

function member(
  userId: string,
  displayName: string,
  role: TeamRole,
  overrides: Partial<MembersListMember>,
): MembersListMember {
  return {
    userId,
    displayName,
    email: `${userId}@acme.test`,
    effectiveRole: role,
    linkedPlan: false,
    inviteState: "accepted",
    invitedAddress: null,
    removalState: "none",
    ...overrides,
  };
}

const ADMIN = member("u-admin", "Ada", "admin", {});
const SECOND_ADMIN = member("u-admin2", "Grace", "admin", {});
const EDITOR = member("u-editor", "Priya", "editor", { linkedPlan: true });
const PENDING = member("u-pending", "", "viewer", {
  inviteState: "pending",
  invitedAddress: "new@acme.test",
  email: null,
  displayName: null,
});

const REMOVE_PREVIEW: RemovePreviewModel = {
  memberName: "Priya",
  activeTurns: 2,
  terminals: 1,
  hostName: "This Mac",
  sharedSignIns: ["github"],
  paidSandboxes: [],
  linkedPlan: null,
};

const DEMOTION_PREVIEW: PlanUnlinkPreviewModel = {
  memberName: "Grace",
  planLabel: "Claude Max",
  turnsOnPlan: 1,
  whatKeepsWorking: "Sandboxes keep running.",
};

function renderView(options: {
  readonly viewerRole: TeamRole;
  readonly members: readonly MembersListMember[];
  readonly currentUserId: string;
  readonly legacyRoleNoticeSeenAt: number | null;
  readonly removeOutcome: MembersRemoveOutcome;
  readonly setRoleOutcome: MembersSetRoleOutcome;
}): {
  readonly onSetRole: Mock<
    (input: {
      userId: string;
      role: TeamRole;
    }) => Promise<MembersSetRoleOutcome>
  >;
  readonly onRemove: Mock<
    (input: { userId: string }) => Promise<MembersRemoveOutcome>
  >;
  readonly onNoticeSeen: Mock<() => void>;
} {
  const onSetRole = vi.fn((_input: { userId: string; role: TeamRole }) =>
    Promise.resolve(options.setRoleOutcome),
  );
  const onRemove = vi.fn((_input: { userId: string }) =>
    Promise.resolve(options.removeOutcome),
  );
  const onNoticeSeen = vi.fn(() => undefined);
  const rowDetails = (): ReactNode => <button type="button">Details</button>;
  render(
    <Providers>
      <MembersView
        environmentId="env-1"
        teamName="Acme"
        teamHandle="acme"
        currentUserId={options.currentUserId}
        viewerRole={options.viewerRole}
        members={options.members}
        legacyMembers={["Priya"]}
        legacyRoleNoticeSeenAt={options.legacyRoleNoticeSeenAt}
        rowDetails={rowDetails}
        onInvite={(): Promise<MembersInviteOutcome> =>
          Promise.resolve({ outcome: "sent", seatDelta: null })
        }
        onSetRole={onSetRole}
        onRemove={onRemove}
        onLoadRemovePreview={() => Promise.resolve(REMOVE_PREVIEW)}
        onLoadDemotionPreview={() => Promise.resolve(DEMOTION_PREVIEW)}
        onNoticeSeen={onNoticeSeen}
      />
    </Providers>,
  );
  return { onSetRole, onRemove, onNoticeSeen };
}

const BASE = {
  currentUserId: "u-admin",
  legacyRoleNoticeSeenAt: 1,
  removeOutcome: {
    outcome: "pending",
    receiptId: "r1",
  } satisfies MembersRemoveOutcome,
  setRoleOutcome: { outcome: "changed" } satisfies MembersSetRoleOutcome,
};

describe("MembersView", () => {
  it("shows an admin the header, seats link, Invite, role selects and Remove", () => {
    renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, SECOND_ADMIN, EDITOR, PENDING],
    });
    expect(
      screen.getByText(
        "Who is in Acme and what each person can change. Seats and allowances are on the dashboard.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Manage seats and allowances/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite" })).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Role for Priya" }),
    ).toBeTruthy();
    expect(
      screen.getByText("linked a Claude plan", { exact: false }),
    ).toBeTruthy();
    expect(screen.getByText("new@acme.test")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Remove" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
  });

  it("shows a non-admin the list without controls and a pending summary, not the address", () => {
    renderView({
      ...BASE,
      viewerRole: "viewer",
      currentUserId: "u-editor",
      members: [ADMIN, EDITOR, PENDING],
    });
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("new@acme.test")).toBeNull();
    const summary = screen.getByTestId("members-pending-summary");
    expect(within(summary).getByText("Invited · 1 pending")).toBeTruthy();
  });

  it("refuses the last admin with the remedy, no role select and no Remove", () => {
    renderView({ ...BASE, viewerRole: "admin", members: [ADMIN, EDITOR] });
    const adminRow = screen
      .getAllByTestId("members-row")
      .find((row) => row.getAttribute("data-member-id") === "u-admin");
    if (adminRow === undefined) throw new Error("admin row missing");
    expect(
      within(adminRow).getByText(/Promote another admin first\./i),
    ).toBeTruthy();
    expect(within(adminRow).queryByRole("combobox")).toBeNull();
    expect(
      within(adminRow).queryByRole("button", { name: "Remove" }),
    ).toBeNull();
  });

  it("names the remedy when Remove answers plan_required", async () => {
    const user = userEvent.setup();
    renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, EDITOR],
      removeOutcome: { outcome: "plan_required" },
    });
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(await screen.findByTestId("members-remove-confirm"));
    const banner = await screen.findByTestId("members-banner");
    expect(banner.textContent).toContain(
      "Acme has no plan. Add one on the dashboard.",
    );
    expect(screen.getByTestId("members-plan-required-link")).toBeTruthy();
  });

  it("shows the remove preview without a clock and closes on a pending removal", async () => {
    const user = userEvent.setup();
    const { onRemove } = renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, EDITOR],
    });
    await user.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByTestId("members-remove-preview-table");
    const text =
      dialog.closest("[data-testid='members-remove-preview']")?.textContent ??
      "";
    expect(text).toContain("2 turns and 1 terminal on This Mac");
    expect(text).not.toContain("within a minute");
    expect(text).not.toContain("next turn");
    expect(text).not.toContain("after 30 days");
    await user.click(screen.getByTestId("members-remove-confirm"));
    await waitFor(() =>
      expect(onRemove).toHaveBeenCalledWith({ userId: "u-editor" }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("members-remove-preview")).toBeNull(),
    );
  });

  it("omits the activity line when the host reports null counts", async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <MembersView
          environmentId="env-1"
          teamName="Acme"
          teamHandle="acme"
          currentUserId="u-admin"
          viewerRole="admin"
          members={[ADMIN, EDITOR]}
          legacyMembers={[]}
          legacyRoleNoticeSeenAt={1}
          rowDetails={() => null}
          onInvite={() => Promise.resolve({ outcome: "sent", seatDelta: null })}
          onSetRole={() => Promise.resolve({ outcome: "changed" })}
          onRemove={() =>
            Promise.resolve({ outcome: "pending", receiptId: "r" })
          }
          onLoadRemovePreview={() =>
            Promise.resolve({
              ...REMOVE_PREVIEW,
              activeTurns: null,
              terminals: null,
              hostName: null,
            })
          }
          onLoadDemotionPreview={() => Promise.resolve(DEMOTION_PREVIEW)}
          onNoticeSeen={() => undefined}
        />
      </Providers>,
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));
    const table = await screen.findByTestId("members-remove-preview-table");
    expect(table.textContent).not.toMatch(/\d+ turns?/);
  });

  it("shows the legacy notice to an admin once and reports it seen", () => {
    const { onNoticeSeen } = renderView({
      ...BASE,
      viewerRole: "admin",
      legacyRoleNoticeSeenAt: null,
      members: [ADMIN, EDITOR],
    });
    expect(screen.getByTestId("members-legacy-notice").textContent).toContain(
      "One person gained editing: Priya.",
    );
    expect(onNoticeSeen).toHaveBeenCalled();
  });

  it("does not show the legacy notice to a non-admin", () => {
    const { onNoticeSeen } = renderView({
      ...BASE,
      viewerRole: "editor",
      currentUserId: "u-editor",
      legacyRoleNoticeSeenAt: null,
      members: [ADMIN, EDITOR],
    });
    expect(screen.queryByTestId("members-legacy-notice")).toBeNull();
    expect(onNoticeSeen).not.toHaveBeenCalled();
  });
});

describe("MembersView demotion", () => {
  it("opens the demotion preview with the lost-powers line instead of changing the role", async () => {
    const user = userEvent.setup();
    const { onSetRole } = renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, SECOND_ADMIN],
    });
    await user.click(screen.getByRole("combobox", { name: "Role for Grace" }));
    await user.click(await screen.findByRole("option", { name: "Viewer" }));
    const loss = await screen.findByTestId("members-demotion-loss");
    expect(loss.textContent).toBe(
      "Grace can no longer invite, change roles or edit the approval policy.",
    );
    expect(onSetRole).not.toHaveBeenCalled();
    const dialogText = screen.getByTestId(
      "members-demotion-preview",
    ).textContent;
    expect(dialogText).not.toContain("within a minute");
    expect(dialogText).not.toContain("next turn");
  });
});
