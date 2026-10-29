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

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentDescriptorV11,
  EnvironmentInvitation,
} from "@traycer/protocol/host/environment/contracts";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { ConfigurationSourceBoundary } from "@/components/settings/environment/configuration-source-boundary";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { usePickedTeamLabel } from "@/components/settings/environment/team-pick-label";
import { HeldValueHostRuntime } from "@/components/settings/personal/__tests__/held-value-host-runtime";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { negotiateMethods } from "./mcp-skills-test-support";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

/**
 * NEW-154-6: a page whose team the environment list no longer carries. The
 * person was removed, or removed and invited back; either way the page used to
 * read "These settings are no longer available." with a blank trigger.
 * NEW-154-24: a viewer's one standing line, which the boundary gives every
 * cloud-read page at once.
 */

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
      target={{ kind: "team", environmentId: "env-a" }}
    >
      <Probe />
    </ConfigurationSourceBoundary>,
    { wrapper: harness.Wrapper },
  );
  return {
    rerenderList: () => harness.queryClient.invalidateQueries(),
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
  return { rerenderList: () => harness.queryClient.invalidateQueries() };
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
    render(
      <HeldValueHostRuntime>
        <PersonalPageFrame section="secrets">
          <Probe />
        </PersonalPageFrame>
      </HeldValueHostRuntime>,
      { wrapper: harness.Wrapper },
    );

    // Every request has finished failing, so what follows is the settled
    // state and not a moment inside it.
    await waitFor(() => {
      expect(asked).toBeGreaterThan(0);
      expect(harness.queryClient.isFetching()).toBe(0);
    });
    const askedOnce = asked;

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

    // A failed reply ends the asking rather than starting another, so the
    // page holds without turning into a stream of account-wide requests.
    await waitFor(() => {
      expect(harness.queryClient.isFetching()).toBe(0);
    });
    expect(asked).toBe(askedOnce);
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
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.list": () => ({ environments: [PERSONAL] }),
      "environment.invitations.list": () => {
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

    // The next membership answer is a new question, so the read is asked
    // again — this time it answers, and names the invitation.
    invitationsFail.current = false;
    await harness.queryClient.invalidateQueries({
      predicate: (query) => query.queryKey.includes("environment.list"),
    });

    expect(
      await screen.findByText(
        "You're invited to Acme. Accept to see and change its settings.",
      ),
    ).toBeTruthy();
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

// NEW-154-6: the trigger reads this label, so an invited team must have one.
describe("the name a picked configuration is called", () => {
  function Label(): ReactNode {
    return (
      <span data-testid="label">{usePickedTeamLabel("env-a") ?? "none"}</span>
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

  it("names a team the list carries by its label", async () => {
    await mountLabel({
      environments: [PERSONAL, team("editor")],
      invitations: [],
    });
    expect(await screen.findByText("Acme")).toBeTruthy();
  });

  it("names a team that has only invited the person by the invitation", async () => {
    await mountLabel({
      environments: [PERSONAL],
      invitations: [INVITATION],
    });
    expect(await screen.findByText("Acme")).toBeTruthy();
  });

  it("names nothing for an id neither the list nor an invitation knows", async () => {
    await mountLabel({ environments: [PERSONAL], invitations: [] });
    expect(await screen.findByText("none")).toBeTruthy();
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
      <ConfigurationSourceBoundary target={{ kind: "personal" }}>
        <Probe />
      </ConfigurationSourceBoundary>,
      { wrapper: harness.Wrapper },
    );
    await screen.findByTestId("probe");
    expect(screen.queryByText(/but not change them/)).toBeNull();
  });
});
