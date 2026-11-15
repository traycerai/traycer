vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
  useHostBinding: () => requireTeamEnvironmentAuthnBinding(),
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
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentSecretRemovalV12,
  EnvironmentSecretV12,
  EnvironmentSecretsDestroyResponseV11,
  SecretVersion,
} from "@traycer/protocol/host/environment-schemas";
import type {
  EnvironmentConfigurationItem,
  EnvironmentConfigurationItemWriteResponse,
} from "@traycer/protocol/host/environment/configuration-contracts";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
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
  requireTeamEnvironmentAuthnBinding,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "./team-configuration-test-support";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";

/**
 * A configuration page left open stays current with no navigation, no
 * remount and no manual refetch: a cloud team's or Personal's page follows
 * the environment's configuration revision, which the app reads from authn
 * and polls on its own cadence. The pages, query client, cloud hooks and
 * boundary that mounts the poll are real; the fake authn reads a `world` the
 * test changes between polls the way another person would.
 *
 * Time is faked but runs (`shouldAdvanceTime`), and each test moves it by the
 * production cadence (`POLL_MS`) and then waits on what the page shows.
 */

const POLL_MS = 5_000;
const HOST_ID = mockLocalHostEntry.hostId;

/** A host manifest that predates the revision method. */
const ADVERTISED_BASE = {
  "environment.configuration.items": { major: 1, minor: 0 },
  "environment.secrets.list": { major: 1, minor: 0 },
} as const;

const AT = Date.UTC(2026, 9, 20, 9, 30);

type RemovedSecretRow = {
  readonly id: string;
  readonly name: string;
  readonly removal: EnvironmentSecretRemovalV12;
};

type SecretList = {
  readonly secrets: EnvironmentSecretV12[];
  readonly removed: RemovedSecretRow[];
};

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
  removed: RemovedSecretRow[];
  removal: EnvironmentSecretRemovalV12 | null;
  versions: SecretVersion[];
  /** While set, reads of the items answer when it resolves. */
  heldItems: Deferred<{ items: EnvironmentConfigurationItem[] }> | null;
  /** While set, reads of the secret list answer when it resolves. */
  heldSecrets: Deferred<SecretList> | null;
  /** While set, item writes answer when it resolves. */
  heldWrite: Deferred<EnvironmentConfigurationItemWriteResponse> | null;
  destroyAnswer: EnvironmentSecretsDestroyResponseV11;
}

function freshWorld(): World {
  return {
    revision: "10",
    items: [],
    secrets: [],
    removed: [],
    removal: null,
    versions: versionsFixture(),
    heldItems: null,
    heldSecrets: null,
    heldWrite: null,
    destroyAnswer: { outcome: "revoked" },
  };
}

function nextItemWriteRevision(
  requestRevision: unknown,
  worldRevision: string,
): number {
  return typeof requestRevision === "number"
    ? requestRevision + 1
    : Number(worldRevision) + 1;
}

const variable = (key: string, revision: number) =>
  configurationItem({
    kind: "variable",
    key,
    os: "any",
    value: { value: `value-of-${key}` },
    revision,
  });

function secretFixture(
  overrides: Partial<EnvironmentSecretV12>,
): EnvironmentSecretV12 {
  return {
    ...RETIRED_SECRET_ROW_FIELDS,
    providerVariables: [...RETIRED_PROVIDER_VARIABLES],
    secretId: "sec-1",
    name: "STRIPE_KEY",
    kind: "api_key",
    protocol: "https",
    destinations: [],
    currentVersionId: "ver-2",
    revoked: false,
    updatedAt: AT,
    variables: [],
    ...overrides,
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

type EnvironmentRow = typeof TEAM_ENV | typeof PERSONAL_ENV;

function handlersOf(
  world: World,
  environment: EnvironmentRow,
): MockHandlerMap<HostRpcRegistry> {
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
    "environment.configuration.items.put": (params) => {
      const requestRevision: unknown = params.revision;
      return world.heldWrite === null
        ? {
            outcome: "saved",
            revision: nextItemWriteRevision(requestRevision, world.revision),
          }
        : world.heldWrite.promise;
    },
    "environment.configuration.items.delete": (params) => {
      const requestRevision: unknown = params.revision;
      return world.heldWrite === null
        ? {
            outcome: "saved",
            revision: nextItemWriteRevision(requestRevision, world.revision),
          }
        : world.heldWrite.promise;
    },
    "environment.secrets.list": () =>
      world.heldSecrets === null
        ? { secrets: [...world.secrets], removed: [...world.removed] }
        : world.heldSecrets.promise,
    "environment.secrets.versions": () => ({
      versions: [...world.versions],
      removal: world.removal,
    }),
    "environment.secrets.undo": ({ secretId, versionId }) => {
      world.secrets = world.secrets.map((secret) =>
        secret.secretId === secretId
          ? { ...secret, currentVersionId: versionId, revoked: false }
          : secret,
      );
      world.versions = world.versions.map((version) =>
        version.versionId === versionId
          ? { ...version, current: true, supersededAt: null }
          : { ...version, current: false, supersededAt: AT },
      );
      return { outcome: "accepted", rotationId: "restore-rotation", versionId };
    },
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
  const harness = mountTeamPage(
    poolSource("editor"),
    handlersOf(world, environment),
  );
  render(
    <ConfigurationSourceBoundary
      section={null}
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
      section={null}
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
  const harness = mountTeamPage(
    poolSource("editor"),
    handlersOf(world, environment),
  );
  secretsPage(harness, environment);
  return harness;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
    expect(
      await screen.findByRole("textbox", { name: "Value for NODE_ENV" }),
    ).toBeTruthy();
    expect(harness.paramsOf("environment.configuration.items")[0]).toEqual({
      environmentId: environment.environmentId,
    });

    // Another computer adds LOG_LEVEL: only the revision moves on the wire.
    world.items = [variable("NODE_ENV", 1), variable("LOG_LEVEL", 2)];
    world.revision = "11";
    expect(
      screen.queryByRole("textbox", { name: "Value for LOG_LEVEL" }),
    ).toBeNull();
    await pollOnce();
    expect(
      await screen.findByRole("textbox", { name: "Value for LOG_LEVEL" }),
    ).toBeTruthy();

    // And deletes NODE_ENV.
    world.items = [variable("LOG_LEVEL", 2)];
    world.revision = "12";
    await pollOnce();
    await vi.waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Value for NODE_ENV" }),
      ).toBeNull();
    });
    expect(
      screen.getByRole("textbox", { name: "Value for LOG_LEVEL" }),
    ).toBeTruthy();
  });

  it("reads the items again only when the revision has moved", async () => {
    const world = freshWorld();
    world.items = [variable("NODE_ENV", 1)];
    const harness = mountVariables(world, environment);
    await screen.findByRole("textbox", { name: "Value for NODE_ENV" });
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
    await screen.findByRole("textbox", { name: "Value for NODE_ENV" });
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
    expect(
      screen.getByRole("textbox", { name: "Value for NODE_ENV" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Couldn't read/)).toBeNull();

    held.resolve({
      items: [variable("NODE_ENV", 1), variable("LOG_LEVEL", 2)],
    });
    expect(
      await screen.findByRole("textbox", { name: "Value for LOG_LEVEL" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Value for NODE_ENV" }),
    ).toBeTruthy();
  });
});

describe("a Variables page whose host predates revision support", () => {
  it("reads authn's revision without sending a revision call to the host", async () => {
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
        section={null}
        target={{ kind: "team", environmentId: "env-a" }}
      >
        <TeamVariablesAndShells />
      </ConfigurationSourceBoundary>,
      { wrapper: harness.Wrapper },
    );
    await screen.findByRole("textbox", { name: "Value for NODE_ENV" });

    world.items = [variable("NODE_ENV", 1), variable("LOG_LEVEL", 2)];
    world.revision = "11";
    await pollOnce();

    expect(
      await screen.findByRole("textbox", { name: "Value for LOG_LEVEL" }),
    ).toBeTruthy();
    expect(
      reads(harness, "environment.configuration.revision"),
    ).toBeGreaterThan(1);
    expect(
      harness.messenger.calls.filter(
        (call) => call.method === "environment.configuration.revision",
      ),
    ).toHaveLength(0);
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
    world.secrets = [secretFixture({})];
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
    world.secrets = [secretFixture({})];
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
    world.heldSecrets = held;
    const before = reads(harness, "environment.secrets.list");
    await pollOnce();
    await vi.waitFor(() => {
      expect(reads(harness, "environment.secrets.list")).toBeGreaterThan(
        before,
      );
    });
    expect(screen.getByTestId("removed-secret-row")).toBeTruthy();
    expect(screen.queryByTestId("secrets-empty")).toBeNull();

    world.heldSecrets = null;
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

describe("returning to an earlier secret version", () => {
  it("re-reads versions from authn after Undo", async () => {
    const world = freshWorld();
    world.secrets = [secretFixture({})];
    const harness = mountSecrets(world, PERSONAL_ENV);

    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    const rows = await screen.findAllByTestId("secret-version");
    expect(rows).toHaveLength(2);
    const versionReadsBefore = reads(harness, "environment.secrets.versions");

    fireEvent.click(within(rows[1]).getByTestId("secret-version-undo"));

    await waitFor(() => {
      expect(harness.paramsOf("environment.secrets.undo")).toEqual([
        {
          environmentId: PERSONAL_ENV.environmentId,
          secretId: "sec-1",
          versionId: "ver-1",
          regrant: false,
        },
      ]);
      expect(reads(harness, "environment.secrets.versions")).toBeGreaterThan(
        versionReadsBefore,
      );
    });
    await waitFor(() => {
      const updatedRows = screen.getAllByTestId("secret-version");
      expect(updatedRows[0]?.getAttribute("data-version-state")).toBe(
        "replaced",
      );
      expect(updatedRows[1]?.getAttribute("data-version-state")).toBe(
        "current",
      );
    });
    expect(
      harness.messenger.calls.filter(
        (call) => call.method === "environment.secrets.versions",
      ),
    ).toHaveLength(0);
  });
});

describe("a Variables page while its own write is in flight", () => {
  /** Holds authn's answer to the write, apart from the read that observes it. */
  function holdWrite(
    world: World,
  ): Deferred<EnvironmentConfigurationItemWriteResponse> {
    const answer = deferred<EnvironmentConfigurationItemWriteResponse>();
    world.heldWrite = answer;
    return answer;
  }

  it("keeps the Add form visible and confirms acceptance through the live revision poll before the next write", async () => {
    const world = freshWorld();
    const harness = mountVariables(world, TEAM_ENV);
    await screen.findByText("No variables.");
    const answer = holdWrite(world);

    fireEvent.click(screen.getByRole("button", { name: "Add a variable" }));
    const draft = screen.getByRole("region", { name: "New variable" });
    fireEvent.change(within(draft).getByLabelText("New variable name"), {
      target: { value: "NEW_VAR" },
    });
    fireEvent.change(within(draft).getByLabelText("New variable value"), {
      target: { value: "one" },
    });
    fireEvent.click(
      within(draft).getByRole("button", { name: "Apply variable" }),
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
    for (const field of ["New variable name", "New variable value"]) {
      expect(within(pendingDraft()).getByLabelText(field)).toHaveProperty(
        "disabled",
        true,
      );
    }
    expect(screen.queryByText("No variables.")).toBeNull();

    await act(async () => {
      world.heldWrite = null;
      answer.resolve({ outcome: "saved", revision: 3 });
      await answer.promise;
    });
    const status = await screen.findByText(
      "Saved, but latest settings haven't refreshed.",
    );
    expect(within(status).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "New variable" })).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "NEW_VAR" })).getByText("one"),
    ).toBeTruthy();
    expect(screen.queryByText("No variables.")).toBeNull();

    // Another read observes it: a real row replaces the accepted line.
    world.items = [{ ...variable("NEW_VAR", 3), value: { value: "one" } }];
    world.revision = "11";
    await pollOnce();
    expect(
      await screen.findByRole("textbox", { name: "Value for NEW_VAR" }),
    ).toBeTruthy();
    await vi.waitFor(() => {
      expect(screen.queryByText(/Adding/)).toBeNull();
    });
    expect(screen.queryByRole("region", { name: "New variable" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add a variable" }),
    ).toHaveProperty("disabled", false);
    expect(screen.queryByText(/Saved[.,]/)).toBeNull();
    world.items = [{ ...variable("NEW_VAR", 4), value: { value: "two" } }];
    world.revision = "12";
    fireEvent.change(screen.getByLabelText("Value for NEW_VAR"), {
      target: { value: "two" },
    });
    fireEvent.blur(screen.getByLabelText("Value for NEW_VAR"));
    await vi.waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.put"),
      ).toHaveLength(2);
      expect(
        screen.getByRole("textbox", { name: "Value for NEW_VAR" }),
      ).toHaveProperty("disabled", false);
    });
    expect(
      harness.paramsOf("environment.configuration.items.put")[1],
    ).toMatchObject({ revision: 3 });
    expect(
      screen.getByRole("textbox", { name: "Value for NEW_VAR" }),
    ).toHaveProperty("value", "two");
  });

  it("keeps Remove in flight once, then confirms the accepted removal through the live revision poll", async () => {
    const world = freshWorld();
    world.items = [variable("OLD_VAR", 1)];
    const harness = mountVariables(world, TEAM_ENV);
    const user = userEvent.setup();
    await screen.findByRole("textbox", { name: "Value for OLD_VAR" });
    const answer = holdWrite(world);
    const row = (): HTMLElement =>
      screen.getByRole("region", { name: "OLD_VAR" });

    await user.click(
      within(row()).getByRole("button", { name: "Remove OLD_VAR" }),
    );

    await vi.waitFor(() => {
      expect(
        harness.paramsOf("environment.configuration.items.delete"),
      ).toHaveLength(1);
    });
    expect(within(row()).getByRole("status").textContent).toContain(
      "OLD_VAR · Removing",
    );
    expect(
      within(row()).getByRole("button", { name: "Remove OLD_VAR" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(
      within(row()).getByRole("button", { name: "Remove OLD_VAR" }),
    );
    expect(
      harness.paramsOf("environment.configuration.items.delete"),
    ).toHaveLength(1);

    await act(async () => {
      world.heldWrite = null;
      answer.resolve({ outcome: "saved", revision: 2 });
      await answer.promise;
    });
    const status = await screen.findByText(
      "Removed, but latest settings haven't refreshed.",
    );
    expect(within(status).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Value for OLD_VAR" }),
    ).toHaveProperty("disabled", true);
    expect(screen.queryByText("No variables.")).toBeNull();

    world.items = [];
    world.revision = "11";
    await pollOnce();
    await vi.waitFor(() => {
      expect(
        screen.queryByRole("textbox", { name: "Value for OLD_VAR" }),
      ).toBeNull();
    });
    expect(await screen.findByText("No variables.")).toBeTruthy();
    expect(screen.queryByText(/Removed[.,]/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add a variable" }),
    ).toHaveProperty("disabled", false);
  });
});
