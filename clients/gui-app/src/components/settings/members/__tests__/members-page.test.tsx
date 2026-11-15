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
 * The account's teams as the app has them at sign-in (the environment list
 * joins the viewer's role and the team's handle from them as its first read
 * starts), and the window's own host as one of the team's computers, which is
 * the only one that counts a removed member's work.
 */
function seedAccount(): void {
  useSelectionAuthorityStore.setState({
    effectiveHostId: mockLocalHostEntry.hostId,
  });
}

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
    // No account team is seeded here: the environment list's join of the
    // viewer's role would wait on this same outstanding read, so the list
    // names the team degraded and the heading still reads Acme.
    const harness = mountTeamHarness(
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
    const ghost = rowOf("u-ghost");
    expect(ghost.textContent).toContain("Couldn't load this member");
    expect(ghost.textContent).not.toContain("u-ghost");
    expect(within(ghost).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it.each([
    {
      displayName: " Alice ",
      email: "alice@acme.test",
      legacyName: " Alice ",
    },
    {
      displayName: null,
      email: " alice@acme.test ",
      legacyName: "alice@acme.test",
    },
  ])(
    "keeps the gained editing badge for whitespace-padded identities: $legacyName",
    async ({ displayName, email, legacyName }) => {
      const harness = mountTeamPage(
        { kind: "host" },
        {
          "environment.list": () => ({ environments: [TEAM] }),
          "environment.members": () => ({
            ...membersPage([ADA, { ...PRIYA, displayName, email }]),
            legacyMembers: [legacyName],
          }),
        },
      );
      render(<MembersPage environmentId="env-a" />, {
        wrapper: harness.Wrapper,
      });

      await screen.findByText("Acme · 2 people");
      expect(within(rowOf("u-priya")).getByText("gained editing")).toBeTruthy();
      expect(within(rowOf("u-admin")).queryByText("gained editing")).toBeNull();
    },
  );

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

  it("names a member with no name by email everywhere, and shows None. rows and null work as no count", async () => {
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
        name: "Remove m@acme.dev from Acme",
      }),
    ).toBeTruthy();
    expect(
      within(dialog).getByTestId("members-remove-confirm").textContent,
    ).toBe("Remove m@acme.dev");
    const cells = table.querySelectorAll("tr");
    const valueOf = (label: string): string | undefined =>
      Array.from(cells)
        .find((row) => row.querySelector("th")?.textContent === label)
        ?.querySelector("td")?.textContent;
    expect(valueOf("m@acme.dev's work now")).toBe(
      "m@acme.dev's access is revoked now. Anything they have running finishes its current step and starts no new one; Traycer can't list that work from here.",
    );
    expect(valueOf("Shared sign-ins")).toBe("None.");
    expect(valueOf("Linked plan")).toBe("None.");
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
          return { outcome: "removed" };
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
          return { outcome: "removed" };
        },
      },
    );
    render(<MembersPage environmentId="env-a" />, {
      wrapper: harness.Wrapper,
    });

    await confirmRemoval();

    expect(await screen.findByTestId("members-read-failed")).toBeTruthy();
    expect(screen.queryByText(/removing/iu)).toBeNull();
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
