const hoisted = vi.hoisted(() => ({
  toasts: [] as { message: string; options: { id?: string } | undefined }[],
}));
vi.mock("sonner", () => ({
  toast: Object.assign(
    (message: string, options: { id?: string } | undefined) => {
      hoisted.toasts.push({ message, options });
    },
    { success: () => undefined, info: () => undefined },
  ),
}));

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentDescriptorV11,
  EnvironmentInvitation,
} from "@traycer/protocol/host/environment/contracts";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { ConfigurationSourceBoundary } from "@/components/settings/environment/configuration-source-boundary";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useEnvironmentInvitationsQuery } from "@/hooks/environment/use-environment-invitations";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import {
  useInvitedTeamName,
  usePickedTeamLabel,
} from "@/components/settings/environment/team-pick-label";
import { HeldValueHostRuntime } from "@/components/settings/personal/__tests__/held-value-host-runtime";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { SettingsSurface } from "@/components/settings/settings-surface";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  negotiateMethods,
  negotiateMethodsOn,
} from "./mcp-skills-test-support";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  requireViewingHostClient,
  resetTeamPageHarness,
  teamHostBoundary,
} from "./team-configuration-test-support";

/**
 * NEW-154-6: a page whose team the environment list no longer carries. The
 * person was removed, or removed and invited back; either way the page used to
 * read "These settings are no longer available." with a blank trigger.
 * NEW-154-24: a viewer's one standing line, which the boundary gives every
 * cloud-read page at once.
 */

/**
 * The surface moves are asserted as the COMMANDS they issue, not as a call to
 * the helper that issues them: which helper runs is the thing under test, so a
 * mock of it would pass whatever it was handed. `navigateToSettingsSection` is
 * the real one here, reaching this recording modal bridge, and only
 * `rememberSettingsTabSection` is stood in for — its own target is a tab this
 * suite does not lay out, and what matters is that it, and nothing that
 * activates, is what a server fact reaches for.
 */
const surface = vi.hoisted(() => ({
  openSettings: vi.fn(),
  setSection: vi.fn(),
  remember: vi.fn(),
  replaceOwnedRoute: vi.fn(),
  overlayActive: false,
}));

/**
 * The route, which is the third presentation and the one `remember` cannot
 * move: `SettingsSurface` prefers the route wherever Settings owns it. The
 * real surface is rendered against this state in the arm that owns the route,
 * so that arm asserts the section DRAWN rather than the call made — with the
 * effect out of frame, a call cannot be told apart from a no-op.
 */
const router = vi.hoisted(() => ({
  pathname: "/epics",
  listeners: new Set<() => void>(),
}));
vi.mock("@tanstack/react-router", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useRouter: () => ({ navigate: vi.fn() }),
    useRouterState: ({
      select,
    }: {
      select: (state: {
        readonly location: { readonly pathname: string };
      }) => unknown;
    }) =>
      useSyncExternalStore(
        (onChange: () => void) => {
          router.listeners.add(onChange);
          return () => {
            router.listeners.delete(onChange);
          };
        },
        () => select({ location: { pathname: router.pathname } }),
      ),
  };
});
vi.mock("@/components/settings/settings-sidebar", () => ({
  SettingsSidebar: () => null,
}));
vi.mock("@/components/settings/settings-modal-content", () => ({
  SettingsPanelForSection: (props: { readonly section: string }) => (
    <div data-section={props.section} data-testid="settings-panel-probe" />
  ),
}));
vi.mock("@/stores/tabs/system-tab-modal-bridge", () => ({
  getSystemTabModalApi: () => ({
    isOverlayActive: (kind: string) =>
      kind === "settings" && surface.overlayActive,
    openSettings: surface.openSettings,
    setSection: surface.setSection,
    // The bridge's own route move, recorded AND performed: what it does to a
    // real router is asserted in `stores/tabs/__tests__/use-system-tab-modal`,
    // against real Settings routes. Here it has to actually move the route, or
    // the surface below has nothing to redraw from.
    replaceOwnedSettingsRoute: (section: string) => {
      surface.replaceOwnedRoute(section);
      if (!router.pathname.startsWith("/settings")) return;
      router.pathname = `/settings/${section}`;
      // Notified, not just mutated: a route the surface never re-rendered for
      // would let a case pass on a move nobody could see.
      for (const listener of router.listeners) listener();
    },
    active: null,
    close: () => undefined,
  }),
}));
vi.mock("@/lib/settings-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settings-navigation")>()),
  rememberSettingsTabSection: surface.remember,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

beforeEach(() => {
  hoisted.toasts.length = 0;
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  surface.openSettings.mockClear();
  surface.setSection.mockClear();
  surface.remember.mockClear();
  surface.replaceOwnedRoute.mockClear();
  surface.overlayActive = false;
  router.pathname = "/epics";
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
});

const V10 = { major: 1, minor: 0 } as const;

const PERSONAL: EnvironmentDescriptorV11 = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner",
  kind: "personal",
  hostCount: 1,
  providerHandle: null,
};

function team(
  effectiveRole: EnvironmentDescriptorV11["effectiveRole"],
): EnvironmentDescriptorV11 {
  return {
    environmentId: "env-a",
    ownerKind: "organization",
    ownerId: "team-a",
    roomId: "room-a",
    label: "Acme",
    effectiveRole,
    kind: "team",
    hostCount: 1,
    providerHandle: "handle-a",
  };
}

const INVITATION: EnvironmentInvitation = {
  environmentId: "env-a",
  teamName: "Acme",
  role: "editor",
  paidPlan: false,
};

/**
 * Reads the other host, as a second window on the same account does, so that
 * host's entries exist and hold its answers. Unmounted, those entries stay in
 * cache with nothing observing them — the window closed.
 */
function WarmOtherHost(): ReactNode {
  const client = requireViewingHostClient();
  useEnvironmentListQuery(client, true);
  useEnvironmentInvitationsQuery(client);
  return null;
}

/**
 * A render of the page that is already mounted, which is the only re-render a
 * case about the ask effect's dependencies can mean. An external store rather
 * than a handle the component writes during render, which the hooks rules
 * rightly refuse: {@link MountedPage} only reads.
 */
const rerenders = { tick: 0, listeners: new Set<() => void>() };

function renderMountedPageAgain(): void {
  rerenders.tick += 1;
  for (const listener of rerenders.listeners) listener();
}

function useRerenderTick(): number {
  return useSyncExternalStore(
    (listener: () => void) => {
      rerenders.listeners.add(listener);
      return () => rerenders.listeners.delete(listener);
    },
    () => rerenders.tick,
    () => rerenders.tick,
  );
}

function MountedPage(): ReactNode {
  useRerenderTick();
  return (
    <PersonalPageFrame section="secrets">
      <Probe />
    </PersonalPageFrame>
  );
}

function Probe(): ReactNode {
  const source = useConfigurationSource();
  return (
    <p data-testid="probe">
      {source.kind === "host" ? "host" : source.environmentId}
    </p>
  );
}

/**
 * Mounts the boundary on `env-a` with the list the host answers. The list is
 * read again after `onListed`, so a removal is the same list changing under an
 * open page.
 */
function mountBoundary(options: {
  readonly environments: () => readonly EnvironmentDescriptorV11[];
  readonly invitations: readonly EnvironmentInvitation[];
}): { readonly rerenderList: () => Promise<void> } {
  negotiateMethods({
    "environment.invitations.list": V10,
    "environment.invitations.accept": V10,
  });
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "team", environmentId: "env-a" },
  });
  const harness = mountTeamPage(poolSource("editor"), {
    "environment.list": () => ({ environments: [...options.environments()] }),
    "environment.invitations.list": () => ({
      invitations: [...options.invitations],
    }),
  });
  render(
    <ConfigurationSourceBoundary
      section={null}
      target={{ kind: "team", environmentId: "env-a" }}
    >
      <Probe />
    </ConfigurationSourceBoundary>,
    { wrapper: harness.Wrapper },
  );
  return {
    // Only the membership list, so the case cannot pass by refreshing the
    // invitations read as a side effect of the removal.
    rerenderList: () =>
      harness.queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes("environment.list"),
      }),
  };
}

/**
 * The removal through the real frame, which is what makes the toast necessary:
 * `PersonalPageFrame` keys its cloud frame by the selection, so moving the
 * selection unmounts the boundary and anything it was holding. A case that
 * mounts the boundary on a fixed `target` never sees that, and would pass on a
 * page state the app throws away.
 */
function mountFrame(options: {
  readonly environments: () => readonly EnvironmentDescriptorV11[];
  readonly invitations: readonly EnvironmentInvitation[];
}): { readonly rerenderList: () => Promise<void> } {
  negotiateMethods({
    "environment.invitations.list": V10,
    "environment.invitations.accept": V10,
  });
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "team", environmentId: "env-a" },
  });
  const harness = mountTeamPage(poolSource("editor"), {
    "environment.list": () => ({ environments: [...options.environments()] }),
    "environment.invitations.list": () => ({
      invitations: [...options.invitations],
    }),
  });
  render(
    <HeldValueHostRuntime>
      <PersonalPageFrame section="secrets">
        <Probe />
      </PersonalPageFrame>
    </HeldValueHostRuntime>,
    { wrapper: harness.Wrapper },
  );
  return {
    // Only the membership list, as above.
    rerenderList: () =>
      harness.queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes("environment.list"),
      }),
  };
}

describe("a team the environment list no longer carries", () => {
  it("says the person is no longer in it, once, and moves the selection to Personal", async () => {
    const listed: { current: readonly EnvironmentDescriptorV11[] } = {
      current: [PERSONAL, team("editor")],
    };
    const { rerenderList } = mountFrame({
      environments: () => listed.current,
      invitations: [],
    });
    await screen.findByTestId("probe");
    expect(hoisted.toasts).toEqual([]);

    listed.current = [PERSONAL];
    await rerenderList();

    // The selection moves off a team no page can read, which is what unmounts
    // the page the removal happened on.
    await waitFor(() =>
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        PERSONAL_PICK,
      ),
    );
    // The sentence outlives that page, and is raised once under the team's own
    // id, so a remount or a re-read of the same removal cannot stack it.
    expect(hoisted.toasts).toEqual([
      {
        message: "You're no longer in Acme.",
        options: { id: "environment-left:env-a" },
      },
    ]);
    // The page the person lands on has mounted — Personal's own, read from
    // the cloud — and carries nothing of the dead team.
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("env-personal"),
    );
    expect(document.body.textContent).not.toContain("Acme");
    expect(document.body.textContent).not.toContain("You're no longer in");
  });

  it("raises nothing for a team it never read the name of", async () => {
    const { rerenderList } = mountFrame({
      environments: () => [PERSONAL],
      invitations: [],
    });
    await rerenderList();

    await waitFor(() =>
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        PERSONAL_PICK,
      ),
    );
    // A pick made on another computer: the selection still moves, because no
    // page can read it, but no removal is claimed from a team never seen.
    expect(hoisted.toasts).toEqual([]);
  });

  it("offers Review for a team that has invited the person back", async () => {
    mountBoundary({
      environments: () => [PERSONAL],
      invitations: [INVITATION],
    });

    expect(
      await screen.findByText(
        "You're invited to Acme. Accept to see and change its settings.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
    expect(
      screen.queryByText("These settings are no longer available."),
    ).toBeNull();
    // An invitation is not a membership: the selection stays, so the trigger
    // and the Review keep naming the same team.
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "team",
      environmentId: "env-a",
    });
  });

  it("re-reads the invitations the membership list's answer outdated, and keeps the team", async () => {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    const listed: { current: readonly EnvironmentDescriptorV11[] } = {
      current: [PERSONAL, team("editor")],
    };
    const invited: { current: readonly EnvironmentInvitation[] } = {
      current: [],
    };
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => ({ environments: [...listed.current] }),
      "environment.invitations.list": () => ({
        invitations: [...invited.current],
      }),
    });
    render(
      <HeldValueHostRuntime>
        <PersonalPageFrame section="secrets">
          <Probe />
        </PersonalPageFrame>
      </HeldValueHostRuntime>,
      { wrapper: harness.Wrapper },
    );
    await screen.findByTestId("probe");

    // Removed and invited back between the two reads. Only the membership
    // list is marked stale — `invalidateConfigurationReads` leaves the
    // invitations read alone, and that read neither polls nor refreshes on
    // focus — so the empty answer in hand predates the invitation.
    listed.current = [PERSONAL];
    invited.current = [INVITATION];
    await harness.queryClient.invalidateQueries({
      predicate: (query) => query.queryKey.includes("environment.list"),
    });

    expect(
      await screen.findByText(
        "You're invited to Acme. Accept to see and change its settings.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
    expect(hoisted.toasts).toEqual([]);
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "team",
      environmentId: "env-a",
    });
  });

  it("stops trusting its answer when the read moves to the other slot", async () => {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    const listed: { current: readonly EnvironmentDescriptorV11[] } = {
      current: [PERSONAL, team("editor")],
    };
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => ({ environments: [...listed.current] }),
      "environment.invitations.list": () => ({ invitations: [INVITATION] }),
    });
    render(
      <HeldValueHostRuntime>
        <PersonalPageFrame section="secrets">
          <Probe />
        </PersonalPageFrame>
      </HeldValueHostRuntime>,
      { wrapper: harness.Wrapper },
    );
    await screen.findByTestId("probe");

    // Removed and invited back: the host's route answers, so the team stays
    // and Review is offered.
    listed.current = [PERSONAL];
    await harness.queryClient.invalidateQueries({
      predicate: (query) => query.queryKey.includes("environment.list"),
    });
    expect(await screen.findByRole("button", { name: "Review" })).toBeTruthy();

    // Now the serving host stops advertising Accept, which moves the read to
    // the authn route's slot. That slot holds nothing this session, so the
    // list the page renders becomes empty — but nothing has ANSWERED there, so
    // the answer the host's route gave is no longer evidence about what is on
    // screen, and a removal claimed on it would move a person off a team they
    // can rejoin and never offer them the Accept.
    await act(async () => {
      negotiateMethods({ "environment.invitations.list": V10 });
      await Promise.resolve();
    });

    expect(hoisted.toasts).toEqual([]);
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "team",
      environmentId: "env-a",
    });
  });

  // Two entries of ONE slot. A build with no server pool gives each host its
  // own RPC entry for the same account, so the slot never changes when the
  // client does — and a question certified while one entry served must not
  // survive the move to the other, whose cached list predates the removal.
  //
  // The clock is held so both hosts' membership answers carry the same
  // `listedAt`: that equality is what isolates the entry identity as the only
  // thing standing between the old answer and the new entry's stale data. It
  // is a condition of this case, not a claim that every host switch fails.
  it("cannot reuse one entry's answer for another entry of the same slot", async () => {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    const frozen = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(frozen);
    try {
      const listed: { current: readonly EnvironmentDescriptorV11[] } = {
        current: [PERSONAL, team("editor")],
      };
      const invited = { current: false };
      const harness = mountTeamPage(poolSource("editor"), {
        "environment.list": () => ({ environments: [...listed.current] }),
        "environment.invitations.list": () => ({
          invitations: invited.current ? [INVITATION] : [],
        }),
      });
      // A held clock makes `timeUntilStale` zero, so without a `staleTime` the
      // harness refetches forever and nothing ever settles. The clock is held
      // for the membership timestamps, so the staleness has to be restored by
      // hand.
      harness.queryClient.setDefaultOptions({
        queries: { retry: false, gcTime: Infinity, staleTime: 60_000 },
      });
      const remote = requireViewingHostClient();
      negotiateMethodsOn(remote.getActiveHostId() ?? "", {
        "environment.invitations.list": V10,
        "environment.invitations.accept": V10,
      });
      const tree = (warm: boolean): ReactNode => (
        <HeldValueHostRuntime>
          {warm ? <WarmOtherHost /> : null}
          <PersonalPageFrame section="secrets">
            <Probe />
          </PersonalPageFrame>
        </HeldValueHostRuntime>
      );
      const view = render(tree(true), { wrapper: harness.Wrapper });
      await screen.findByTestId("probe");
      await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));

      // The other window closes. Its entries stay in cache, unobserved, with
      // the invitations list from before the reinvitation below — which is what
      // makes this host's answer the only one anything is observing, and so the
      // one a route-scoped identity would credit to the other host's entry.
      act(() => {
        view.rerender(tree(false));
      });
      await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));

      // Removed and invited back. THIS host's entry answers, so the team stays
      // and Review is offered — the answer is real, for this entry.
      listed.current = [PERSONAL];
      invited.current = true;
      await act(() =>
        harness.queryClient.invalidateQueries({
          predicate: (query) => query.queryKey.includes("environment.list"),
        }),
      );
      expect(
        await screen.findByRole("button", { name: "Review" }),
      ).toBeTruthy();
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
        kind: "team",
        environmentId: "env-a",
      });

      // The other host's membership answer says the same thing, in the same
      // millisecond, so `listedAt` does not move. Its invitations entry still
      // holds the list from before the reinvitation.
      const otherList = harness.queryClient
        .getQueryCache()
        .getAll()
        .find(
          (query) =>
            query.queryKey.includes("environment.list") &&
            query.queryKey.includes(remote.getActiveHostId()),
        );
      expect(otherList).toBeDefined();
      if (otherList !== undefined) {
        act(() => {
          harness.queryClient.setQueryData(otherList.queryKey, {
            environments: [PERSONAL],
          });
        });
      }

      act(() => {
        teamHostBoundary.client = remote;
        view.rerender(tree(false));
      });

      // Nothing has answered on the entry now being read, so no removal may be
      // claimed off it — the answer held is about the entry this page has just
      // stopped reading.
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
        kind: "team",
        environmentId: "env-a",
      });
      expect(hoisted.toasts).toEqual([]);

      // And the right outcome once the new entry answers its own question: the
      // person is invited back, so Review is what this page offers on the host
      // now serving it.
      expect(
        await screen.findByRole("button", { name: "Review" }),
      ).toBeTruthy();
      expect(hoisted.toasts).toEqual([]);
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
        kind: "team",
        environmentId: "env-a",
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("claims no removal on a read that failed, and asks again no more than once", async () => {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    let asked = 0;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => ({ environments: [PERSONAL] }),
      "environment.invitations.list": () => {
        asked += 1;
        throw new Error("down");
      },
    });
    // The page renders again IN PLACE, which is the only re-render this case
    // can mean. Two cheaper-looking ways of doing it measure something else:
    // `rerender` with one shared element is skipped outright, because React
    // bails out of a child whose element is the same object, and the count then
    // holds without the page having rendered at all; `rerender` with a fresh
    // element UNMOUNTS and remounts the subtree, which tears down the read's
    // observer and builds a new one, and a new observer on a stale entry
    // refetches by design (`refetchOnMount`, zero `staleTime` here). That is a
    // request the page is right to make and not the one under test, so counting
    // it reads TanStack's contract as this page's regression.
    //
    // Re-rendering from inside the mounted tree keeps the observer and the
    // effect, so the count below is evidence about the effect's dependencies —
    // which is what "does not ask again" claims.
    render(
      <HeldValueHostRuntime>
        <MountedPage />
      </HeldValueHostRuntime>,
      { wrapper: harness.Wrapper },
    );

    // The list says the team is gone, but a read that failed is no answer
    // about an invitation: nothing is claimed, and the selection the person
    // made stays put.
    expect(
      await screen.findByText("These settings are no longer available."),
    ).toBeTruthy();
    expect(hoisted.toasts).toEqual([]);
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "team",
      environmentId: "env-a",
    });

    // Exactly two requests, and the count is named rather than compared with
    // itself: the page's own read on mount, and the one the gate asked for
    // when the list came back without the team. The harness does not retry.
    await waitFor(() => {
      expect(harness.queryClient.isFetching()).toBe(0);
      expect(asked).toBe(2);
    });

    // A failed reply ends the asking rather than starting another, so a page
    // left on this state does not turn into a stream of account-wide requests.
    // A render of the mounted page is the cheapest thing that would restart
    // one: every dependency of the ask effect has to be value-stable across it,
    // and an unstable `readInvitations` — the hazard, since it comes off the
    // query result — would cancel and ask again here.
    act(() => {
      renderMountedPageAgain();
    });
    await waitFor(() => {
      expect(harness.queryClient.isFetching()).toBe(0);
    });
    expect(asked).toBe(2);
  });

  // Personal has no Members page, and Members is the likeliest page to be on
  // while a membership changes. Moving the selection there without moving the
  // surface leaves the person on a panel that renders nothing, with the
  // sidebar row they were standing on gone from under them.
  //
  // The three arms below are the same removal on the three presentations
  // Settings has, and each needs a different move — none of which may activate
  // anything, because nobody pressed anything and `openSettings` would take a
  // split partner's focus and route for a membership change in the background.
  //
  // With the overlay up, the person is looking at Settings and the section is
  // swapped in place. With it down and a partner owning the route, Settings is
  // a tab that may be sitting in a pane nobody is looking at, so the tab is
  // only told where it is. With it down and Settings OWNING the route, being
  // told is not enough: the surface prefers the route wherever it owns it, so
  // the route is replaced — which activates nothing, a surface owning the
  // route being the focused route owner already.
  async function removalOnMembers(alongside: ReactNode): Promise<void> {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => ({ environments: [PERSONAL] }),
      "environment.invitations.list": () => ({ invitations: [] }),
    });
    render(
      <HeldValueHostRuntime>
        {alongside}
        <PersonalPageFrame section="members">
          <Probe />
        </PersonalPageFrame>
      </HeldValueHostRuntime>,
      { wrapper: harness.Wrapper },
    );
    await waitFor(
      () =>
        expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
          PERSONAL_PICK,
        ),
      { timeout: 5000 },
    );
  }

  it("swaps the section in place when the person is looking at Settings", async () => {
    surface.overlayActive = true;

    await removalOnMembers(null);

    expect(surface.setSection).toHaveBeenCalledWith("providers");
    expect(surface.openSettings).not.toHaveBeenCalled();
    expect(surface.remember).not.toHaveBeenCalled();
  });

  it("moves a background Settings tab without activating it", async () => {
    surface.overlayActive = false;
    // A split partner owns the route, which is the case `remember` is for.
    router.pathname = "/epics";

    await removalOnMembers(null);

    // Where Settings has to end up: on a page Personal offers.
    expect(surface.remember).toHaveBeenCalledWith("providers");
    // What must not happen to the pane the person IS working in. This is the
    // whole assertion: `openSettings` focuses the Settings tab and changes the
    // active route, so a split partner would lose both to a membership change
    // in the background.
    expect(surface.openSettings).not.toHaveBeenCalled();
    expect(surface.setSection).not.toHaveBeenCalled();
    // The partner's route is left exactly where it was.
    expect(router.pathname).toBe("/epics");
  });

  it("moves the Settings surface that owns the route, without activating anything", async () => {
    surface.overlayActive = false;
    // The person is reading Settings ▸ Environment ▸ Members with no overlay
    // up: Settings owns the route, so its remembered path is ignored.
    router.pathname = "/settings/members";

    await removalOnMembers(<SettingsSurface lastPath="/settings/members" />);

    // The real surface, resolving the real route. This is what `remember`
    // alone cannot do, and asserting the command could not tell apart.
    await waitFor(() =>
      expect(screen.getByTestId("settings-panel-probe").dataset.section).toBe(
        "providers",
      ),
    );
    expect(surface.replaceOwnedRoute).toHaveBeenCalledWith("providers");
    expect(surface.openSettings).not.toHaveBeenCalled();
    expect(surface.setSection).not.toHaveBeenCalled();
  });

  // A page the selection still offers is left where it is.
  it("leaves the surface alone when the selection it lands on offers the page", async () => {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => ({ environments: [PERSONAL] }),
      "environment.invitations.list": () => ({ invitations: [] }),
    });
    render(
      <HeldValueHostRuntime>
        <PersonalPageFrame section="secrets">
          <Probe />
        </PersonalPageFrame>
      </HeldValueHostRuntime>,
      { wrapper: harness.Wrapper },
    );

    // The removal settles through a cancel and a read of its own, so the wait
    // is generous: what this case is about is which page the person lands on,
    // never how quickly.
    await waitFor(
      () =>
        expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
          PERSONAL_PICK,
        ),
      { timeout: 5000 },
    );
    expect(surface.openSettings).not.toHaveBeenCalled();
    expect(surface.setSection).not.toHaveBeenCalled();
    expect(surface.remember).not.toHaveBeenCalled();
  });

  // `refetch`'s promise resolves with the OBSERVER's state, so a request
  // cancelled by anything else resolves it with the answer already in cache
  // and `isSuccess` true. Nothing about that is evidence the page's own
  // question was answered, and a removal claimed on it is claimed on the
  // answer from before the question.
  it("claims nothing when its own request is cancelled by another reader", async () => {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    // The page's own request is held open, so the cancellation below lands
    // while it is still out. The answer the cache already holds is the one
    // from before the question — the state the person is being asked about.
    const ownRead = Promise.withResolvers<{
      readonly invitations: EnvironmentInvitation[];
    }>();
    let asked = 0;
    const listed = { current: [PERSONAL, team("editor")] };
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => ({ environments: listed.current }),
      "environment.invitations.list": () => {
        asked += 1;
        if (asked === 2) return ownRead.promise;
        return { invitations: asked === 1 ? [] : [INVITATION] };
      },
    });
    render(
      <HeldValueHostRuntime>
        <PersonalPageFrame section="secrets">
          <Probe />
        </PersonalPageFrame>
      </HeldValueHostRuntime>,
      { wrapper: harness.Wrapper },
    );
    // The page has an answer in hand — so the next read has data to fall back
    // on, which is what makes a cancellation resolve as a success.
    await waitFor(() => expect(asked).toBe(1));

    listed.current = [PERSONAL];
    await act(async () => {
      await harness.queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes("environment.list"),
      });
    });
    await waitFor(() => expect(asked).toBe(2));

    // Anything else that cancels that read — another page asking its own
    // question, a sweep on sign-out — settles the page's `refetch` promise
    // with the answer the cache already holds, and `isSuccess` on it is true.
    // Nothing has answered the page's own question, so nothing may be claimed
    // on it: the selection stays, and the page goes on saying only that it
    // cannot be read.
    await act(async () => {
      await harness.queryClient.cancelQueries({
        predicate: (query) =>
          query.queryKey.includes("environment.invitations.list"),
      });
    });
    expect(hoisted.toasts).toEqual([]);
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "team",
      environmentId: "env-a",
    });
    expect(
      screen.getByText("These settings are no longer available."),
    ).toBeTruthy();

    // The next membership answer asks again, and that read answers: the
    // invitation was there all along.
    await act(async () => {
      await harness.queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes("environment.list"),
      });
    });
    expect(
      await screen.findByText(
        "You're invited to Acme. Accept to see and change its settings.",
      ),
    ).toBeTruthy();
    expect(hoisted.toasts).toEqual([]);
    ownRead.resolve({ invitations: [] });
  });

  it("acts on its own request, not on a read that was already in flight", async () => {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    // The read in flight took its snapshot while the person was still a
    // member, so it carries no invitation. It is held open across the removal.
    const inFlight = Promise.withResolvers<{
      readonly invitations: EnvironmentInvitation[];
    }>();
    let asked = 0;
    const listed = { current: [PERSONAL, team("editor")] };
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => ({ environments: listed.current }),
      "environment.invitations.list": () => {
        asked += 1;
        return asked === 1 ? inFlight.promise : { invitations: [INVITATION] };
      },
    });
    render(
      <HeldValueHostRuntime>
        <PersonalPageFrame section="secrets">
          <Probe />
        </PersonalPageFrame>
      </HeldValueHostRuntime>,
      { wrapper: harness.Wrapper },
    );
    await waitFor(() => expect(asked).toBe(1));

    // Removed and invited back while that first read is still out.
    listed.current = [PERSONAL];
    await act(async () => {
      await harness.queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes("environment.list"),
      });
    });

    // The page asks its own question — the held read is cancelled rather than
    // joined — so the invitation that existed all along is found.
    expect(
      await screen.findByText(
        "You're invited to Acme. Accept to see and change its settings.",
      ),
    ).toBeTruthy();
    expect(asked).toBe(2);

    // The held reply, released late, cannot take that back: it answered a
    // question about a membership the person no longer has.
    await act(async () => {
      inFlight.resolve({ invitations: [] });
      await inFlight.promise;
    });
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(
      screen.getByText(
        "You're invited to Acme. Accept to see and change its settings.",
      ),
    ).toBeTruthy();
    expect(hoisted.toasts).toEqual([]);
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "team",
      environmentId: "env-a",
    });
  });

  // The evidence is a COUNT, and the reason is this case. `dataUpdatedAt` is
  // `Date.now()` stamped on every success, so an ask and its reply inside one
  // millisecond are indistinguishable on that clock — which a warm answer is.
  // A `>` comparison then reads the reply as no reply, and the removal is
  // never confirmed: no toast, no move, and the person left on a team no page
  // can read with the Accept never offered. Nothing recovers it either, since
  // a page that cannot be read writes nothing, so there is no next membership
  // answer to ask again on.
  //
  // The clock is frozen, which makes every stamp equal and the tie certain
  // rather than likely. Timers are left real; only the stamp source is held.
  it("confirms a reply that shares its millisecond with the question", async () => {
    const frozen = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(frozen);
    try {
      negotiateMethods({
        "environment.invitations.list": V10,
        "environment.invitations.accept": V10,
      });
      useSettingsEnvironmentPickStore.setState({
        pick: { kind: "team", environmentId: "env-a" },
      });
      let asked = 0;
      const listed = { current: [PERSONAL, team("editor")] };
      const harness = mountTeamPage(poolSource("editor"), {
        "environment.list": () => ({ environments: listed.current }),
        "environment.invitations.list": () => {
          asked += 1;
          return { invitations: [] };
        },
      });
      render(
        <HeldValueHostRuntime>
          <PersonalPageFrame section="secrets">
            <Probe />
          </PersonalPageFrame>
        </HeldValueHostRuntime>,
        { wrapper: harness.Wrapper },
      );
      await waitFor(() => expect(asked).toBe(1));

      listed.current = [PERSONAL];
      await act(async () => {
        await harness.queryClient.invalidateQueries({
          predicate: (query) => query.queryKey.includes("environment.list"),
        });
      });

      // Both answers carry the same stamp. The question was still answered,
      // and the removal is said once and acted on.
      await waitFor(
        () =>
          expect(hoisted.toasts).toEqual([
            {
              message: "You're no longer in Acme.",
              options: { id: "environment-left:env-a" },
            },
          ]),
        { timeout: 5000 },
      );
      expect(useSettingsEnvironmentPickStore.getState().pick).toEqual(
        PERSONAL_PICK,
      );
      // No request count here, unlike the cases above: a held clock makes
      // `timeUntilStale` zero, so every read is perpetually stale and the
      // harness refetches more than the design asks for. That is the frozen
      // clock's arithmetic, not the page's behaviour, and the counts are
      // asserted where they mean something — against a running clock.
    } finally {
      clock.mockRestore();
    }
  });

  it("asks again on the membership answer after a failed read, and keeps the invited team", async () => {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    const invitationsFail = { current: true };
    let asked = 0;
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => ({ environments: [PERSONAL] }),
      "environment.invitations.list": () => {
        asked += 1;
        if (invitationsFail.current) throw new Error("down");
        return { invitations: [INVITATION] };
      },
    });
    render(
      <HeldValueHostRuntime>
        <PersonalPageFrame section="secrets">
          <Probe />
        </PersonalPageFrame>
      </HeldValueHostRuntime>,
      { wrapper: harness.Wrapper },
    );
    expect(
      await screen.findByText("These settings are no longer available."),
    ).toBeTruthy();

    // The ask raised for the first membership answer has to have FAILED
    // before the next one arrives, or this case never exercises recovery from
    // `unanswered` — the standing line above is on screen while that request
    // is still out. Two requests: the page's read on mount, and that ask.
    await waitFor(() => {
      expect(asked).toBe(2);
      expect(harness.queryClient.isFetching()).toBe(0);
    });

    // The next membership answer is a new question, so the read is asked
    // again — this time it answers, and names the invitation.
    invitationsFail.current = false;
    await act(async () => {
      await harness.queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes("environment.list"),
      });
    });

    expect(
      await screen.findByText(
        "You're invited to Acme. Accept to see and change its settings.",
      ),
    ).toBeTruthy();
    // Exactly one more request than the failed round: a membership answer
    // asks once, whether or not the one before it got an answer.
    expect(asked).toBe(3);
    expect(hoisted.toasts).toEqual([]);
    expect(useSettingsEnvironmentPickStore.getState().pick).toEqual({
      kind: "team",
      environmentId: "env-a",
    });
  });

  it("promises a viewer's invitation only what accepting it gives", async () => {
    mountBoundary({
      environments: () => [PERSONAL],
      invitations: [{ ...INVITATION, role: "viewer" }],
    });

    expect(
      await screen.findByText(
        "You're invited to Acme. Accept to see its settings.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/and change its settings/)).toBeNull();
  });

  it("keeps the failed read's own line and Retry, which an answer has not refuted", async () => {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => {
        throw new Error("down");
      },
      "environment.invitations.list": () => ({ invitations: [] }),
    });
    render(
      <ConfigurationSourceBoundary
        section={null}
        target={{ kind: "team", environmentId: "env-a" }}
      >
        <Probe />
      </ConfigurationSourceBoundary>,
      { wrapper: harness.Wrapper },
    );

    expect(
      await screen.findByText("Couldn't read these settings."),
    ).toBeTruthy();
    expect(screen.queryByText(/You're no longer in/)).toBeNull();
  });
});

// NEW-154-6: the trigger has to name an invited team, and the two halves of
// that name come from different reads — the membership label, and the
// invitation where no membership carries one. They are separate hooks so the
// account-wide invitations read is mounted only where the second half is
// actually needed; the picker's trigger is the one place, and
// `environment-picker.test.tsx` holds it to asking for neither more nor less.
describe("the name a picked configuration is called", () => {
  function Label(): ReactNode {
    const listed = usePickedTeamLabel("env-a");
    const invited = useInvitedTeamName("env-a");
    return (
      <span data-testid="label">
        {`${listed ?? "none"}/${invited ?? "none"}`}
      </span>
    );
  }

  /** Mounts the label and waits for both reads, so "none" is an answer. */
  async function mountLabel(options: {
    readonly environments: readonly EnvironmentDescriptorV11[];
    readonly invitations: readonly EnvironmentInvitation[];
  }): Promise<void> {
    negotiateMethods({
      "environment.invitations.list": V10,
      "environment.invitations.accept": V10,
    });
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => ({ environments: [...options.environments] }),
      "environment.invitations.list": () => ({
        invitations: [...options.invitations],
      }),
    });
    render(<Label />, { wrapper: harness.Wrapper });
    await waitFor(() => {
      expect(harness.queryClient.isFetching()).toBe(0);
    });
  }

  it("names a team the list carries by its label, and asks no invitation", async () => {
    await mountLabel({
      environments: [PERSONAL, team("editor")],
      invitations: [],
    });
    expect(await screen.findByText("Acme/none")).toBeTruthy();
  });

  it("names a team that has only invited the person by the invitation", async () => {
    await mountLabel({
      environments: [PERSONAL],
      invitations: [INVITATION],
    });
    expect(await screen.findByText("none/Acme")).toBeTruthy();
  });

  it("names nothing for an id neither the list nor an invitation knows", async () => {
    await mountLabel({ environments: [PERSONAL], invitations: [] });
    expect(await screen.findByText("none/none")).toBeTruthy();
  });
});

describe("the viewer's standing line", () => {
  function mountRole(
    effectiveRole: EnvironmentDescriptorV11["effectiveRole"],
  ): void {
    const harness = mountTeamPage(poolSource(effectiveRole), {
      "environment.list": () => ({
        environments: [PERSONAL, team(effectiveRole)],
      }),
    });
    render(
      <ConfigurationSourceBoundary
        section={null}
        target={{ kind: "team", environmentId: "env-a" }}
      >
        <Probe />
      </ConfigurationSourceBoundary>,
      { wrapper: harness.Wrapper },
    );
  }

  it("stands above a viewer's page, once", async () => {
    mountRole("viewer");
    await screen.findByTestId("probe");
    expect(
      screen.getAllByText("You can see Acme's settings but not change them."),
    ).toHaveLength(1);
  });

  it.each(["admin", "editor"] as const)(
    "says nothing to %s, who can change the settings",
    async (role) => {
      mountRole(role);
      await screen.findByTestId("probe");
      expect(screen.queryByText(/but not change them/)).toBeNull();
    },
  );

  it("says nothing on Personal, which its owner changes", async () => {
    const harness = mountTeamPage(poolSource("owner"), {
      "environment.list": () => ({ environments: [PERSONAL] }),
    });
    render(
      <ConfigurationSourceBoundary target={{ kind: "personal" }} section={null}>
        <Probe />
      </ConfigurationSourceBoundary>,
      { wrapper: harness.Wrapper },
    );
    await screen.findByTestId("probe");
    expect(screen.queryByText(/but not change them/)).toBeNull();
  });
});
