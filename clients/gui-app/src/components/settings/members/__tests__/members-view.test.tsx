import { vi as vitest } from "vitest";

// The toast surface is the one external boundary these cases read; the view,
// its dialogs and the writes beneath them stay real.
const toasts = vitest.hoisted(() => ({
  success: vitest.fn(),
  info: vitest.fn(),
}));
vitest.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: {
    success: toasts.success,
    info: toasts.info,
    warning: vitest.fn(),
    error: vitest.fn(),
    message: vitest.fn(),
    dismiss: vitest.fn(),
  },
}));

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
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
  toasts.success.mockReset();
  toasts.info.mockReset();
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
  /** The real client the view reads through, for settling assertions. */
  readonly queryClient: QueryClient;
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
  return {
    onSetRole,
    onRemove,
    onNoticeSeen,
    onRetryMembers,
    queryClient: harness.queryClient,
  };
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

function rowOf(userId: string): HTMLElement {
  const row = screen
    .getAllByTestId("members-row")
    .find((candidate) => candidate.dataset.memberId === userId);
  if (row === undefined) throw new Error(`no row for ${userId}`);
  return row;
}

interface DeferredPreviews {
  readonly answer: PreviewAnswer;
  readonly resolve: (
    userId: string,
    preview: EnvironmentMembersRemovePreviewResponse,
  ) => void;
  readonly delivered: (userId: string) => boolean;
}

/**
 * Previews the test answers by hand, one per member. `delivered` says the
 * answer has left the host boundary, so a case that expects an answer to
 * change nothing can wait for it before asserting that nothing changed.
 */
function deferredPreviews(): DeferredPreviews {
  const pending = new Map<
    string,
    (preview: EnvironmentMembersRemovePreviewResponse) => void
  >();
  const delivered = new Set<string>();
  return {
    answer: (userId) =>
      new Promise<EnvironmentMembersRemovePreviewResponse>((resolve) => {
        pending.set(userId, resolve);
      }).then((preview) => {
        delivered.add(userId);
        return preview;
      }),
    resolve: (userId, preview) => {
      const settle = pending.get(userId);
      if (settle === undefined) throw new Error(`no preview for ${userId}`);
      act(() => {
        settle(preview);
      });
    },
    delivered: (userId) => delivered.has(userId),
  };
}

/**
 * Answer a held preview and wait for the read it belongs to to be over, so a
 * case asserting that a late answer changes nothing is asserting it after the
 * answer. Three witnesses, because no one of them holds in every case: the
 * host boundary says the bytes left; the client's own `isFetching` says the
 * query that asked for them is no longer running, which is trivially true once
 * a withdrawn pick's query has been reaped; and the flush is last rather than
 * instead, since a count of microtasks I picked is not a completion signal.
 */
async function settled(
  previews: DeferredPreviews,
  queryClient: QueryClient,
  userId: string,
): Promise<void> {
  await waitFor(() => {
    expect(() => {
      previews.resolve(userId, { ...PREVIEW, linkedPlan: "Claude Max" });
    }).not.toThrow();
  });
  await waitFor(() => expect(previews.delivered(userId)).toBe(true));
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  await act(async () => {
    await Promise.resolve();
  });
}

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
      "Priya can now edit.",
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
      "Grace can no longer invite people, change roles or edit the approval policy. Grace can no longer change Acme's settings. They can still see them.",
    );
    expect(onSetRole).not.toHaveBeenCalled();
    const dialogText = screen.getByTestId(
      "members-demotion-preview",
    ).textContent;
    expect(dialogText).not.toContain("within a minute");
    expect(dialogText).not.toContain("next turn");
  });

  // NEW-154-23: Editor → Viewer is a demotion too, and had no confirm at all.
  it("confirms an editor's demotion to viewer before writing it", async () => {
    const user = userEvent.setup();
    const { onSetRole } = renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, SECOND_ADMIN, EDITOR],
    });
    await user.click(screen.getByRole("combobox", { name: "Role for Priya" }));
    await user.click(await screen.findByRole("option", { name: "Viewer" }));

    expect(
      await screen.findByText("Change Priya's role in Acme to viewer?"),
    ).toBeTruthy();
    expect(screen.getByTestId("members-demotion-loss").textContent).toBe(
      "Priya can no longer change Acme's settings. They can still see them.",
    );
    expect(screen.getByTestId("members-demotion-confirm").textContent).toBe(
      "Change to viewer",
    );
    expect(onSetRole).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("members-demotion-confirm"));
    await waitFor(() =>
      expect(onSetRole).toHaveBeenCalledWith({
        userId: "u-editor",
        role: "viewer",
      }),
    );
  });

  it("writes a promotion straight through, with no confirm", async () => {
    const user = userEvent.setup();
    const { onSetRole } = renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, SECOND_ADMIN, EDITOR],
    });
    await user.click(screen.getByRole("combobox", { name: "Role for Priya" }));
    await user.click(await screen.findByRole("option", { name: "Admin" }));

    await waitFor(() =>
      expect(onSetRole).toHaveBeenCalledWith({
        userId: "u-editor",
        role: "admin",
      }),
    );
    expect(screen.queryByTestId("members-demotion-preview")).toBeNull();
  });

  it("previews no plan unlink when the member linked none", async () => {
    const user = userEvent.setup();
    renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, SECOND_ADMIN],
      preview: () => ({ ...PREVIEW, linkedPlan: null }),
    });
    await user.click(screen.getByRole("combobox", { name: "Role for Grace" }));
    await user.click(await screen.findByRole("option", { name: "Editor" }));

    await screen.findByTestId("members-demotion-loss");
    expect(screen.queryByTestId("members-demotion-preview-table")).toBeNull();
    expect(
      screen.getByTestId("members-demotion-preview").textContent,
    ).not.toContain("stop using this plan");
  });
});

/**
 * What the accessible description says at the one moment it is announced.
 * Radix reads `aria-describedby` when focus enters the dialog and the node is
 * not a live region, so a consequence written into it after that is one a
 * screen reader is never told: the question has to be whole when the dialog
 * arrives, not merely by the time it settles. Hence the observer — a reading
 * taken afterwards passes whatever order the sentences were written in.
 */
function describedAtFirstAppearance(): {
  readonly text: () => string | null;
  readonly stop: () => void;
} {
  let first: string | null = null;
  const read = (): void => {
    if (first !== null) return;
    const dialog = document.querySelector(
      '[data-testid="members-demotion-preview"]',
    );
    if (dialog === null) return;
    const describedBy = dialog.getAttribute("aria-describedby");
    first =
      describedBy === null
        ? ""
        : (document.getElementById(describedBy)?.textContent ?? "");
  };
  const observer = new MutationObserver(read);
  // Attributes too: the reading must not depend on `aria-describedby` landing
  // in the same commit as the dialog node, or a later commit would be read as
  // an empty description and fail the case for the wrong reason.
  observer.observe(document.body, {
    attributes: true,
    childList: true,
    subtree: true,
  });
  return { text: () => first, stop: () => observer.disconnect() };
}

describe("MembersView demotion announcement", () => {
  it("has the whole consequence in the description the moment the dialog appears", async () => {
    const user = userEvent.setup();
    const appearance = describedAtFirstAppearance();
    renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, SECOND_ADMIN, EDITOR],
      preview: () => ({ ...PREVIEW, linkedPlan: "Claude Max" }),
    });
    await user.click(screen.getByRole("combobox", { name: "Role for Priya" }));
    await user.click(await screen.findByRole("option", { name: "Viewer" }));

    let described: string | null = null;
    try {
      await screen.findByTestId("members-demotion-preview-table");
      described = appearance.text();
    } finally {
      // Bounded whatever happens above: an observer left on `document.body`
      // outlives this case and reads the next one's dialogs.
      appearance.stop();
    }
    expect(described).not.toBeNull();
    expect(described).toContain(
      "Priya can no longer change Acme's settings. They can still see them.",
    );
    expect(described).toContain("Acme's agents stop using this plan.");
  });

  it("says the check is running on the row, and opens nothing, while the read is slow", async () => {
    const user = userEvent.setup();
    const previews = deferredPreviews();
    renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, SECOND_ADMIN, EDITOR],
      preview: previews.answer,
    });
    await user.click(screen.getByRole("combobox", { name: "Role for Priya" }));
    await user.click(await screen.findByRole("option", { name: "Viewer" }));

    await waitFor(() =>
      expect(
        within(rowOf("u-editor")).getByTestId("members-role-checking"),
      ).toBeTruthy(),
    );
    expect(screen.queryByTestId("members-demotion-preview")).toBeNull();

    await waitFor(() => {
      expect(() => {
        previews.resolve("u-editor", { ...PREVIEW, linkedPlan: "Claude Max" });
      }).not.toThrow();
    });

    await screen.findByTestId("members-demotion-preview");
    expect(
      within(rowOf("u-editor")).queryByTestId("members-role-checking"),
    ).toBeNull();
  });

  // While the check is out there is no dialog to cancel, so the next pick is
  // how the person takes the demotion back. The answer then belongs to a
  // question nobody is asking any more.
  it("drops a pending demotion when the person picks another role instead", async () => {
    const user = userEvent.setup();
    const previews = deferredPreviews();
    const { onSetRole, queryClient } = renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, SECOND_ADMIN, EDITOR],
      preview: previews.answer,
    });
    await user.click(screen.getByRole("combobox", { name: "Role for Priya" }));
    await user.click(await screen.findByRole("option", { name: "Viewer" }));
    await waitFor(() =>
      expect(
        within(rowOf("u-editor")).getByTestId("members-role-checking"),
      ).toBeTruthy(),
    );

    await user.click(screen.getByRole("combobox", { name: "Role for Priya" }));
    await user.click(await screen.findByRole("option", { name: "Admin" }));
    await waitFor(() =>
      expect(onSetRole).toHaveBeenCalledWith({
        userId: "u-editor",
        role: "admin",
      }),
    );
    expect(screen.queryByTestId("members-demotion-preview")).toBeNull();

    await settled(previews, queryClient, "u-editor");
    // The answer belongs to a question nobody is asking any more, so it opens
    // nothing. Asserted before the row's own tell on purpose: dropping the
    // demotion is what both depend on, and this is the consequence that would
    // put a dialog in front of someone who had moved on.
    expect(screen.queryByTestId("members-demotion-preview")).toBeNull();
    expect(
      within(rowOf("u-editor")).queryByTestId("members-role-checking"),
    ).toBeNull();
  });

  // The window the deferral opened leaves the row live, so every other opener
  // in this view is a gesture that can land a confirm on top of the dialog it
  // just opened. One case per opener, because the rule has to be written at
  // each of them: `openRemove` serves Remove AND Revoke, and Invite is its own.
  it.each([
    {
      opener: "Remove",
      press: async (user: UserEvent) => {
        await user.click(
          within(rowOf("u-editor")).getByRole("button", { name: "Remove" }),
        );
      },
      opened: "members-remove-preview",
    },
    {
      opener: "Revoke",
      press: async (user: UserEvent) => {
        await user.click(screen.getByRole("button", { name: "Revoke" }));
      },
      opened: "members-revoke-dialog",
    },
    {
      opener: "Invite",
      press: async (user: UserEvent) => {
        await user.click(screen.getByTestId("members-invite"));
      },
      opened: "members-invite-dialog",
    },
    {
      // Details is opened inside the row's own entry, which this view does not
      // own, so the row withdraws the pick when anything in its action group
      // is pressed. The harness's entry is a plain button, which is the whole
      // claim: a press in that group, whatever it opens.
      opener: "Details",
      press: async (user: UserEvent) => {
        await user.click(
          within(rowOf("u-editor")).getByRole("button", { name: "Details" }),
        );
      },
      opened: null,
    },
  ])(
    "drops a pending demotion when the person presses $opener instead",
    async ({ press, opened }) => {
      const user = userEvent.setup();
      const previews = deferredPreviews();
      const { queryClient } = renderView({
        ...BASE,
        viewerRole: "admin",
        members: [ADMIN, SECOND_ADMIN, EDITOR, PENDING],
        preview: previews.answer,
      });
      await user.click(
        screen.getByRole("combobox", { name: "Role for Priya" }),
      );
      await user.click(await screen.findByRole("option", { name: "Viewer" }));
      await waitFor(() =>
        expect(
          within(rowOf("u-editor")).getByTestId("members-role-checking"),
        ).toBeTruthy(),
      );

      await press(user);
      if (opened !== null) await screen.findByTestId(opened);

      await settled(previews, queryClient, "u-editor");
      expect(screen.queryByTestId("members-demotion-preview")).toBeNull();
    },
  );

  // The select is controlled on the role the member HOLDS, so picking that
  // role again fires nothing: without a control of its own, the only way out
  // of this window would be promoting the person to a role nobody chose.
  it("withdraws a pending demotion from the row's own Cancel", async () => {
    const user = userEvent.setup();
    const previews = deferredPreviews();
    const { onSetRole, queryClient } = renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, SECOND_ADMIN, EDITOR],
      preview: previews.answer,
    });
    await user.click(screen.getByRole("combobox", { name: "Role for Priya" }));
    await user.click(await screen.findByRole("option", { name: "Viewer" }));

    const tell = await waitFor(() =>
      within(rowOf("u-editor")).getByTestId("members-role-checking"),
    );
    // It names the role being checked, which the select cannot: that still
    // shows the role Priya holds.
    expect(tell.textContent).toContain("Checking viewer…");
    await user.click(
      within(tell).getByRole("button", {
        name: "Cancel the change to viewer for Priya",
      }),
    );

    expect(
      within(rowOf("u-editor")).queryByTestId("members-role-checking"),
    ).toBeNull();
    await settled(previews, queryClient, "u-editor");
    expect(screen.queryByTestId("members-demotion-preview")).toBeNull();
    expect(onSetRole).not.toHaveBeenCalled();
  });

  // The Retry lives in the dialog, so the dialog has to survive its own
  // request. A refused FIRST read has no data, and the query's fetch dispatch
  // un-errors an entry in that state, so a gate reading `isError` closes the
  // dialog under the button that was just pressed.
  it("keeps the dialog up while a refused read is being tried again", async () => {
    const user = userEvent.setup();
    const previews = deferredPreviews();
    let refusals = 0;
    renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, SECOND_ADMIN, EDITOR],
      preview: (userId) => {
        refusals += 1;
        return refusals === 1
          ? Promise.reject(new Error("unreachable"))
          : previews.answer(userId);
      },
    });
    await user.click(screen.getByRole("combobox", { name: "Role for Priya" }));
    await user.click(await screen.findByRole("option", { name: "Viewer" }));

    const dialog = await screen.findByTestId("members-demotion-preview");
    await within(dialog).findByTestId("members-demotion-preview-failed");

    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(refusals).toBe(2));

    // Still up, with the second read in flight: its confirm off, and the line
    // and the button that started the request still in place rather than
    // unmounted with the failed status they were keyed on.
    expect(screen.getByTestId("members-demotion-preview")).toBeTruthy();
    expect(
      screen.getByTestId<HTMLButtonElement>("members-demotion-confirm")
        .disabled,
    ).toBe(true);
    expect(
      within(dialog).getByTestId("members-demotion-preview-failed").textContent,
    ).toContain("Couldn't load what changing Priya's role interrupts");
    expect(
      within(dialog).getByRole<HTMLButtonElement>("button", { name: "Retry" })
        .disabled,
    ).toBe(true);
    expect(
      within(dialog).getByTestId("members-demotion-retry-busy"),
    ).toBeTruthy();

    await waitFor(() => {
      expect(() => {
        previews.resolve("u-editor", { ...PREVIEW, linkedPlan: "Claude Max" });
      }).not.toThrow();
    });
    await within(dialog).findByTestId("members-demotion-preview-table");
    expect(
      within(dialog).queryByTestId("members-demotion-preview-failed"),
    ).toBeNull();
  });
});

// NEW-154-2: the removal's own tell, named as the row and the preview name them.
describe("MembersView removal toast", () => {
  it("says the member is no longer in the team, by name", async () => {
    const user = userEvent.setup();
    renderView({ ...BASE, viewerRole: "admin", members: [ADMIN, EDITOR] });
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(await screen.findByTestId("members-remove-confirm"));

    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith("Member removed", {
        description: "Priya is no longer in Acme.",
      }),
    );
  });

  it("stays silent when the removal is refused", async () => {
    const user = userEvent.setup();
    renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, EDITOR],
      removeOutcome: { outcome: "plan_required" },
    });
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(await screen.findByTestId("members-remove-confirm"));

    await screen.findByTestId("members-banner");
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("stays silent when an invitation is revoked, which removes no member", async () => {
    const user = userEvent.setup();
    renderView({
      ...BASE,
      viewerRole: "admin",
      members: [ADMIN, EDITOR, PENDING],
    });
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(await screen.findByTestId("members-revoke-confirm"));

    await waitFor(() =>
      expect(screen.queryByTestId("members-revoke-dialog")).toBeNull(),
    );
    expect(toasts.success).not.toHaveBeenCalled();
  });
});

describe("MembersView preview completions", () => {
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
