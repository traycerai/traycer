import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FallbackPolicy } from "@traycer/protocol/host/fallback-policy";
import type { EnvironmentHostRecordV11 } from "@traycer/protocol/host/environment/contracts";
import { TeamModelRouting } from "@/components/settings/environment/team-model-routing";
import {
  configurationItem,
  mountTeamPage,
  personalPoolSource,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "./team-configuration-test-support";

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
// Resolving a client for the picked viewing host needs the app's host
// directory; the eligibility logic above it stays real.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
});

function policyOf(enabled: boolean): FallbackPolicy {
  return {
    enabled,
    ladder: ["profile", "tier", "wait", "notify"],
    graceWindowSeconds: 15,
    maxWaitMinutes: 360,
    returnToPreferred: "prompt",
    tierGroups: [
      {
        id: "fast",
        candidates: [
          {
            harnessId: "claude",
            modelFamily: "sonnet*",
            reasoningEffort: null,
          },
        ],
      },
    ],
    defaultTierGroupId: "fast",
  };
}

const routing = (enabled: boolean, revision: number) =>
  configurationItem({
    kind: "fallback_policy",
    key: "fallback",
    value: { document: policyOf(enabled) },
    revision,
  });

const host: EnvironmentHostRecordV11 = {
  hostId: "host-a",
  hostLabel: "Mac mini",
  hostPlatform: "darwin",
  enrolledByUserId: "u-1",
  kind: "personal",
  boundAt: 1,
  reachable: true,
  lastReportedAt: 1,
  applied: [],
};

const environmentList = {
  environments: [
    {
      environmentId: "env-a",
      ownerKind: "organization" as const,
      ownerId: "team-a",
      roomId: "room-a",
      label: "Acme",
      effectiveRole: "editor" as const,
      kind: "team" as const,
      hostCount: 1,
      providerHandle: "handle-a",
    },
  ],
};

const NATIVE_ROUTING_WRITES = [
  "providers.fallbackPolicy.set",
  "providers.fallbackPolicy.reset",
  "providers.fallbackPolicy.restoreDefaultTiers",
] as const;

describe("TeamModelRouting", () => {
  it("reads the team's routing from the pool's fallback_policy item", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.configuration.items": () => ({ items: [routing(true, 9)] }),
    });
    render(<TeamModelRouting />, { wrapper: harness.Wrapper });

    expect(await screen.findByText("Route automatically: On")).toBeTruthy();
    expect(harness.paramsOf("environment.configuration.items")[0]).toEqual({
      environmentId: "env-a",
    });
    expect(harness.paramsOf("providers.fallbackPolicy.get")).toHaveLength(0);
  });

  it.each([
    [
      "a team",
      poolSource("viewer"),
      "How agents recover when an account or model cannot continue.",
    ],
    [
      "Personal",
      personalPoolSource(),
      "Applies to your agents on every computer and sandbox running Personal.",
    ],
  ])("describes routing for %s", async (_name, source, subtitle) => {
    const harness = mountTeamPage(source, {
      "environment.configuration.items": () => ({ items: [routing(true, 9)] }),
      "environment.list": () => ({
        environments: [
          {
            environmentId: "env-a",
            ownerKind: "organization" as const,
            ownerId: "team-a",
            roomId: "room-a",
            label: "Acme",
            effectiveRole: "admin" as const,
            kind: "team" as const,
            hostCount: 1,
            providerHandle: "handle-a",
          },
          {
            environmentId: "env-personal",
            ownerKind: "user" as const,
            ownerId: "user-me",
            roomId: "room-personal",
            label: "Me",
            effectiveRole: "owner" as const,
            kind: "personal" as const,
            hostCount: 1,
            providerHandle: null,
          },
        ],
      }),
    });
    render(<TeamModelRouting />, { wrapper: harness.Wrapper });

    expect(await screen.findByText(subtitle)).toBeTruthy();
  });

  it("gives a viewer the policy with no routing mutation verbs", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.configuration.items": () => ({ items: [routing(true, 9)] }),
    });
    render(<TeamModelRouting />, { wrapper: harness.Wrapper });

    await screen.findByText("Route automatically: On");
    expect(screen.queryByRole("switch")).toBeNull();
    for (const verb of [
      "Save",
      "Reset to default",
      "Restore the default tiers",
    ]) {
      expect(screen.queryByRole("button", { name: verb })).toBeNull();
    }
  });

  it("saves an edit against the displayed revision, and a conflict rereads the current policy beside the changed-by line", async () => {
    let current = routing(true, 9);
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [current] }),
      "environment.host.list": () => ({ hosts: [host] }),
      "environment.configuration.items.put": () => {
        current = routing(false, 10);
        return {
          outcome: "conflict",
          current: { revision: 10, changedBy: "Grace", changedAt: 2 },
        };
      },
    });
    render(<TeamModelRouting />, { wrapper: harness.Wrapper });

    const toggle = await screen.findByRole("switch", {
      name: "Route automatically",
    });
    expect(toggle).toHaveProperty("ariaChecked", "true");
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "fallback_policy",
        key: "fallback",
        os: null,
        value: { document: policyOf(false) },
        revision: 9,
      },
    ]);
    expect(
      await screen.findByText("Changed by Grace a moment ago"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Route automatically" }),
      ).toHaveProperty("ariaChecked", "false");
    });
    for (const method of NATIVE_ROUTING_WRITES) {
      expect(harness.paramsOf(method)).toHaveLength(0);
    }
  });

  it.each(["Reset to default", "Restore the default tiers"] as const)(
    "%s deletes the fallback item at the displayed revision, never a native reset",
    async (verb) => {
      const harness = mountTeamPage(poolSource("editor"), {
        "environment.configuration.items": () => ({
          items: [routing(true, 9)],
        }),
        "environment.host.list": () => ({ hosts: [host] }),
        "environment.configuration.items.delete": () => ({
          outcome: "saved",
          revision: null,
        }),
      });
      render(<TeamModelRouting />, { wrapper: harness.Wrapper });

      await userEvent.click(await screen.findByRole("button", { name: verb }));
      if (verb === "Restore the default tiers") {
        // Over a non-empty list the restore sits behind a confirm.
        const dialog = await screen.findByRole("dialog");
        expect(
          within(dialog).getByText(
            "Restore this team's model routing defaults?",
          ),
        ).toBeTruthy();
        expect(
          within(dialog).getByText(
            "Removes the team's model routing settings. Each host uses its own defaults.",
          ),
        ).toBeTruthy();
        expect(within(dialog).queryByText(/flagship/i)).toBeNull();
        await userEvent.click(
          within(dialog).getByRole("button", { name: "Restore" }),
        );
      }

      expect(
        harness.paramsOf("environment.configuration.items.delete"),
      ).toEqual([
        {
          environmentId: "env-a",
          kind: "fallback_policy",
          key: "fallback",
          os: null,
          revision: 9,
        },
      ]);
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(0);
      for (const method of NATIVE_ROUTING_WRITES) {
        expect(harness.paramsOf(method)).toHaveLength(0);
      }
    },
  );

  it("seeds a team with no item from the eligible host's own tiers and creates it with a null revision", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [] }),
      "environment.host.list": () => ({ hosts: [host] }),
      "providers.fallbackPolicy.get": () => ({
        policy: policyOf(false),
        storedPolicyUnreadable: false,
        inFlightCount: 0,
      }),
      "environment.configuration.items.put": () => ({
        outcome: "saved",
        revision: 1,
      }),
    });
    render(<TeamModelRouting />, { wrapper: harness.Wrapper });

    const toggle = await screen.findByRole("switch", {
      name: "Route automatically",
    });
    expect(
      screen.getByText("Each host uses its default model tiers."),
    ).toBeTruthy();
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(harness.paramsOf("providers.fallbackPolicy.get")).toEqual([{}]);
    expect(harness.paramsOf("environment.configuration.items.put")).toEqual([
      {
        environmentId: "env-a",
        kind: "fallback_policy",
        key: "fallback",
        os: null,
        value: { document: policyOf(true) },
        revision: null,
      },
    ]);
  });

  it("offers no write controls, and invents no empty tiers, when no host can seed them", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.configuration.items": () => ({ items: [] }),
      "environment.host.list": () => ({ hosts: [] }),
      "environment.list": () => environmentList,
    });
    render(<TeamModelRouting />, { wrapper: harness.Wrapper });

    const line = await screen.findByText(/Model tiers need a host running/);
    await waitFor(() => {
      expect(line.closest("p")?.textContent).toBe(
        "Model tiers need a host running Acme. Pick one.",
      );
    });
    expect(screen.queryByRole("switch")).toBeNull();
    for (const verb of ["Save", "Reset to default"]) {
      expect(screen.queryByRole("button", { name: verb })).toBeNull();
    }
    expect(harness.paramsOf("providers.fallbackPolicy.get")).toHaveLength(0);
    expect(
      harness.paramsOf("environment.configuration.items.put"),
    ).toHaveLength(0);
    expect(
      within(document.body).getByRole("button", { name: "Pick one." }),
    ).toBeTruthy();
  });
});
