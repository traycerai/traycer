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

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentSecret,
  EnvironmentSecretRemoval,
  EnvironmentSecretsDestroyResponseV11,
  SecretVersion,
} from "@traycer/protocol/host/environment-schemas";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const AT = Date.UTC(2026, 9, 20, 9, 30);

function secretFixture(): EnvironmentSecret {
  return {
    secretId: "sec-1",
    name: "STRIPE_KEY",
    kind: "api_key",
    protocol: null,
    destinations: [],
    mode: "brokered",
    state: "live",
    currentVersionId: "ver-2",
    revoked: false,
    updatedAt: AT,
  };
}

function versionsFixture(): SecretVersion[] {
  return [
    {
      versionId: "ver-2",
      ordinal: 2,
      createdAt: AT,
      supersededAt: null,
      destroyedAt: null,
      current: true,
      rotationState: null,
    },
    {
      versionId: "ver-1",
      ordinal: 1,
      createdAt: AT - 1_000,
      supersededAt: AT,
      destroyedAt: null,
      current: false,
      rotationState: null,
    },
  ];
}

function removal(
  outcome: EnvironmentSecretRemoval["outcome"],
): EnvironmentSecretRemoval {
  return {
    outcome,
    revokedAt: AT,
    destroyedAt: outcome === "destroyed" ? AT : null,
    targets: [
      {
        target: "host",
        hostId: "host-a",
        hostName: "dev-box",
        state: outcome === "destroyed" ? "confirmed" : "requested",
        at: AT,
      },
    ],
  };
}

interface Host {
  removal: EnvironmentSecretRemoval | null;
  destroyAnswer: EnvironmentSecretsDestroyResponseV11;
  secrets: EnvironmentSecret[];
}

function mountRow(host: Host): TeamPageHarness {
  return mountRowAs(host, "editor");
}

function mountRowAs(host: Host, role: "viewer" | "editor"): TeamPageHarness {
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "team", environmentId: "env-a" },
  });
  const harness = mountTeamPage(poolSource(role), {
    "environment.list": () => ({ environments: [] }),
    "environment.secrets.list": () => ({
      secrets: host.secrets,
      removed: [],
    }),
    "environment.secrets.versions": () => ({
      versions: versionsFixture(),
      removal: host.removal,
    }),
    "environment.secrets.destroy": () => host.destroyAnswer,
    "environment.secrets.rotation": () => ({
      rotation: null,
      lastVerify: null,
    }),
  });
  const client = requireTeamHostClient();
  render(
    <SecretsPage
      client={client}
      hostId={client.getActiveHostId()}
      hostName={(hostId) => hostId}
    />,
    { wrapper: harness.Wrapper },
  );
  return harness;
}

function freshHost(overrides: Partial<Host>): Host {
  return {
    removal: null,
    destroyAnswer: { outcome: "revoked" },
    secrets: [secretFixture()],
    ...overrides,
  };
}

function destroyCalls(harness: TeamPageHarness) {
  return harness.messenger.calls.filter(
    (call) => call.method === "environment.secrets.destroy",
  );
}

beforeEach(() => {
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

describe("Remove on a team secret", () => {
  it("destroys the current version in the pool environment, then keeps the row as Access revoked", async () => {
    const host = freshHost({});
    const harness = mountRow(host);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("secret-row-remove"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    await waitFor(() => {
      expect(dialog.textContent).toContain("Current version 2.");
    });
    // The host answers revoked and the next versions read carries the removal.
    host.removal = removal("revoked");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(destroyCalls(harness)).toHaveLength(1);
    });
    const [call] = destroyCalls(harness);
    expect(call.params).toEqual({
      secretId: "sec-1",
      versionId: "ver-2",
      environmentId: "env-a",
    });
    expect(call.requiredHostMethodVersion).toEqual({
      method: "environment.secrets.destroy",
      version: { major: 1, minor: 1 },
    });
    const status = await screen.findByTestId("secret-removal-status");
    expect(status.textContent).toContain("Access revoked");
    expect(screen.getByTestId("secret-row")).toBeTruthy();
    expect(screen.queryByTestId("secret-row-remove")).toBeNull();
    expect(screen.queryByTestId("secret-row-verify")).toBeNull();
  });

  it("shows a refusal and keeps the confirm open", async () => {
    const host = freshHost({
      destroyAnswer: { outcome: "refused", code: "version_current" },
    });
    mountRow(host);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("secret-row-remove"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    await waitFor(() => {
      expect(dialog.textContent).toContain("Current version 2.");
    });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect((await within(dialog).findByRole("alert")).textContent).not.toBe("");
    expect(screen.queryByTestId("secret-removal-status")).toBeNull();
  });
});

describe("a secret with a removal", () => {
  it.each([
    ["revoked", "Access revoked"],
    ["cleanup_requested", "Cleanup requested"],
  ] as const)(
    "keeps a %s row, offers Retry, and retries the same current version",
    async (outcome, label) => {
      const host = freshHost({ removal: removal(outcome) });
      const harness = mountRow(host);
      const user = userEvent.setup();

      const status = await screen.findByTestId("secret-removal-status");
      expect(status.textContent).toContain(label);
      expect(screen.getByTestId("secret-row")).toBeTruthy();

      host.removal = removal("destroyed");
      await user.click(within(status).getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(destroyCalls(harness)).toHaveLength(1);
      });
      const [call] = destroyCalls(harness);
      expect(call.params).toEqual({
        secretId: "sec-1",
        versionId: "ver-2",
        environmentId: "env-a",
      });
      expect(call.requiredHostMethodVersion).toEqual({
        method: "environment.secrets.destroy",
        version: { major: 1, minor: 1 },
      });
      // Destroyed is the one outcome that takes the row out of the list.
      await waitFor(() => {
        expect(screen.queryByTestId("secret-row")).toBeNull();
      });
    },
  );

  it("removes the row once the removal is destroyed, though the list still names it", async () => {
    const harness = mountRow(freshHost({ removal: removal("destroyed") }));

    // The row first draws from the list, then the versions read removes it.
    await waitFor(() => {
      expect(harness.paramsOf("environment.secrets.versions")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(harness.queryClient.isFetching()).toBe(0);
    });
    expect(harness.paramsOf("environment.secrets.list")).toHaveLength(1);
    expect(screen.queryByTestId("secret-row")).toBeNull();
    expect(screen.queryByText("STRIPE_KEY")).toBeNull();
  });
});

describe("the Versions list", () => {
  it("never offers Destroy on the current version, only on a replaced one", async () => {
    const host = freshHost({
      destroyAnswer: { outcome: "destroyed", destroyedAt: AT },
    });
    const harness = mountRow(host);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("secret-row-versions"));
    const rows = await screen.findAllByTestId("secret-version");

    const [current, replaced] = rows;
    expect(current.getAttribute("data-version-state")).toBe("current");
    expect(within(current).queryByTestId("secret-version-destroy")).toBeNull();
    await user.click(within(replaced).getByTestId("secret-version-destroy"));
    await user.click(
      within(await screen.findByTestId("confirm-destructive-dialog")).getByRole(
        "button",
        { name: "Destroy" },
      ),
    );

    await waitFor(() => {
      expect(destroyCalls(harness)).toHaveLength(1);
    });
    expect(destroyCalls(harness)[0]?.params).toEqual({
      secretId: "sec-1",
      versionId: "ver-1",
      environmentId: "env-a",
    });
  });

  it("does not poll versions while a removal is pending", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const harness = mountRow(
        freshHost({ removal: removal("cleanup_requested") }),
      );
      await screen.findByTestId("secret-removal-status");
      const reads = (): number =>
        harness.paramsOf("environment.secrets.versions").length;
      const before = reads();

      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);

      expect(reads()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a viewer", () => {
  it("reads the names and gets Details, with no row, no write verb and no write call", async () => {
    const host = freshHost({});
    const harness = mountRowAs(host, "viewer");

    expect(await screen.findByText("STRIPE_KEY")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
    expect(screen.queryByTestId("secret-row")).toBeNull();
    for (const verb of ["Remove", "Retry", "Verify", "Replace value"]) {
      expect(screen.queryByRole("button", { name: verb })).toBeNull();
    }
    for (const method of [
      "environment.secrets.destroy",
      "environment.secrets.undo",
      "environment.secrets.replaceValue",
      "environment.secrets.verify",
    ]) {
      expect(harness.paramsOf(method)).toEqual([]);
    }
  });
});
