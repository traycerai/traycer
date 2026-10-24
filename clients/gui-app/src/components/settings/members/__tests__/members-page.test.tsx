import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentDescriptorV11,
  EnvironmentMemberV11,
  EnvironmentMembersRemovePreviewResponse,
} from "@traycer/protocol/host/environment/contracts";
import {
  mountTeamPage,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { MembersPage } from "@/components/settings/members/members-page";
import {
  useHostNotificationsStore,
  type HostNotificationFeedEntry,
} from "@/stores/notifications/host-notifications-store";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
  useOptionalHostClient: () => requireTeamHostClient(),
  useHostDirectory: () => ({
    findById: (hostId: string) =>
      hostId === "host-local" ? { label: "This Mac" } : null,
  }),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "u-admin",
}));
// The host's handshake is the external boundary: it serves every Members method.
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => true,
  useHostSupportsMethod: () => true,
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useHostNotificationsStore.setState({ byId: {} });
});

const TEAM: EnvironmentDescriptorV11 = {
  environmentId: "env-a",
  ownerKind: "organization",
  ownerId: "team-a",
  roomId: "room-a",
  label: "Acme",
  effectiveRole: "admin",
  kind: "team",
  hostCount: 1,
  providerHandle: "acme",
};

function member(
  userId: string,
  displayName: string,
  effectiveRole: EnvironmentMemberV11["effectiveRole"],
): EnvironmentMemberV11 {
  return {
    userId,
    displayName,
    avatarUrl: null,
    effectiveRole,
    linkedPlan: false,
    inviteState: "accepted",
    invitedAddress: null,
  };
}

const ADA = member("u-admin", "Ada", "admin");
const GRACE = member("u-grace", "Grace", "admin");
const PRIYA = member("u-priya", "Priya", "editor");

function membersPage(members: readonly EnvironmentMemberV11[]) {
  return {
    members: [...members],
    nextCursor: null,
    legacyRoleNoticeSeenAt: 1,
    legacyMembers: [],
  };
}

const PREVIEW: EnvironmentMembersRemovePreviewResponse = {
  activeTurns: 2,
  terminals: 1,
  localHostId: "host-local",
  sharedSignIns: [],
  paidSandboxes: [],
  linkedPlan: null,
};

function rowOf(userId: string): HTMLElement {
  const row = screen
    .getAllByTestId("members-row")
    .find((candidate) => candidate.getAttribute("data-member-id") === userId);
  if (row === undefined) throw new Error(`no row for ${userId}`);
  return row;
}

function removalNotice(
  id: string,
  receiptId: string | null,
  factState: "pending" | "done",
): HostNotificationFeedEntry {
  return {
    id,
    updatedAt: 1_700_000_000_000,
    readAt: null,
    sourceRef: null,
    epicId: null,
    chatId: null,
    kind: "team.member.removed",
    severity: "info",
    outcome: "completed",
    payload: {
      kind: "team_member_removed",
      environmentId: "env-a",
      teamName: "Acme",
      memberName: "Priya",
      receiptId,
      hosts: [
        {
          hostId: "host-local",
          hostName: "This Mac",
          stopped: "done",
          credentialClosed: "done",
          replacementDelivered: factState,
        },
      ],
    },
  };
}

function deliver(entry: HostNotificationFeedEntry): void {
  act(() => {
    useHostNotificationsStore
      .getState()
      .applyUpsertFrame(entry, [], { unreadCount: 1, attentionCount: 0 });
  });
}

describe("MembersPage members read", () => {
  it("shows a loading state, not an empty team, while the read is outstanding", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => new Promise(() => undefined),
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await screen.findByText(/^Who is in Acme/);
    expect(harness.paramsOf("environment.members")).toHaveLength(1);
    expect(screen.queryByText(/Acme · 0 people/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.getByTestId("members-loading")).toBeTruthy();
  });

  it("shows a failed read with Retry and no Invite, and Retry reads again", async () => {
    let fail = true;
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => {
          if (fail) throw new Error("pool unavailable");
          return membersPage([ADA, PRIYA]);
        },
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await vi.waitFor(() => {
      expect(screen.queryByText(/Acme · 0 people/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
      expect(screen.getByTestId("members-read-failed")).toBeTruthy();
    });
    const failure = screen.getByTestId("members-read-failed");
    expect(failure.textContent).toContain("Couldn't load Acme's members.");

    fail = false;
    await userEvent.click(
      within(failure).getByRole("button", { name: "Retry" }),
    );
    expect(await screen.findByText("Acme · 2 people")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite" })).toBeTruthy();
  });

  it("shows an empty successful read as the empty team", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => membersPage([]),
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    expect(await screen.findByText("Acme · 0 people")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite" })).toBeTruthy();
  });
});

describe("MembersPage offboarding previews", () => {
  it("keeps a failed remove preview as a failure with Retry, and Remove stays off until one loads", async () => {
    let fail = true;
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => membersPage([ADA, PRIYA]),
        "environment.members.removePreview": () => {
          if (fail) throw new Error("unreachable");
          return PREVIEW;
        },
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await userEvent.click(
      within(
        await screen.findByText("Priya").then(() => rowOf("u-priya")),
      ).getByRole("button", { name: "Remove" }),
    );
    const dialog = await screen.findByTestId("members-remove-preview");
    await vi.waitFor(() => {
      expect(
        within(dialog).queryByTestId("members-remove-preview-busy"),
      ).toBeNull();
    });
    expect(dialog.textContent).not.toContain("pays for no");
    expect(dialog.textContent).not.toContain("None.");
    expect(
      within(dialog).getByTestId<HTMLButtonElement>("members-remove-confirm")
        .disabled,
    ).toBe(true);
    expect(
      within(dialog).getByTestId("members-remove-preview-failed").textContent,
    ).toContain("Couldn't load what removing Priya interrupts");

    fail = false;
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Retry" }),
    );
    expect(
      (await within(dialog).findByTestId("members-remove-preview-table"))
        .textContent,
    ).toContain("2 turns and 1 terminal on This Mac");
    expect(
      within(dialog).getByTestId<HTMLButtonElement>("members-remove-confirm")
        .disabled,
    ).toBe(false);
  });

  it("says a demotion's turn count is unavailable when the host cannot see it, never 0", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => membersPage([ADA, GRACE]),
        "environment.members.removePreview": () => ({
          ...PREVIEW,
          activeTurns: null,
          terminals: null,
          localHostId: null,
        }),
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await userEvent.click(
      await screen.findByRole("combobox", { name: "Role for Grace" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Viewer" }),
    );
    const table = await screen.findByTestId("members-demotion-preview-table");
    expect(table.textContent).toContain("Unavailable");
    expect(table.textContent).not.toMatch(/\d+ turns? on Claude Code/);
  });

  it("keeps a failed demotion preview as a failure, with Change role off", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => membersPage([ADA, GRACE]),
        "environment.members.removePreview": () => {
          throw new Error("unreachable");
        },
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await userEvent.click(
      await screen.findByRole("combobox", { name: "Role for Grace" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Viewer" }),
    );
    const dialog = await screen.findByTestId("members-demotion-preview");
    await vi.waitFor(() => {
      expect(
        within(dialog).queryByTestId("members-demotion-preview-busy"),
      ).toBeNull();
    });
    expect(dialog.textContent).not.toContain("0 turns");
    expect(
      within(dialog).getByTestId<HTMLButtonElement>("members-demotion-confirm")
        .disabled,
    ).toBe(true);
    expect(
      within(dialog).getByTestId("members-demotion-preview-failed").textContent,
    ).toContain("Couldn't load what changing Grace's role interrupts");
  });
});

describe("MembersPage pending removal", () => {
  it("keeps a removed member's row pending after the membership is gone, until a removal notice with its receipt reports every host done", async () => {
    let removed = false;
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () =>
          membersPage(removed ? [ADA] : [ADA, PRIYA]),
        "environment.members.removePreview": () => PREVIEW,
        "environment.members.remove": () => {
          removed = true;
          return { outcome: "pending", receiptId: "removal:env-a:7" };
        },
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await screen.findByText("Priya");
    await userEvent.click(
      within(rowOf("u-priya")).getByRole("button", { name: "Remove" }),
    );
    await screen.findByTestId("members-remove-preview-table");
    await userEvent.click(screen.getByTestId("members-remove-confirm"));

    // The next read no longer lists Priya: the row stays, pending.
    await vi.waitFor(() => {
      expect(harness.paramsOf("environment.members").length).toBeGreaterThan(1);
    });
    await vi.waitFor(() => {
      expect(rowOf("u-priya").getAttribute("data-removal-state")).toBe(
        "pending",
      );
    });
    expect(screen.getByText("Acme · 1 person")).toBeTruthy();

    deliver(removalNotice("n-other", "removal:env-a:6", "done"));
    deliver(removalNotice("n-legacy", null, "done"));
    deliver(removalNotice("n-partial", "removal:env-a:7", "pending"));
    expect(rowOf("u-priya").getAttribute("data-removal-state")).toBe("pending");

    deliver(removalNotice("n-partial", "removal:env-a:7", "done"));
    expect(rowOf("u-priya").getAttribute("data-removal-state")).toBe("done");
    expect(
      within(rowOf("u-priya")).queryByRole("button", { name: "Remove" }),
    ).toBeNull();
  });
});
