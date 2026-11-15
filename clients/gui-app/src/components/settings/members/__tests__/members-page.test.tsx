import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentDescriptorV11,
  EnvironmentMemberV12,
  EnvironmentMembersRemovePreviewResponse,
} from "@traycer/protocol/host/environment/contracts";
import {
  authnAnswer,
  mountTeamPage as mountTeamHarness,
  mountTeamPageNegotiating,
  requireTeamEnvironmentAuthnBinding,
  requireTeamHostClient,
  resetTeamPageHarness,
  setTeamEnvironmentCloudOverride,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { reachableHost } from "@/components/settings/environment/__tests__/mcp-skills-test-support";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MembersPage } from "@/components/settings/members/members-page";
import { useHostNotificationsStore } from "@/stores/notifications/host-notifications-store";

// The toast surface is the one external boundary a removal's outcome reaches:
// a completed removal says so, and a failed one raises a banner instead.
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: {
    success: toasts.success,
    error: toasts.error,
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  },
}));
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
afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useAuthStore.setState({ profile: null });
  useSelectionAuthorityStore.getState().reset();
  useHostNotificationsStore.setState({ byId: {} });
  toasts.success.mockReset();
  toasts.error.mockReset();
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
  effectiveRole: EnvironmentMemberV12["effectiveRole"],
): EnvironmentMemberV12 {
  return {
    userId,
    displayName,
    email: `${userId}@acme.test`,
    avatarUrl: null,
    effectiveRole,
    linkedPlan: false,
    inviteState: "accepted",
    invitedAddress: null,
  };
}

/**
 * The window's own host as the effective one, which counts a removed member's
 * work when authn's host list names it one of the team's computers.
 */
function seedAccount(): void {
  useSelectionAuthorityStore.setState({
    effectiveHostId: mockLocalHostEntry.hostId,
  });
}

/**
 * The account's teams as the app has them at sign-in: the environment list
 * joins the viewer's role and the team's handle from them as its first read
 * starts.
 */
function seedTeams(): void {
  useAuthStore.setState({
    shareableTeams: [{ teamId: TEAM.ownerId, slug: "acme", avatarUrl: null }],
  });
}

function withOwnHost(
  handlers: Parameters<typeof mountTeamHarness>[1],
): Parameters<typeof mountTeamHarness>[1] {
  return {
    "environment.host.list": () => ({
      hosts: [{ ...reachableHost, hostId: mockLocalHostEntry.hostId }],
    }),
    ...handlers,
  };
}

function mountTeamPage(
  source: Parameters<typeof mountTeamHarness>[0],
  handlers: Parameters<typeof mountTeamHarness>[1],
): TeamPageHarness {
  seedAccount();
  const harness = mountTeamHarness(source, withOwnHost(handlers));
  seedTeams();
  return harness;
}

/** The same page, on a host whose handshake negotiated the given methods. */
function mountTeamPageOnHost(
  source: Parameters<typeof mountTeamHarness>[0],
  handlers: Parameters<typeof mountTeamHarness>[1],
  negotiated: Parameters<typeof mountTeamPageNegotiating>[2],
): TeamPageHarness {
  seedAccount();
  const harness = mountTeamPageNegotiating(
    source,
    withOwnHost(handlers),
    negotiated,
  );
  seedTeams();
  return harness;
}

const ADA = member("u-admin", "Ada", "admin");
const GRACE = member("u-grace", "Grace", "admin");
const PRIYA = member("u-priya", "Priya", "editor");

function membersPage(members: readonly EnvironmentMemberV12[]) {
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

describe("MembersPage members read", () => {
  it("shows a loading state, not an empty team, while the read is outstanding", async () => {
    let reads = 0;
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => {
          reads += 1;
          // The first read is the environment list's join of the viewer's
          // role, which names the team and which the page waits for; the page's
          // own read is the next, and stays outstanding.
          if (reads === 1) return membersPage([ADA]);
          return new Promise(() => undefined);
        },
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await screen.findByText(/^Who is in Acme/);
    await vi.waitFor(() => {
      expect(harness.paramsOf("environment.members")).toHaveLength(2);
    });
    expect(screen.queryByText(/Acme · 0 people/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.getByTestId("members-loading")).toBeTruthy();
  });

  it("shows a failed read with Retry and no Invite, and Retry reads again", async () => {
    let fail = true;
    let reads = 0;
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => {
          reads += 1;
          // The first read is the environment list's join of the viewer's
          // role, which the page waits for; the page's own read is the next.
          if (fail && reads > 1) throw new Error("pool unavailable");
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
    expect(failure.textContent).toContain(
      "Couldn't load who gained editing with this update.",
    );

    fail = false;
    await userEvent.click(
      within(failure).getByRole("button", { name: "Retry" }),
    );
    expect(await screen.findByText("Acme · 2 people")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite" })).toBeTruthy();
  });

  it("tells a non-admin the team's members could not load, on one line with Retry", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({
          environments: [{ ...TEAM, effectiveRole: "viewer" }],
        }),
        "environment.members": () => {
          throw new Error("pool unavailable");
        },
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    const failure = await screen.findByTestId("members-read-failed");
    expect(failure.textContent).toBe("Couldn't load Acme's members.Retry");
  });

  it("keeps a listed retired role from regaining admin controls through the descriptor", async () => {
    useAuthStore.setState({
      profile: { userId: "u-admin", userName: "Ada", email: "ada@acme.test" },
    });
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () =>
          membersPage([{ ...ADA, effectiveRole: "viewer" }, PRIYA]),
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await screen.findByText("Acme · 2 people");
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(
      within(rowOf("u-priya")).queryByRole("button", { name: "Remove" }),
    ).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Role for Priya" }),
    ).toBeNull();
  });

  it("names members by name and email, you by name, and never by user id", async () => {
    useAuthStore.setState({
      profile: { userId: "u-admin", userName: "Ada", email: "ada@acme.test" },
    });
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () =>
          membersPage([
            ADA,
            PRIYA,
            { ...GRACE, email: null },
            { ...member("u-noname", "", "viewer"), displayName: null },
            {
              ...member("u-ghost", "", "viewer"),
              displayName: null,
              email: null,
            },
          ]),
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    expect(await screen.findByText("Ada · you")).toBeTruthy();
    expect(screen.getByText("Priya")).toBeTruthy();
    expect(screen.getByText("Grace")).toBeTruthy();
    expect(screen.getByText("u-noname@acme.test")).toBeTruthy();
    expect(screen.getByText("u-admin@acme.test")).toBeTruthy();
    // Authn's read names a member with neither a name nor an email "Member"
    // (since d42de7c79, which mirrors #9264's memberDisplayName), so the
    // unloaded line with Retry is not reachable for an accepted member.
    const ghost = rowOf("u-ghost");
    expect(within(ghost).getByText("Member")).toBeTruthy();
    expect(ghost.textContent).not.toContain("u-ghost");
    expect(within(ghost).queryByTestId("members-row-unloaded")).toBeNull();
    expect(within(ghost).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps the gained editing badge for a whitespace-padded name", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => ({
          ...membersPage([
            ADA,
            { ...PRIYA, displayName: " Alice ", email: "alice@acme.test" },
          ]),
          legacyMembers: [" Alice "],
        }),
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await screen.findByText("Acme · 2 people");
    expect(within(rowOf("u-priya")).getByText("gained editing")).toBeTruthy();
    expect(within(rowOf("u-admin")).queryByText("gained editing")).toBeNull();
  });

  it("gives a nameless member the legacy list names by email no gained editing tag, since their name reads Member", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => ({
          ...membersPage([
            ADA,
            { ...PRIYA, displayName: null, email: " alice@acme.test " },
          ]),
          legacyMembers: ["alice@acme.test"],
        }),
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await screen.findByText("Acme · 2 people");
    expect(within(rowOf("u-priya")).getByText("Member")).toBeTruthy();
    expect(within(rowOf("u-priya")).queryByText("gained editing")).toBeNull();
    expect(within(rowOf("u-admin")).queryByText("gained editing")).toBeNull();
  });

  it("adds the step-down remedy to the last admin's own line", async () => {
    useAuthStore.setState({
      profile: { userId: "u-admin", userName: "Ada", email: "ada@acme.test" },
    });
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => membersPage([ADA, PRIYA]),
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    expect(
      await screen.findByText(
        "u-admin@acme.test · to step down, promote another admin first.",
      ),
    ).toBeTruthy();
  });

  it("shows the legacy notice until Dismiss, which reports it seen once and hides it", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => ({
          ...membersPage([ADA, PRIYA]),
          legacyRoleNoticeSeenAt: null,
          legacyMembers: ["Priya"],
        }),
        "environment.members.noticeSeen": () => ({ outcome: "recorded" }),
      },
    );
    const view = render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    const notice = await screen.findByTestId("members-legacy-notice");
    expect(notice.textContent).toContain(
      "With this update every existing member can edit Acme's settings. Priya can now edit. Set a role beside each name to change that.",
    );
    view.rerender(<MembersPage environmentId="env-a" />);
    expect(screen.getByTestId("members-legacy-notice")).toBeTruthy();
    expect(harness.paramsOf("environment.members.noticeSeen")).toHaveLength(0);

    await userEvent.click(screen.getByTestId("members-legacy-notice-dismiss"));

    await vi.waitFor(() => {
      expect(harness.paramsOf("environment.members.noticeSeen")).toEqual([
        { environmentId: "env-a" },
      ]);
    });
    expect(screen.queryByTestId("members-legacy-notice")).toBeNull();
  });

  it("shows the team's members on a host that negotiates environment.members below 1.1", async () => {
    const harness = mountTeamPageOnHost(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => membersPage([ADA, PRIYA]),
      },
      { "environment.members": { major: 1, minor: 0 } },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    expect(await screen.findByText("Acme · 2 people")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite" })).toBeTruthy();
    expect(screen.queryByTestId("members-needs-update")).toBeNull();
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
        "environment.members.removePreview": () => PREVIEW,
      },
    );
    // The confirm's preview is authn's read; the computer's work counts are
    // asked once per opening and never again, so it is authn's that fails.
    const cloud = requireTeamEnvironmentAuthnBinding().auth.environmentCloud();
    setTeamEnvironmentCloudOverride({
      ...cloud,
      transport: (request) =>
        fail && new URL(request.url).pathname.endsWith("/removal-preview")
          ? Promise.resolve({ status: 503, text: "{}" })
          : cloud.transport(request),
    });
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

  it("names the member by name in the removal preview and its button by first name", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () =>
          membersPage([ADA, { ...PRIYA, displayName: "Priya Shah" }]),
        "environment.members.removePreview": () => PREVIEW,
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await screen.findByText("Priya Shah");
    await userEvent.click(
      within(rowOf("u-priya")).getByRole("button", { name: "Remove" }),
    );
    const dialog = await screen.findByTestId("members-remove-preview");
    await within(dialog).findByTestId("members-remove-preview-table");
    expect(
      within(dialog).getByRole("heading", {
        name: "Remove Priya Shah (u-priya@acme.test) from Acme",
      }),
    ).toBeTruthy();
    expect(
      within(dialog).getByTestId("members-remove-confirm").textContent,
    ).toBe("Remove Priya");
    expect(dialog.textContent).toContain("Priya Shah's work now");
    expect(
      within(dialog).getByTestId("members-remove-preview-table").textContent,
    ).not.toContain("u-priya@acme.test");
  });

  it("names a member with no name Member everywhere, and shows None. rows and null work as no count", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () =>
          membersPage([
            ADA,
            { ...PRIYA, displayName: null, email: "m@acme.dev" },
          ]),
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

    await screen.findByText("m@acme.dev");
    await userEvent.click(
      within(rowOf("u-priya")).getByRole("button", { name: "Remove" }),
    );
    const dialog = await screen.findByTestId("members-remove-preview");
    const table = await within(dialog).findByTestId(
      "members-remove-preview-table",
    );
    expect(
      within(dialog).getByRole("heading", {
        name: "Remove Member (m@acme.dev) from Acme",
      }),
    ).toBeTruthy();
    expect(
      within(dialog).getByTestId("members-remove-confirm").textContent,
    ).toBe("Remove Member");
    const cells = table.querySelectorAll("tr");
    const valueOf = (label: string): string | undefined =>
      Array.from(cells)
        .find((row) => row.querySelector("th")?.textContent === label)
        ?.querySelector("td")?.textContent;
    expect(valueOf("Member's work now")).toBe(
      "Their connections close. Work they started keeps running for Acme under their name.",
    );
    expect(valueOf("Shared sign-ins")).toBe("None.");
    expect(valueOf("Can't be recalled")).toBe(
      'Files Member already copied off a host and work already done upstream with Acme\'s services. What Member started stays, labelled "started by a former member".',
    );
    expect(valueOf("Linked plan")).toBeUndefined();
    expect(dialog.textContent).not.toContain("u-priya");
    expect(dialog.textContent).not.toMatch(/\d+ turns?/);
  });
});

const PENDING_SEATS_SENTENCE =
  "Pending invitations count toward the team's paid seats as soon as they are sent, before acceptance.";
const SEAT_SENTENCE = `${PENDING_SEATS_SENTENCE} The team will use 5 of 5 seats; nothing is charged now. The next invitation will add a seat.`;

async function openInvite(): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: "Invite" }));
}

describe("MembersPage invite seats", () => {
  it("states the seat rule and the count once sent, before Invite is pressed, for a paid team", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => membersPage([ADA]),
        "environment.members.seats": () => ({ seats: { used: 4, total: 5 } }),
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await openInvite();
    expect(
      (await screen.findByTestId("members-invite-seat-copy")).textContent,
    ).toBe(SEAT_SENTENCE);
    expect(harness.paramsOf("environment.members.invite")).toHaveLength(0);
  });

  it.each([
    {
      name: "a full team, which adds a seat and charges it now",
      seats: { used: 5, total: 5 },
      sentence:
        "The team has no free seat, so sending this adds one: it will use 6 of 6 seats. The added seat is charged now to the team's card on file, prorated for the rest of the current billing period.",
    },
    {
      name: "a team with seats to spare, which keeps only the seats in use at period end",
      seats: { used: 2, total: 5 },
      sentence:
        "The team will use 3 of 5 seats; nothing is charged now. At the end of this billing period, the team keeps only the seats in use and stops paying for the others.",
    },
  ])(
    "states what sending does to the seats for $name",
    async ({ seats, sentence }) => {
      const harness = mountTeamPage(
        { kind: "host" },
        {
          "environment.list": () => ({ environments: [TEAM] }),
          "environment.members": () => membersPage([ADA]),
          "environment.members.seats": () => ({ seats }),
        },
      );
      render(<MembersPage environmentId="env-a" />, {
        wrapper: harness.Wrapper,
      });

      await openInvite();
      expect(
        (await screen.findByTestId("members-invite-seat-copy")).textContent,
      ).toBe(`${PENDING_SEATS_SENTENCE} ${sentence}`);
    },
  );

  it("says nothing about seats for a team on no paid plan", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => membersPage([ADA]),
        "environment.members.seats": () => ({ seats: null }),
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await openInvite();
    await vi.waitFor(() => {
      expect(harness.paramsOf("environment.members.seats")).toHaveLength(1);
    });
    const sheet = await screen.findByRole("dialog");
    await vi.waitFor(() => {
      expect(harness.queryClient.isFetching()).toBe(0);
    });
    expect(screen.queryByTestId("members-invite-seat-copy")).toBeNull();
    expect(screen.queryByTestId("members-invite-seats-failed")).toBeNull();
    expect(within(sheet).queryByText(/seats/)).toBeNull();
  });

  it("says a refused read failed, reads again on Retry, and leaves Invite enabled", async () => {
    let fail = true;
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => membersPage([ADA]),
        "environment.members.seats": () => {
          if (fail) throw new Error("billing unavailable");
          return { seats: { used: 4, total: 5 } };
        },
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await openInvite();
    const failed = await screen.findByTestId("members-invite-seats-failed");
    expect(failed.textContent).toContain("Couldn't read the team's seats.");
    await userEvent.type(
      screen.getByTestId("members-invite-email"),
      "new@acme.test",
    );
    expect(
      screen.getByTestId<HTMLButtonElement>("members-invite-submit").disabled,
    ).toBe(false);

    fail = false;
    await userEvent.click(
      within(failed).getByRole("button", { name: "Retry" }),
    );
    expect(
      (await screen.findByTestId("members-invite-seat-copy")).textContent,
    ).toBe(SEAT_SENTENCE);
    expect(harness.paramsOf("environment.members.seats")).toHaveLength(2);
    expect(screen.queryByTestId("members-invite-seats-failed")).toBeNull();
  });

  it("states the seat rule on a host that negotiates no seats method", async () => {
    const harness = mountTeamPageOnHost(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => membersPage([ADA]),
        "environment.members.seats": () => ({ seats: { used: 4, total: 5 } }),
      },
      { "environment.members": { major: 1, minor: 1 } },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await openInvite();
    expect(
      (await screen.findByTestId("members-invite-seat-copy")).textContent,
    ).toBe(SEAT_SENTENCE);
    expect(harness.paramsOf("environment.members.seats")).toHaveLength(1);
  });
});

describe("MembersPage removal", () => {
  async function confirmRemoval(): Promise<void> {
    await screen.findByText("Priya");
    await userEvent.click(
      within(rowOf("u-priya")).getByRole("button", { name: "Remove" }),
    );
    await screen.findByTestId("members-remove-preview-table");
    await userEvent.click(screen.getByTestId("members-remove-confirm"));
  }

  it("drops a removed member once authn answers the removal, with no removing state", async () => {
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
          // authn's answer for an accepted member's removal: the commit
          // already made, with the operation's id.
          return { outcome: "pending", receiptId: "receipt-1" };
        },
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await confirmRemoval();

    expect(await screen.findByText("Acme · 1 person")).toBeTruthy();
    expect(screen.queryByText("Priya")).toBeNull();
    expect(screen.queryByText(/removing/iu)).toBeNull();
    expect(harness.paramsOf("environment.members.remove")).toEqual([
      { environmentId: "env-a", userId: "u-priya" },
    ]);
    // The removal is shown as done, not as failed.
    expect(toasts.success.mock.calls[0]?.[0]).toBe("Member removed");
    expect(toasts.error).not.toHaveBeenCalled();
    expect(screen.queryByTestId("members-banner")).toBeNull();
    expect(screen.queryByTestId("members-remove-refusal")).toBeNull();
  });

  it("shows the list's own failure when the read after a removal fails", async () => {
    let removed = false;
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => {
          if (removed) throw new Error("pool unavailable");
          return membersPage([ADA, PRIYA]);
        },
        "environment.members.removePreview": () => PREVIEW,
        "environment.members.remove": () => {
          removed = true;
          // authn's answer for an accepted member's removal: the commit
          // already made, with the operation's id.
          return { outcome: "pending", receiptId: "receipt-1" };
        },
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await confirmRemoval();

    expect(await screen.findByTestId("members-read-failed")).toBeTruthy();
    expect(screen.queryByText(/removing/iu)).toBeNull();
    // The removal itself was done; only the read after it failed.
    expect(toasts.success.mock.calls[0]?.[0]).toBe("Member removed");
    expect(toasts.error).not.toHaveBeenCalled();
    expect(screen.queryByTestId("members-banner")).toBeNull();
  });
});

describe("MembersPage refused writes", () => {
  const LAST_ADMIN_LINE = "Promote another admin first.";

  async function openRemoveDialog(): Promise<HTMLElement> {
    await screen.findByText("Priya");
    await userEvent.click(
      within(rowOf("u-priya")).getByRole("button", { name: "Remove" }),
    );
    await screen.findByTestId("members-remove-preview-table");
    await userEvent.click(screen.getByTestId("members-remove-confirm"));
    return screen.getByTestId("members-remove-preview");
  }

  it("says an admin removes people when the host answers a removal forbidden, and keeps the dialog open", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => membersPage([ADA, PRIYA]),
        "environment.members.removePreview": () => PREVIEW,
        "environment.members.remove": () => ({ outcome: "forbidden" }),
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    const dialog = await openRemoveDialog();

    expect(
      (await within(dialog).findByTestId("members-remove-refusal")).textContent,
    ).toBe("An admin removes people.");
    expect(screen.getByTestId("members-remove-preview")).toBeTruthy();
  });

  it("says an admin changes roles when the host answers a role change forbidden", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => membersPage([ADA, GRACE]),
        "environment.members.setRole": () => ({ outcome: "forbidden" }),
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await userEvent.click(
      await screen.findByRole("combobox", { name: "Role for Grace" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Editor" }),
    );
    // A demotion is confirmed before it is written, so the refusal answers
    // the confirmed write.
    await userEvent.click(
      await screen.findByRole("button", { name: "Change to editor" }),
    );

    expect((await screen.findByTestId("members-banner")).textContent).toBe(
      "An admin changes roles.",
    );
    expect(harness.paramsOf("environment.members.setRole")).toEqual([
      { environmentId: "env-a", userId: "u-grace", role: "editor" },
    ]);
  });

  it("says the removal failed, not that the last admin must be promoted, when the request is rejected", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => membersPage([ADA, PRIYA]),
        "environment.members.removePreview": () => PREVIEW,
        "environment.members.remove": () => {
          throw new Error("host unavailable");
        },
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    const dialog = await openRemoveDialog();

    const refusal = await within(dialog).findByTestId("members-remove-refusal");
    expect(refusal.textContent).toBe("Couldn't remove that member.");
    expect(refusal.textContent).not.toBe(LAST_ADMIN_LINE);
    expect(screen.getByTestId("members-remove-preview")).toBeTruthy();
  });

  it("says the invitation could not be sent, not that an admin invites people, when the request is rejected", async () => {
    const harness = mountTeamPage(
      { kind: "host" },
      {
        "environment.list": () => ({ environments: [TEAM] }),
        "environment.members": () => membersPage([ADA]),
        "environment.members.seats": () => ({ seats: null }),
        "environment.members.invite": () => {
          throw new Error("host unavailable");
        },
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await openInvite();
    await userEvent.type(
      await screen.findByTestId("members-invite-email"),
      "new@acme.test",
    );
    await userEvent.click(screen.getByTestId("members-invite-submit"));

    expect(
      (await screen.findByTestId("members-invite-refusal")).textContent,
    ).toBe("Couldn't send that invitation.");
  });
});

/**
 * authn's members answer for `members` as it is on the wire, where a seat
 * stored on the retired Viewer role answers `effectiveRole: null`: on the row of
 * `nullRoleUserIds`, and on the reader's own role when `readerRole` is `null`.
 */
function wireMembers(
  members: readonly EnvironmentMemberV12[],
  nullRoleUserIds: readonly string[],
  readerRole: "admin" | null,
) {
  return {
    members: members.map((entry) => ({
      id: entry.userId,
      email: entry.email ?? "",
      user: {
        id: entry.userId,
        name: entry.displayName,
        avatarUrl: entry.avatarUrl,
      },
      effectiveRole: nullRoleUserIds.includes(entry.userId)
        ? null
        : entry.effectiveRole,
      linkedPlan: entry.linkedPlan,
      inviteState: entry.inviteState,
      invitedAddress: entry.invitedAddress,
    })),
    viewer: {
      effectiveRole: readerRole,
      legacyRoleNoticeSeenAt: null,
      legacyMembers: [],
    },
  };
}

describe("MembersPage with a seat stored on the Viewer role", () => {
  const RAE = member("u-rae", "Rae", "viewer");
  const SAM = member("u-sam", "Sam", "viewer");
  const MEMBERS_ROUTE = "GET /api/v3/environments/env-a/members";

  /** A row's text with its member's name and id made the same, to compare two rows. */
  function rowShape(userId: string, name: string): string {
    return rowOf(userId)
      .textContent.replaceAll(name, "<name>")
      .replaceAll(userId, "<id>");
  }

  function mountServing(
    roster: { current: readonly EnvironmentMemberV12[] },
    handlers: Parameters<typeof mountTeamHarness>[1],
    readerRole: "admin" | null,
  ): TeamPageHarness {
    const harness = mountTeamPage(
      { kind: "host" },
      { "environment.list": () => ({ environments: [TEAM] }), ...handlers },
    );
    harness.cloudResponses.set(MEMBERS_ROUTE, () =>
      authnAnswer(200, wireMembers(roster.current, ["u-rae"], readerRole)),
    );
    return harness;
  }

  it("draws a member whose role answers null as it draws one whose role answers viewer", async () => {
    const harness = mountServing(
      { current: [ADA, PRIYA, RAE, SAM] },
      {},
      "admin",
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    expect(await screen.findByText("Acme · 4 people")).toBeTruthy();
    expect(rowShape("u-rae", "Rae")).toBe(rowShape("u-sam", "Sam"));
  });

  it("changes another member's role with that seat on the page, and shows no failure", async () => {
    const roster = {
      current: [ADA, GRACE, RAE] as readonly EnvironmentMemberV12[],
    };
    const harness = mountServing(
      roster,
      {
        "environment.members.setRole": () => {
          roster.current = roster.current.map((entry) =>
            entry.userId === "u-grace"
              ? { ...entry, effectiveRole: "editor" }
              : entry,
          );
          return { outcome: "changed" };
        },
      },
      "admin",
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await userEvent.click(
      await screen.findByRole("combobox", { name: "Role for Grace" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Editor" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Change to editor" }),
    );

    expect(
      within(
        await screen.findByRole("combobox", { name: "Role for Grace" }),
      ).getByText("Editor"),
    ).toBeTruthy();
    expect(harness.paramsOf("environment.members.setRole")).toEqual([
      { environmentId: "env-a", userId: "u-grace", role: "editor" },
    ]);
    expect(screen.queryByTestId("members-banner")).toBeNull();
    expect(toasts.error).not.toHaveBeenCalled();
    expect(rowOf("u-rae")).toBeTruthy();
  });

  it("removes another member with that seat on the page, and shows it done", async () => {
    const roster = {
      current: [ADA, PRIYA, RAE] as readonly EnvironmentMemberV12[],
    };
    const harness = mountServing(
      roster,
      {
        "environment.members.removePreview": () => PREVIEW,
        "environment.members.remove": () => {
          roster.current = roster.current.filter(
            (entry) => entry.userId !== "u-priya",
          );
          return { outcome: "pending", receiptId: "receipt-1" };
        },
      },
      "admin",
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

    expect(await screen.findByText("Acme · 2 people")).toBeTruthy();
    expect(screen.queryByText("Priya")).toBeNull();
    expect(toasts.success.mock.calls[0]?.[0]).toBe("Member removed");
    expect(toasts.error).not.toHaveBeenCalled();
    expect(screen.queryByTestId("members-banner")).toBeNull();
    expect(screen.queryByTestId("members-remove-refusal")).toBeNull();
    expect(rowOf("u-rae")).toBeTruthy();
  });

  it("draws a reader stored on the Viewer role the page without admin controls", async () => {
    const harness = mountServing({ current: [ADA, PRIYA] }, {}, null);
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await screen.findByText("Acme · 2 people");
    expect(screen.queryByTestId("members-read-failed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(
      within(rowOf("u-priya")).queryByRole("button", { name: "Remove" }),
    ).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Role for Priya" }),
    ).toBeNull();
  });
});
