import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  EnvironmentMembersInviteResponse,
  EnvironmentMembersRemovePreviewResponse,
  EnvironmentMembersRemoveResponse,
  EnvironmentMembersSetRoleResponse,
} from "@traycer/protocol/host/environment/contracts";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  mountTeamPage,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { dashboardRunnerHost } from "@/components/settings/host-scope/__tests__/host-access-test-support";
import { MembersView } from "@/components/settings/members/members-view";
import type {
  MembersInviteOutcome,
  MembersListMember,
  MembersRemoveOutcome,
  MembersSetRoleOutcome,
  TeamRole,
} from "@/components/settings/members/types";
import {
  useEnvironmentMembersWrites,
  type EnvironmentMembersWrites,
} from "@/hooks/environment/use-environment-members-writes";
import type { HostRpcRegistry } from "@/lib/host";
import { RunnerHostContext } from "@/providers/runner-host-context";

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

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

/** What the host answers `environment.members.removePreview` with. */
const PREVIEW: EnvironmentMembersRemovePreviewResponse = {
  activeTurns: 2,
  terminals: 1,
  localHostId: "host-local",
  sharedSignIns: ["github"],
  paidSandboxes: [],
  linkedPlan: null,
};

type PreviewAnswer = (
  userId: string,
) =>
  | EnvironmentMembersRemovePreviewResponse
  | Promise<EnvironmentMembersRemovePreviewResponse>;

function renderView(options: {
  readonly viewerRole: TeamRole;
  readonly members: readonly MembersListMember[];
  readonly currentUserId: string;
  readonly legacyRoleNoticeSeenAt: number | null;
  readonly removeOutcome: MembersRemoveOutcome;
  readonly setRoleOutcome: MembersSetRoleOutcome;
  readonly preview: PreviewAnswer;
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
  readonly onRetryMembers: Mock<() => void>;
} {
  const harness = mountTeamPage(
    { kind: "host" },
    {
      "environment.members.removePreview": (params) =>
        options.preview(params.userId),
    },
  );
  const onSetRole = vi.fn((_input: { userId: string; role: TeamRole }) =>
    Promise.resolve(options.setRoleOutcome),
  );
  const onRemove = vi.fn((_input: { userId: string }) =>
    Promise.resolve(options.removeOutcome),
  );
  const onNoticeSeen = vi.fn(() => undefined);
  const onRetryMembers = vi.fn(() => undefined);
  const rowDetails = (): ReactNode => <button type="button">Details</button>;
  render(
    <harness.Wrapper>
      <RunnerHostContext.Provider value={dashboardRunnerHost()}>
        <MembersView
          client={requireTeamHostClient()}
          environmentId="env-1"
          teamName="Acme"
          teamHandle="acme"
          teamHostCount={1}
          currentUserId={options.currentUserId}
          viewerRole={options.viewerRole}
          membersRead="ready"
          members={options.members}
          legacyMembers={["Priya"]}
          legacyRoleNoticeSeenAt={options.legacyRoleNoticeSeenAt}
          rowDetails={rowDetails}
          onRetryMembers={onRetryMembers}
          onInvite={(): Promise<MembersInviteOutcome> =>
            Promise.resolve({ outcome: "sent", seatDelta: null })
          }
          onSetRole={onSetRole}
          onRemove={onRemove}
          invitePending={false}
          setRolePending={false}
          removePending={false}
          seatsSupported={false}
          hostLabel={(hostId) => (hostId === "host-local" ? "This Mac" : null)}
          onNoticeSeen={onNoticeSeen}
        />
      </RunnerHostContext.Provider>
    </harness.Wrapper>,
  );
  return { onSetRole, onRemove, onNoticeSeen, onRetryMembers };
}

const BASE = {
  currentUserId: "u-admin",
  legacyRoleNoticeSeenAt: 1,
  removeOutcome: {
    outcome: "pending",
    receiptId: "r1",
  } satisfies MembersRemoveOutcome,
  setRoleOutcome: { outcome: "changed" } satisfies MembersSetRoleOutcome,
  preview: (): EnvironmentMembersRemovePreviewResponse => PREVIEW,
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
    renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, EDITOR],
      preview: () => ({
        ...PREVIEW,
        activeTurns: null,
        terminals: null,
        localHostId: null,
      }),
    });
    await user.click(screen.getByRole("button", { name: "Remove" }));
    const table = await screen.findByTestId("members-remove-preview-table");
    expect(table.textContent).not.toMatch(/\d+ turns?/);
  });

  it("shows the legacy notice to an admin without reporting it seen, until Dismiss", async () => {
    const user = userEvent.setup();
    const { onNoticeSeen } = renderView({
      ...BASE,
      viewerRole: "admin",
      legacyRoleNoticeSeenAt: null,
      members: [ADMIN, EDITOR],
    });
    expect(screen.getByTestId("members-legacy-notice").textContent).toContain(
      "One person gained editing: Priya.",
    );
    expect(onNoticeSeen).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("members-legacy-notice-dismiss"));

    expect(onNoticeSeen).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("members-legacy-notice")).toBeNull();
  });

  it("tags the member the notice names by name, else by email, and asks a nameless row to retry", async () => {
    const user = userEvent.setup();
    const emailOnly = member("u-mail", "", "viewer", {
      displayName: null,
      email: "mail@acme.test",
    });
    const unloaded = member("u-ghost", "", "viewer", {
      displayName: null,
      email: null,
    });
    const { onRetryMembers } = renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, EDITOR, emailOnly, unloaded],
    });
    const rowOf = (userId: string): HTMLElement => {
      const row = screen
        .getAllByTestId("members-row")
        .find((candidate) => candidate.dataset.memberId === userId);
      if (row === undefined) throw new Error(`no row for ${userId}`);
      return row;
    };
    expect(within(rowOf("u-editor")).getByText("gained editing")).toBeTruthy();
    expect(within(rowOf("u-mail")).getByText("mail@acme.test")).toBeTruthy();
    expect(within(rowOf("u-mail")).queryByText("gained editing")).toBeNull();

    await user.click(
      within(rowOf("u-ghost")).getByRole("button", { name: "Retry" }),
    );
    expect(onRetryMembers).toHaveBeenCalledTimes(1);
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

describe("MembersView preview completions", () => {
  function deferredPreviews(): {
    readonly answer: PreviewAnswer;
    readonly resolve: (
      userId: string,
      preview: EnvironmentMembersRemovePreviewResponse,
    ) => void;
  } {
    const pending = new Map<
      string,
      (preview: EnvironmentMembersRemovePreviewResponse) => void
    >();
    return {
      answer: (userId) =>
        new Promise((resolve) => {
          pending.set(userId, resolve);
        }),
      resolve: (userId, preview) => {
        const settle = pending.get(userId);
        if (settle === undefined) throw new Error(`no preview for ${userId}`);
        act(() => {
          settle(preview);
        });
      },
    };
  }

  function rowOf(userId: string): HTMLElement {
    const row = screen
      .getAllByTestId("members-row")
      .find((candidate) => candidate.getAttribute("data-member-id") === userId);
    if (row === undefined) throw new Error(`no row for ${userId}`);
    return row;
  }

  it("ignores a closed dialog's late preview for another member, and removes the member it names", async () => {
    const user = userEvent.setup();
    const previews = deferredPreviews();
    const { onRemove } = renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, SECOND_ADMIN, EDITOR],
      preview: previews.answer,
    });

    await user.click(
      within(rowOf("u-editor")).getByRole("button", { name: "Remove" }),
    );
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await user.click(
      within(rowOf("u-admin2")).getByRole("button", { name: "Remove" }),
    );
    previews.resolve("u-editor", {
      ...PREVIEW,
      paidSandboxes: [{ name: "priya-box", startedBy: "Priya" }],
    });

    const dialog = await screen.findByTestId("members-remove-preview");
    expect(dialog.textContent).toContain(
      "Remove Grace (u-admin2@acme.test) from Acme",
    );
    expect(dialog.textContent).not.toContain("priya-box");
    expect(
      within(dialog).getByTestId<HTMLButtonElement>("members-remove-confirm")
        .disabled,
    ).toBe(true);

    await waitFor(() => {
      expect(() => {
        previews.resolve("u-admin2", PREVIEW);
      }).not.toThrow();
    });
    await within(dialog).findByTestId("members-remove-preview-table");
    expect(dialog.textContent).not.toContain("priya-box");
    await user.click(within(dialog).getByTestId("members-remove-confirm"));
    await waitFor(() =>
      expect(onRemove).toHaveBeenCalledWith({ userId: "u-admin2" }),
    );
  });
});

describe("MembersView pending writes", () => {
  /** A host answer the test holds until it settles it. */
  function heldAnswer<Response>(): {
    readonly answer: () => Promise<Response>;
    readonly settle: (response: Response) => Promise<void>;
  } {
    const release: { current: ((response: Response) => void) | null } = {
      current: null,
    };
    return {
      answer: () =>
        new Promise((resolve) => {
          release.current = resolve;
        }),
      settle: async (response) => {
        const settle = release.current;
        if (settle === null) throw new Error("no request held");
        await act(async () => {
          settle(response);
          await Promise.resolve();
        });
      },
    };
  }

  /**
   * The view wired to the real writes, as the page wires it, beside a button
   * that sends a write outside the view: whatever the view shows as pending
   * can only come from the request itself.
   */
  function renderWired(options: {
    readonly members: readonly MembersListMember[];
    readonly handlers: MockHandlerMap<HostRpcRegistry>;
    readonly send: (writes: EnvironmentMembersWrites) => void;
  }): void {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.members.removePreview": () => PREVIEW,
        ...options.handlers,
      },
    );
    function Wired(): ReactNode {
      const writes = useEnvironmentMembersWrites(
        requireTeamHostClient(),
        "env-1",
      );
      return (
        <>
          <button type="button" onClick={() => options.send(writes)}>
            Send elsewhere
          </button>
          <MembersView
            client={requireTeamHostClient()}
            environmentId="env-1"
            teamName="Acme"
            teamHandle="acme"
            teamHostCount={1}
            currentUserId="u-admin"
            viewerRole="admin"
            membersRead="ready"
            members={options.members}
            legacyMembers={[]}
            legacyRoleNoticeSeenAt={1}
            rowDetails={() => null}
            onRetryMembers={() => undefined}
            onInvite={writes.invite}
            onSetRole={writes.setRole}
            onRemove={writes.remove}
            invitePending={writes.inviteMutation.isPending}
            setRolePending={writes.setRoleMutation.isPending}
            removePending={writes.removeMutation.isPending}
            seatsSupported={false}
            hostLabel={() => null}
            onNoticeSeen={() => undefined}
          />
        </>
      );
    }
    render(
      <harness.Wrapper>
        <RunnerHostContext.Provider value={dashboardRunnerHost()}>
          <Wired />
        </RunnerHostContext.Provider>
      </harness.Wrapper>,
    );
  }

  it("holds Send invite while an invite request is pending, and frees it once the host answers", async () => {
    const user = userEvent.setup();
    const host = heldAnswer<EnvironmentMembersInviteResponse>();
    renderWired({
      members: [ADMIN, EDITOR],
      handlers: { "environment.members.invite": host.answer },
      send: (writes) => {
        void writes.invite({ email: "other@acme.test", role: "editor" });
      },
    });
    await user.click(screen.getByRole("button", { name: "Send elsewhere" }));
    await user.click(screen.getByRole("button", { name: "Invite" }));
    await user.type(
      await screen.findByTestId("members-invite-email"),
      "new@acme.test",
    );
    const submit = screen.getByTestId<HTMLButtonElement>(
      "members-invite-submit",
    );
    await waitFor(() => expect(submit.disabled).toBe(true));
    await host.settle({ outcome: "sent", seatDelta: null });
    await waitFor(() => expect(submit.disabled).toBe(false));
  });

  it("holds Remove while a remove request is pending, and frees it once the host answers", async () => {
    const user = userEvent.setup();
    const host = heldAnswer<EnvironmentMembersRemoveResponse>();
    renderWired({
      members: [ADMIN, SECOND_ADMIN, EDITOR],
      handlers: { "environment.members.remove": host.answer },
      send: (writes) => {
        void writes.remove({ userId: "u-admin2" });
      },
    });
    await user.click(screen.getByRole("button", { name: "Send elsewhere" }));
    const editorRow = screen
      .getAllByTestId("members-row")
      .find((row) => row.getAttribute("data-member-id") === "u-editor");
    if (editorRow === undefined) throw new Error("editor row missing");
    await user.click(within(editorRow).getByRole("button", { name: "Remove" }));
    await screen.findByTestId("members-remove-preview-table");
    const confirm = screen.getByTestId<HTMLButtonElement>(
      "members-remove-confirm",
    );
    await waitFor(() => expect(confirm.disabled).toBe(true));
    await host.settle({ outcome: "revoked" });
    await waitFor(() => expect(confirm.disabled).toBe(false));
  });

  it("holds the demotion while a role change is pending, and frees it once the host answers", async () => {
    const user = userEvent.setup();
    const host = heldAnswer<EnvironmentMembersSetRoleResponse>();
    renderWired({
      members: [ADMIN, SECOND_ADMIN, EDITOR],
      handlers: { "environment.members.setRole": host.answer },
      send: (writes) => {
        void writes.setRole({ userId: "u-editor", role: "viewer" });
      },
    });
    await user.click(screen.getByRole("button", { name: "Send elsewhere" }));
    await user.click(screen.getByRole("combobox", { name: "Role for Grace" }));
    await user.click(await screen.findByRole("option", { name: "Viewer" }));
    await screen.findByTestId("members-demotion-loss");
    const confirm = screen.getByTestId<HTMLButtonElement>(
      "members-demotion-confirm",
    );
    await waitFor(() => expect(confirm.disabled).toBe(true));
    await host.settle({ outcome: "changed" });
    await waitFor(() => expect(confirm.disabled).toBe(false));
  });
});
