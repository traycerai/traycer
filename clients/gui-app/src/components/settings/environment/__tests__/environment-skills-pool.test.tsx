import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { EnvironmentSkill } from "@traycer/protocol/host/environment/configuration-contracts";
import { EnvironmentSkillsPage } from "@/components/settings/environment/environment-skills";
import type { HostRpcRegistry } from "@/lib/host";
import {
  negotiateMethodsOn,
  teamEnvironments,
} from "./mcp-skills-test-support";
import {
  hostIdsOf,
  mountTeamPageOnPoolBuild,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  teamHostBoundary,
} from "./team-configuration-test-support";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => requireTeamHostClient(),
  useHostBinding: () => ({
    hostId: "host-local",
    hostClient: requireTeamHostClient(),
  }),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));

// The tier plan is frozen per process from the build; this file's build has a pool.
beforeAll(() => {
  settleProcessHostRpcTierPlan(poolEntry);
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
});

const LIST = { major: 1, minor: 0 };

const REVIEW: EnvironmentSkill = {
  name: "review",
  description: "Review a change.",
  origin: "room",
  edited: false,
  offFor: [],
};

function unsupported(method: string): HostRpcError {
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: `This host does not support '${method}'.`,
    requestId: "req-unsupported",
    method,
    fatalDetails: {
      code: "E_HOST_UNSUPPORTED",
      reason: `This host does not support '${method}'.`,
      incompatibleMethods: null,
      upgradeGuidance: { clientShouldUpgrade: false, hostShouldUpgrade: true },
    },
  });
}

/** A team with no host running it: the host list is empty. */
function handlersWithNoHost(
  list: MockHandlerMap<HostRpcRegistry>["environment.configuration.skills.list"],
): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.configuration.skills.list": list,
    "environment.host.list": () => ({ hosts: [] }),
    "environment.list": () => teamEnvironments,
  };
}

describe("The Skills page on a build with a server pool and no host running the team", () => {
  it("lists the team's skills from the pool, with no host pick and no Preview", async () => {
    negotiateMethodsOn(POOL_HOST_ID, {
      "environment.configuration.skills.list": LIST,
    });
    const harness = mountTeamPageOnPoolBuild(
      poolSource("editor"),
      handlersWithNoHost(() => ({
        outcome: "listed" as const,
        revision: "rev-1",
        skills: [REVIEW],
      })),
    );
    useSelectionAuthorityStore.getState().reset();
    teamHostBoundary.client =
      requireTeamHostClient().createRequesterForHostId(null);
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBeNull();
    expect(requireTeamHostClient().getActiveHostId()).toBeNull();
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("review")).toBeTruthy();
    expect(screen.queryByText(/Skills need a host/)).toBeNull();
    expect(screen.getByRole("combobox").textContent).toContain("Pick a host");
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    // The pool did not advertise the writes: an older pool keeps the page read-only.
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByLabelText("Add a skill")).toBeNull();
    expect(
      harness.messenger.calls
        .filter(
          (call) => call.method === "environment.configuration.skills.list",
        )
        .map((call) => call.authority.endpoint.hostId),
    ).toEqual([POOL_HOST_ID]);
  });

  it("removes a skill through the pool with no host, once the pool advertises the removal", async () => {
    negotiateMethodsOn(POOL_HOST_ID, {
      "environment.configuration.skills.list": LIST,
      "environment.configuration.skills.remove": LIST,
    });
    const harness = mountTeamPageOnPoolBuild(poolSource("editor"), {
      ...handlersWithNoHost(() => ({
        outcome: "listed" as const,
        revision: "rev-1",
        skills: [REVIEW],
      })),
      "environment.configuration.skills.remove": () => ({
        outcome: "removed" as const,
        reason: null,
      }),
    });
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Remove" }),
    );
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Remove skill",
      }),
    );

    await waitFor(() => {
      expect(
        hostIdsOf(harness, "environment.configuration.skills.remove"),
      ).toEqual([POOL_HOST_ID]);
    });
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
  });

  it("says the read failed, with Retry, when the pool's manifest lacks the list", async () => {
    negotiateMethodsOn(POOL_HOST_ID, { "epic.listChats": LIST });
    const harness = mountTeamPageOnPoolBuild(
      poolSource("editor"),
      handlersWithNoHost(() => ({
        outcome: "listed" as const,
        revision: "rev-1",
        skills: [REVIEW],
      })),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText("Couldn't read Acme's skills."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(/Skills need a host/)).toBeNull();
    expect(screen.queryByRole("button", { name: /pick/i })).toBeNull();
  });

  it("says the read failed, with Retry, when the pool answers E_HOST_UNSUPPORTED, and Retry reads again", async () => {
    negotiateMethodsOn(POOL_HOST_ID, {
      "environment.configuration.skills.list": LIST,
    });
    let old = true;
    const harness = mountTeamPageOnPoolBuild(
      poolSource("editor"),
      handlersWithNoHost(() => {
        if (old) throw unsupported("environment.configuration.skills.list");
        return {
          outcome: "listed" as const,
          revision: "rev-1",
          skills: [REVIEW],
        };
      }),
    );
    render(<EnvironmentSkillsPage />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText("Couldn't read Acme's skills."),
    ).toBeTruthy();
    expect(screen.queryByText(/Skills need a host/)).toBeNull();
    old = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.getByText("review")).toBeTruthy();
    });
  });
});
