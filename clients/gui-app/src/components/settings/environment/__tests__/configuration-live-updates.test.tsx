// These cases are about the environments-on behaviour: the Secrets page's
// queries are disabled on any other verdict.
vi.mock("@/hooks/auth/use-preview-feature", () => ({
  usePreviewFeature: () => "on" as const,
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
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));
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
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentSecretRemovalV12,
  EnvironmentSecretV12,
  EnvironmentSecretsDestroyResponseV11,
  SecretVersion,
} from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentConfigurationItem } from "@traycer/protocol/host/environment/configuration-contracts";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { ConfigurationSourceBoundary } from "@/components/settings/environment/configuration-source-boundary";
import { TeamVariablesAndShells } from "@/components/settings/environment/team-variables-and-shells";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import { SECRETS_EMPTY_TEXT } from "@/lib/sandboxes/secrets-page-copy";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  configurationItem,
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "./team-configuration-test-support";

/**
 * A configuration page left open stays current with no navigation, no
 * remount and no manual refetch: a cloud team's or Personal's page follows
 * the environment's configuration revision, which the host answers over
 * `environment.configuration.revision` and the page polls on its own
 * cadence. The pages, the query client, `useHostQuery` and the boundary that
 * mounts the poll are real; the only fake is the host behind the messenger,
 * a `world` the test changes between polls the way another machine would.
 *
 * Time is faked but runs (`shouldAdvanceTime`), and each test moves it by the
 * production cadence (`POLL_MS`) and then waits on what the page shows.
 */

const POLL_MS = 5_000;
const HOST_ID = mockLocalHostEntry.hostId;

/** The methods every host here advertises, as its handshake records them. */
const ADVERTISED_BASE = {
  "environment.configuration.items": { major: 1, minor: 0 },
  "environment.secrets.list": { major: 1, minor: 0 },
} as const;

/** A host whose manifest lists the revision method: the page polls it. */
function advertiseRevisionMethod(): void {
  recordNegotiatedHostManifest(HOST_ID, {
    ...ADVERTISED_BASE,
    "environment.configuration.revision": { major: 1, minor: 0 },
  });
}
const AT = Date.UTC(2026, 9, 20, 9, 30);

const TEAM_ENV = {
  environmentId: "env-a",
  ownerKind: "organization" as const,
  ownerId: "team-a",
  roomId: "room-a",
  label: "Acme",
  effectiveRole: "editor" as const,
  kind: "team" as const,
  hostCount: 0,
  providerHandle: "handle-a",
};
const PERSONAL_ENV = {
  environmentId: "env-personal",
  ownerKind: "user" as const,
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner" as const,
  kind: "personal" as const,
  hostCount: 0,
  providerHandle: null,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** What the host holds; a test edits it to say what changed elsewhere. */
interface World {
  /** The configuration revision, a decimal string. */
  revision: string;
  items: EnvironmentConfigurationItem[];
  secrets: EnvironmentSecretV12[];
  removed: {
    id: string;
    name: string;
    removal: EnvironmentSecretRemovalV12;
  }[];
  removal: EnvironmentSecretRemovalV12 | null;
  /** While set, reads of the items answer when it resolves. */
  heldItems: Deferred<{ items: EnvironmentConfigurationItem[] }> | null;
  destroyAnswer: EnvironmentSecretsDestroyResponseV11;
}

function freshWorld(): World {
  return {
    revision: "10",
    items: [],
    secrets: [],
    removed: [],
    removal: null,
    heldItems: null,
    destroyAnswer: { outcome: "revoked" },
  };
}

const variable = (key: string, revision: number) =>
  configurationItem({
    kind: "variable",
    key,
    os: "any",
    value: { value: `value-of-${key}` },
    revision,
  });

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

type EnvironmentRow = typeof TEAM_ENV | typeof PERSONAL_ENV;

function handlersOf(world: World, environment: EnvironmentRow) {
  return {
    "environment.list": () => ({ environments: [environment] }),
    "environment.history": () => ({
      readerScope: "full" as const,
      entries: [],
      hostStates: [],
    }),
    "environment.host.list": () => ({ hosts: [] }),
    "environment.configuration.revision": () => ({
      revision: world.revision,
    }),
    "environment.configuration.items": () =>
      world.heldItems === null
        ? { items: [...world.items] }
        : world.heldItems.promise,
    "environment.secrets.list": () => ({
      secrets: [...world.secrets],
      removed: [...world.removed],
    }),
    "environment.secrets.versions": () => ({
      versions: versionsFixture(),
      removal: world.removal,
    }),
    "environment.secrets.destroy": () => world.destroyAnswer,
    "environment.secrets.rotation": () => ({
      rotation: null,
      lastVerify: null,
    }),
  };
}

function reads(harness: TeamPageHarness, method: string): number {
  return harness.paramsOf(method).length;
}

/** Moves the clock by one production poll interval, letting the page settle. */
async function pollOnce(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  });
}

function mountVariables(
  world: World,
  environment: EnvironmentRow,
): TeamPageHarness {
  useSettingsEnvironmentPickStore.setState({
    pick:
      environment.kind === "team"
        ? { kind: "team", environmentId: environment.environmentId }
        : { kind: "personal" },
  });
  advertiseRevisionMethod();
  const harness = mountTeamPage(
    poolSource("editor"),
    handlersOf(world, environment),
  );
  render(
    <ConfigurationSourceBoundary
      target={
        environment.kind === "team"
          ? { kind: "team", environmentId: environment.environmentId }
          : { kind: "personal" }
      }
    >
      <TeamVariablesAndShells />
    </ConfigurationSourceBoundary>,
    { wrapper: harness.Wrapper },
  );
  return harness;
}

function secretsPage(harness: TeamPageHarness, environment: EnvironmentRow) {
  const client = requireTeamHostClient();
  render(
    <ConfigurationSourceBoundary
      target={
        environment.kind === "team"
          ? { kind: "team", environmentId: environment.environmentId }
          : { kind: "personal" }
      }
    >
      <SecretsPage
        client={client}
        hostId={client.getActiveHostId()}
        emptyText={SECRETS_EMPTY_TEXT}
        hostName={(hostId) => hostId}
      />
    </ConfigurationSourceBoundary>,
    { wrapper: harness.Wrapper },
  );
}

function mountSecrets(
  world: World,
  environment: EnvironmentRow,
): TeamPageHarness {
  useSettingsEnvironmentPickStore.setState({
    pick:
      environment.kind === "team"
        ? { kind: "team", environmentId: environment.environmentId }
        : { kind: "personal" },
  });
  advertiseRevisionMethod();
  const harness = mountTeamPage(
    poolSource("editor"),
    handlersOf(world, environment),
  );
  secretsPage(harness, environment);
  return harness;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

describe.each([
  ["a team", TEAM_ENV],
  ["Personal", PERSONAL_ENV],
])("%s's Variables page left open", (_label, environment) => {
  it("adds and drops a variable another computer wrote or deleted, though no host is running it", async () => {
    const world = freshWorld();
    world.items = [variable("NODE_ENV", 1)];
    const harness = mountVariables(world, environment);
    expect(await screen.findByLabelText("NODE_ENV value")).toBeTruthy();
    expect(harness.paramsOf("environment.configuration.items")[0]).toEqual({
      environmentId: environment.environmentId,
    });

    // Another computer adds LOG_LEVEL: only the revision moves on the wire.
    world.items = [variable("NODE_ENV", 1), variable("LOG_LEVEL", 2)];
    world.revision = "11";
    expect(screen.queryByLabelText("LOG_LEVEL value")).toBeNull();
    await pollOnce();
    expect(await screen.findByLabelText("LOG_LEVEL value")).toBeTruthy();

    // And deletes NODE_ENV.
    world.items = [variable("LOG_LEVEL", 2)];
    world.revision = "12";
    await pollOnce();
    await vi.waitFor(() => {
      expect(screen.queryByLabelText("NODE_ENV value")).toBeNull();
    });
    expect(screen.getByLabelText("LOG_LEVEL value")).toBeTruthy();
  });

  it("reads the items again only when the revision has moved", async () => {
    const world = freshWorld();
    world.items = [variable("NODE_ENV", 1)];
    const harness = mountVariables(world, environment);
    await screen.findByLabelText("NODE_ENV value");
    // The first revision answer may read the items once more, to close the
    // race between the first read and the first answer.
    await pollOnce();
    await vi.waitFor(() => {
      expect(
        reads(harness, "environment.configuration.revision"),
      ).toBeGreaterThan(1);
    });
    const settledItemReads = reads(harness, "environment.configuration.items");
    const settledRevisionReads = reads(
      harness,
      "environment.configuration.revision",
    );

    await pollOnce();
    await pollOnce();

    expect(
      reads(harness, "environment.configuration.revision"),
    ).toBeGreaterThan(settledRevisionReads);
    expect(reads(harness, "environment.configuration.items")).toBe(
      settledItemReads,
    );
  });
});

describe("a Variables page whose items read is held", () => {
  it("keeps the rows it has while the changed revision's read is in flight, then swaps them", async () => {
    const world = freshWorld();
    world.items = [variable("NODE_ENV", 1)];
    const harness = mountVariables(world, TEAM_ENV);
    await screen.findByLabelText("NODE_ENV value");
    await pollOnce();

    const held = deferred<{ items: EnvironmentConfigurationItem[] }>();
    world.heldItems = held;
    world.revision = "11";
    const before = reads(harness, "environment.configuration.items");
    await pollOnce();
    await vi.waitFor(() => {
      expect(reads(harness, "environment.configuration.items")).toBeGreaterThan(
        before,
      );
    });

    // Prior data stays on screen: no blank page, no failure line, no spinner
    // in place of the rows.
    expect(screen.getByLabelText("NODE_ENV value")).toBeTruthy();
    expect(screen.queryByText(/Couldn't read/)).toBeNull();

    held.resolve({
      items: [variable("NODE_ENV", 1), variable("LOG_LEVEL", 2)],
    });
    expect(await screen.findByLabelText("LOG_LEVEL value")).toBeTruthy();
    expect(screen.getByLabelText("NODE_ENV value")).toBeTruthy();
  });
});

describe("a Variables page on a host that does not advertise the revision method", () => {
  it("never asks for the revision and reads the items on the same cadence instead", async () => {
    const world = freshWorld();
    world.items = [variable("NODE_ENV", 1)];
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "team", environmentId: "env-a" },
    });
    // An older host: its handshake lists the other methods, not this one.
    recordNegotiatedHostManifest(HOST_ID, ADVERTISED_BASE);
    const harness = mountTeamPage(
      poolSource("editor"),
      handlersOf(world, TEAM_ENV),
    );
    render(
      <ConfigurationSourceBoundary
        target={{ kind: "team", environmentId: "env-a" }}
      >
        <TeamVariablesAndShells />
      </ConfigurationSourceBoundary>,
      { wrapper: harness.Wrapper },
    );
    await screen.findByLabelText("NODE_ENV value");

    world.items = [variable("NODE_ENV", 1), variable("LOG_LEVEL", 2)];
    await pollOnce();

    expect(await screen.findByLabelText("LOG_LEVEL value")).toBeTruthy();
    expect(harness.paramsOf("environment.configuration.revision")).toEqual([]);
  });
});

describe("a Secrets page left open on a removal", () => {
  it("drops a removed secret's Removing row when the hosts finish, with no revision change", async () => {
    const world = freshWorld();
    world.removed = [
      {
        id: "sec-1",
        name: "STRIPE_KEY",
        removal: removal("cleanup_requested"),
      },
    ];
    world.removal = removal("cleanup_requested");
    const harness = mountSecrets(world, PERSONAL_ENV);
    const row = await screen.findByTestId("removed-secret-row");
    await vi.waitFor(() => {
      expect(
        within(row).getByTestId("secret-removal-status").textContent,
      ).toContain("waiting for dev-box to delete its copy");
    });

    // Every host deleted its copy and the broker reached destroyed: the
    // revision the page follows did not move.
    world.removed = [
      { id: "sec-1", name: "STRIPE_KEY", removal: removal("destroyed") },
    ];
    world.removal = removal("destroyed");
    expect(screen.getByTestId("removed-secret-row")).toBeTruthy();
    await pollOnce();

    await vi.waitFor(() => {
      expect(screen.queryByTestId("removed-secret-row")).toBeNull();
    });
    expect(await screen.findByTestId("secrets-empty")).toBeTruthy();
    // The revision never moved: the page changed because it polled the
    // removal itself, not because the configuration revision announced it.
    expect(world.revision).toBe("10");
    expect(
      reads(harness, "environment.configuration.revision"),
    ).toBeGreaterThan(1);
  });

  it("drops a still-listed secret's Removing status the same way, and offers no Retry once destroyed", async () => {
    const world = freshWorld();
    world.secrets = [secretFixture()];
    world.removal = removal("revoked");
    mountSecrets(world, TEAM_ENV);
    const status = await screen.findByTestId("secret-removal-status");
    expect(within(status).getByRole("button", { name: "Retry" })).toBeTruthy();

    world.removal = removal("destroyed");
    await pollOnce();

    await vi.waitFor(() => {
      expect(screen.queryByTestId("secret-row")).toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("sends no destroy when Retry is pressed on a removal the host has already finished", async () => {
    const world = freshWorld();
    world.secrets = [secretFixture()];
    world.removal = removal("revoked");
    const harness = mountSecrets(world, TEAM_ENV);
    const status = await screen.findByTestId("secret-removal-status");

    // Finished since the page last read it, before the page has polled.
    world.removal = removal("destroyed");
    fireEvent.click(within(status).getByRole("button", { name: "Retry" }));

    await vi.waitFor(() => {
      expect(screen.queryByTestId("secret-row")).toBeNull();
    });
    expect(harness.paramsOf("environment.secrets.destroy")).toEqual([]);
  });

  it("keeps the row while a poll's read is held, and only then removes it", async () => {
    const world = freshWorld();
    world.removed = [
      {
        id: "sec-1",
        name: "STRIPE_KEY",
        removal: removal("cleanup_requested"),
      },
    ];
    world.removal = removal("cleanup_requested");
    const harness = mountSecrets(world, PERSONAL_ENV);
    await screen.findByTestId("removed-secret-row");

    const held = deferred<{
      secrets: EnvironmentSecretV12[];
      removed: World["removed"];
    }>();
    harness.messenger.setHandlers({
      ...handlersOf(world, PERSONAL_ENV),
      "environment.secrets.list": () => held.promise,
    });
    const before = reads(harness, "environment.secrets.list");
    await pollOnce();
    await vi.waitFor(() => {
      expect(reads(harness, "environment.secrets.list")).toBeGreaterThan(
        before,
      );
    });
    expect(screen.getByTestId("removed-secret-row")).toBeTruthy();
    expect(screen.queryByTestId("secrets-empty")).toBeNull();

    held.resolve({
      secrets: [],
      removed: [
        { id: "sec-1", name: "STRIPE_KEY", removal: removal("destroyed") },
      ],
    });
    await vi.waitFor(() => {
      expect(screen.queryByTestId("removed-secret-row")).toBeNull();
    });
  });
});

describe("a Variables page while its own write is in flight", () => {
  type WriteAnswer = { outcome: "saved"; revision: number };

  /** Holds the host's answer to the write, apart from the read that observes it. */
  function holdWrite(
    harness: TeamPageHarness,
    world: World,
    method:
      | "environment.configuration.items.put"
      | "environment.configuration.items.delete",
  ): Deferred<WriteAnswer> {
    const answer = deferred<WriteAnswer>();
    const handlers = handlersOf(world, TEAM_ENV);
    harness.messenger.setHandlers(
      method === "environment.configuration.items.put"
        ? {
            ...handlers,
            "environment.configuration.items.put": () => answer.promise,
          }
        : {
            ...handlers,
            "environment.configuration.items.delete": () => answer.promise,
          },
    );
    return answer;
  }

  it("shows Adding on a disabled draft from Add until the read lists the variable, never 'No variables yet'", async () => {
    const world = freshWorld();
    const harness = mountVariables(world, TEAM_ENV);
    await screen.findByText("No variables yet.");
    const answer = holdWrite(
      harness,
      world,
      "environment.configuration.items.put",
    );

    const draft = screen.getByRole("region", { name: "New variable" });
    fireEvent.change(within(draft).getByLabelText("Variable name"), {
      target: { value: "NEW_VAR" },
    });
    fireEvent.change(within(draft).getByLabelText("New variable value"), {
      target: { value: "one" },
    });
    fireEvent.click(
      within(draft).getByRole("button", { name: "Add a variable" }),
    );

    // In flight: the draft is kept as typed, disabled, and says Adding.
    await vi.waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(1);
    });
    const pendingDraft = (): HTMLElement =>
      screen.getByRole("region", { name: "New variable" });
    expect(within(pendingDraft()).getByRole("status").textContent).toContain(
      "NEW_VAR · Adding",
    );
    for (const field of ["Variable name", "New variable value"]) {
      expect(within(pendingDraft()).getByLabelText(field)).toHaveProperty(
        "disabled",
        true,
      );
    }
    expect(screen.queryByText("No variables yet.")).toBeNull();

    // Accepted, but the host's read does not list it yet: still Adding.
    await act(async () => {
      answer.resolve({ outcome: "saved", revision: 3 });
      await Promise.resolve();
    });
    expect(within(pendingDraft()).getByRole("status").textContent).toContain(
      "NEW_VAR · Adding",
    );
    expect(screen.queryByText("No variables yet.")).toBeNull();

    // Another read observes it: a real row replaces the draft, which empties.
    world.items = [{ ...variable("NEW_VAR", 3), value: { value: "one" } }];
    world.revision = "11";
    await pollOnce();
    const row = await screen.findByLabelText("NEW_VAR value");
    expect(row).toHaveProperty("value", "one");
    await vi.waitFor(() => {
      expect(screen.queryByText(/Adding/)).toBeNull();
    });
    expect(
      within(
        screen.getByRole("region", { name: "New variable" }),
      ).getByLabelText("Variable name"),
    ).toHaveProperty("value", "");
  });

  it("keeps a removed variable's row as Removing, its Delete disabled and sent once, until the read drops it", async () => {
    const world = freshWorld();
    world.items = [variable("OLD_VAR", 1)];
    const harness = mountVariables(world, TEAM_ENV);
    await screen.findByLabelText("OLD_VAR value");
    const answer = holdWrite(
      harness,
      world,
      "environment.configuration.items.delete",
    );
    const row = (): HTMLElement =>
      screen.getByRole("region", { name: "OLD_VAR" });

    fireEvent.click(within(row()).getByRole("button", { name: "Delete" }));

    await vi.waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.delete"),
      ).toHaveLength(1);
    });
    expect(within(row()).getByRole("status").textContent).toContain(
      "OLD_VAR · Removing",
    );
    expect(
      within(row()).getByRole("button", { name: "Delete" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(within(row()).getByRole("button", { name: "Delete" }));
    expect(
      harness.paramsOf("environment.configuration.items.delete"),
    ).toHaveLength(1);

    // Accepted, the read still lists it: the row is retained, still Removing.
    await act(async () => {
      answer.resolve({ outcome: "saved", revision: 2 });
      await Promise.resolve();
    });
    expect(screen.getByLabelText("OLD_VAR value")).toBeTruthy();
    expect(within(row()).getByRole("status").textContent).toContain(
      "OLD_VAR · Removing",
    );
    expect(screen.queryByText("No variables yet.")).toBeNull();

    world.items = [];
    world.revision = "11";
    await pollOnce();
    await vi.waitFor(() => {
      expect(screen.queryByLabelText("OLD_VAR value")).toBeNull();
    });
    expect(await screen.findByText("No variables yet.")).toBeTruthy();
  });
});
