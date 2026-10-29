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

// The computers holding a copy are covered by `secret-remove-preview-computers`;
// here Remove's preview is read with none.
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => ({
      hosts: [],
      state: "ready",
      collisions: [],
      retry: () => undefined,
      reread: () => undefined,
    }),
  }),
);

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentSecretV12,
  EnvironmentSecretRemovalV12,
  EnvironmentSecretsDestroyResponseV11,
  SecretVersion,
} from "@traycer/protocol/host/environment-schemas";
import {
  mountTeamPage,
  mountTeamPageNegotiating,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { SECRETS_EMPTY_TEXT } from "@/lib/sandboxes/secrets-page-copy";

const AT = Date.UTC(2026, 9, 20, 9, 30);

/** The day and month a version is dated by, as the page formats them. */
function dayMonth(at: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(at);
}

function secretFixture(): EnvironmentSecretV12 {
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
    variables: [],
    providerVariables: [],
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
  outcome: EnvironmentSecretRemovalV12["outcome"],
): EnvironmentSecretRemovalV12 {
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
        failedAt: null,
      },
    ],
  };
}

interface Host {
  removal: EnvironmentSecretRemovalV12 | null;
  /** The host finishes the removal when it answers a destroy. */
  finishesOnDestroy: boolean;
  destroyAnswer: EnvironmentSecretsDestroyResponseV11;
  secrets: EnvironmentSecretV12[];
  /** The list's `removed`: secrets revoked within the last 30 days. */
  removed: {
    id: string;
    name: string;
    removal: EnvironmentSecretRemovalV12;
  }[];
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
    "environment.history": () => ({
      readerScope: "full" as const,
      entries: [],
      hostStates: [],
    }),
    "environment.secrets.list": () => ({
      secrets: host.secrets,
      removed: host.removed,
    }),
    "environment.secrets.versions": () => ({
      versions: versionsFixture(),
      removal: host.removal,
    }),
    "environment.secrets.destroy": () => {
      if (host.finishesOnDestroy) host.removal = removal("destroyed");
      return host.destroyAnswer;
    },
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
      emptyText={SECRETS_EMPTY_TEXT}
      hostName={(hostId) => hostId}
    />,
    { wrapper: harness.Wrapper },
  );
  return harness;
}

/** A Personal host whose connection negotiated `environment.secrets.destroy@1.0`. */
function mountPersonalRowAtDestroy10(host: Host): TeamPageHarness {
  const harness = mountTeamPageNegotiating(
    { kind: "host" },
    {
      "environment.list": () => ({
        environments: [
          {
            environmentId: "env-personal",
            ownerKind: "user" as const,
            ownerId: "user-me",
            roomId: "room-personal",
            label: "Personal",
            effectiveRole: "owner" as const,
            kind: "personal" as const,
            hostCount: 1,
            providerHandle: null,
          },
        ],
      }),
      "environment.history": () => ({
        readerScope: "full" as const,
        entries: [],
        hostStates: [],
      }),
      "environment.secrets.list": () => ({
        secrets: host.secrets,
        removed: host.removed,
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
    },
    { "environment.secrets.destroy": { major: 1, minor: 0 } },
  );
  const client = requireTeamHostClient();
  render(
    <SecretsPage
      client={client}
      hostId={client.getActiveHostId()}
      emptyText={SECRETS_EMPTY_TEXT}
      hostName={(hostId) => hostId}
    />,
    { wrapper: harness.Wrapper },
  );
  return harness;
}

function freshHost(overrides: Partial<Host>): Host {
  return {
    removal: null,
    finishesOnDestroy: false,
    destroyAnswer: { outcome: "revoked" },
    secrets: [secretFixture()],
    removed: [],
    ...overrides,
  };
}

function destroyCalls(harness: TeamPageHarness) {
  return harness.messenger.calls.filter(
    (call) => call.method === "environment.secrets.destroy",
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 25, 12, 0));
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  resetTeamPageHarness();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

describe("Remove on a team secret", () => {
  it("destroys the current version in the pool environment, then keeps the row as Removing", async () => {
    const host = freshHost({});
    const harness = mountRow(host);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("secret-row-remove"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    await waitFor(() => {
      expect(dialog.textContent).toContain(
        `Added on ${dayMonth(AT - 1_000)}. Version 2.`,
      );
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
    expect(status.textContent).toBe(
      "Removing · no longer usable · waiting for dev-box to delete its copy · Retry",
    );
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
      expect(dialog.textContent).toContain(
        `Added on ${dayMonth(AT - 1_000)}. Version 2.`,
      );
    });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect((await within(dialog).findByRole("alert")).textContent).not.toBe("");
    expect(screen.queryByTestId("secret-removal-status")).toBeNull();
  });
});

describe("Remove on a Personal host that negotiated destroy@1.0", () => {
  it("shows the update remedy for the current version and sends nothing", async () => {
    // @1.0 refuses the current version; only @1.1 revokes it.
    const harness = mountPersonalRowAtDestroy10(
      freshHost({
        destroyAnswer: { outcome: "refused", code: "version_current" },
      }),
    );
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("secret-row-remove"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    await waitFor(() => {
      expect(dialog.textContent).toContain(
        `Added by you on ${dayMonth(AT - 1_000)}. Version 2.`,
      );
    });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "These secrets need an updated host.",
    );
    expect(destroyCalls(harness)).toEqual([]);
  });

  it("sends nothing to destroy a replaced version on that host either, since the call names Personal's id", async () => {
    const harness = mountPersonalRowAtDestroy10(
      freshHost({ destroyAnswer: { outcome: "destroyed", destroyedAt: AT } }),
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Details" }));
    const [, replaced] = await screen.findAllByTestId("secret-version");
    await user.click(within(replaced).getByTestId("secret-version-destroy"));
    await user.click(
      within(await screen.findByTestId("confirm-destructive-dialog")).getByRole(
        "button",
        { name: "Destroy" },
      ),
    );

    // The old host is refused before anything is sent, in the page's words.
    expect(
      (await within(replaced).findByTestId("secret-version-note")).textContent,
    ).toBe("These secrets need an updated host.");
    expect(destroyCalls(harness)).toEqual([]);
  });
});

describe("a secret with a removal", () => {
  it.each(["revoked", "cleanup_requested"] as const)(
    "keeps a %s row and offers Retry, which destroys the same current version while the host still reports it pending",
    async (outcome) => {
      const host = freshHost({
        removal: removal(outcome),
        finishesOnDestroy: true,
      });
      const harness = mountRow(host);
      const user = userEvent.setup();

      const status = await screen.findByTestId("secret-removal-status");
      expect(status.textContent).toBe(
        "Removing · no longer usable · waiting for dev-box to delete its copy · Retry",
      );
      expect(screen.getByTestId("secret-row")).toBeTruthy();

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
      // Destroyed is the one outcome that takes the row out of the list: the
      // host finished on that destroy, and the versions read after it says so.
      await waitFor(() => {
        expect(screen.queryByTestId("secret-row")).toBeNull();
      });
    },
  );

  it("sends no destroy when Retry is pressed after the host has already finished the removal", async () => {
    const host = freshHost({ removal: removal("cleanup_requested") });
    const harness = mountRow(host);
    const user = userEvent.setup();
    const status = await screen.findByTestId("secret-removal-status");

    // Finished since the row last read it: Retry reads the versions fresh,
    // finds Destroyed and has nothing left to destroy.
    host.removal = removal("destroyed");
    await user.click(within(status).getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.queryByTestId("secret-row")).toBeNull();
    });
    expect(destroyCalls(harness)).toEqual([]);
  });

  it("counts the hosts still holding a copy", async () => {
    const pending = removal("cleanup_requested");
    mountRow(
      freshHost({
        removal: {
          ...pending,
          targets: [
            ...pending.targets,
            {
              target: "host",
              hostId: "host-b",
              hostName: "laptop",
              state: "requested",
              at: AT,
              failedAt: null,
            },
          ],
        },
      }),
    );

    expect(
      (await screen.findByTestId("secret-removal-status")).textContent,
    ).toBe(
      "Removing · no longer usable · waiting for 2 hosts to delete their copies · Retry",
    );
  });

  it("drops the waiting clause when no host is pending, keeping Retry", async () => {
    mountRow(
      freshHost({
        removal: { ...removal("revoked"), targets: [] },
      }),
    );

    expect(
      (await screen.findByTestId("secret-removal-status")).textContent,
    ).toBe("Removing · no longer usable · Retry");
  });

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

describe("a team secret's row line", () => {
  it("dates the current version without claiming who made it", async () => {
    mountRow(freshHost({}));

    const line = await screen.findByTestId("secret-row-line");
    await waitFor(() => {
      expect(line.textContent).toBe(
        `STRIPE_KEY · Set · replaced ${dayMonth(AT)}`,
      );
    });
    expect(line.textContent).not.toContain("by you");
  });
});

describe("the Versions list", () => {
  it("never offers Destroy on the current version, only on a replaced one", async () => {
    const host = freshHost({
      destroyAnswer: { outcome: "destroyed", destroyedAt: AT },
    });
    const harness = mountRow(host);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Details" }));
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

  it("polls a pending removal's versions every few seconds, and stops once the host answers Destroyed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const host = freshHost({ removal: removal("cleanup_requested") });
      const harness = mountRow(host);
      await screen.findByTestId("secret-removal-status");
      const reads = (): number =>
        harness.paramsOf("environment.secrets.versions").length;
      const advance = async (ms: number): Promise<void> => {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      };

      // Pending: the row reads its versions again on its own.
      const first = reads();
      await advance(5_000);
      await waitFor(() => {
        expect(reads()).toBeGreaterThan(first);
      });
      const second = reads();
      await advance(5_000);
      await waitFor(() => {
        expect(reads()).toBeGreaterThan(second);
      });

      // The host finishes: the next read hides the row.
      host.removal = removal("destroyed");
      await advance(5_000);
      await waitFor(() => {
        expect(screen.queryByTestId("secret-row")).toBeNull();
      });

      // Nothing keeps reading a removal that is done, with the page still
      // mounted and then once it is gone.
      await waitFor(() => {
        expect(harness.queryClient.isFetching()).toBe(0);
      });
      const settled = reads();
      await advance(60_000);
      expect(reads()).toBe(settled);
      cleanup();
      await advance(60_000);
      expect(reads()).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a viewer", () => {
  it("reads the names, with no row, no write verb and no write call", async () => {
    const host = freshHost({});
    const harness = mountRowAs(host, "viewer");

    expect(await screen.findByText("STRIPE_KEY")).toBeTruthy();
    expect(screen.queryByTestId("secret-row")).toBeNull();
    for (const verb of ["Remove", "Retry", "Verify", "Replace", "Details"]) {
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

describe("a removed secret the list has moved to removed", () => {
  // authn moves a secret out of `secrets` the moment Remove revokes it.
  function removedHost(removed: EnvironmentSecretRemovalV12): Host {
    return freshHost({
      secrets: [],
      removed: [{ id: "sec-1", name: "STRIPE_KEY", removal: removed }],
      removal: removed,
    });
  }

  it("keeps a Removing row naming the host, and no empty state", async () => {
    mountRow(removedHost(removal("cleanup_requested")));

    const row = await screen.findByTestId("removed-secret-row");
    expect(row.getAttribute("data-secret-name")).toBe("STRIPE_KEY");
    // The versions read settles first, then the status drops its spinner.
    await waitFor(() => {
      expect(within(row).getByTestId("secret-removal-status").textContent).toBe(
        "Removing · no longer usable · waiting for dev-box to delete its copy · Retry",
      );
    });
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
  });

  // NEW-154-24: a viewer saw an empty page while a removal was still under
  // way. They see the name and its state, and none of the editor's row.
  it("shows a viewer a removal still under way, without the editor's row", async () => {
    mountRowAs(removedHost(removal("cleanup_requested")), "viewer");

    expect(await screen.findByText("STRIPE_KEY")).toBeTruthy();
    expect(screen.getByText("Removing · no longer usable")).toBeTruthy();
    expect(screen.queryByTestId("removed-secret-row")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByTestId("secrets-empty")).toBeNull();
    expect(screen.queryByText("No secrets.")).toBeNull();
  });

  it("counts the hosts still holding a copy", async () => {
    const pending = removal("cleanup_requested");
    mountRow(
      removedHost({
        ...pending,
        targets: [
          ...pending.targets,
          {
            target: "host",
            hostId: "host-b",
            hostName: "laptop",
            state: "requested",
            at: AT,
            failedAt: null,
          },
        ],
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("secret-removal-status").textContent).toBe(
        "Removing · no longer usable · waiting for 2 hosts to delete their copies · Retry",
      );
    });
  });

  it("shows no row for a destroyed removal, only the empty state", async () => {
    mountRow(removedHost(removal("destroyed")));

    expect(await screen.findByTestId("secrets-empty")).toBeTruthy();
    expect(screen.queryByTestId("removed-secret-row")).toBeNull();
  });

  it("retries by reading the versions, then destroying the current one", async () => {
    const host = removedHost(removal("cleanup_requested"));
    const harness = mountRow(host);
    const user = userEvent.setup();

    const status = await screen.findByTestId("secret-removal-status");
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
    const order = harness.messenger.calls
      .map((entry) => entry.method)
      .filter(
        (method) =>
          method === "environment.secrets.versions" ||
          method === "environment.secrets.destroy",
      );
    expect(order.indexOf("environment.secrets.versions")).toBeLessThan(
      order.indexOf("environment.secrets.destroy"),
    );
  });

  it("uses the shared removal retry's refusal line for a removed row", async () => {
    const host = removedHost(removal("cleanup_requested"));
    host.destroyAnswer = { outcome: "refused", code: "version_current" };
    const harness = mountRow(host);
    const user = userEvent.setup();
    const status = await screen.findByTestId("secret-removal-status");

    await user.click(within(status).getByRole("button", { name: "Retry" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "This is the current value. Replace or revoke it first.",
    );
    expect(destroyCalls(harness)).toHaveLength(1);
  });
});
