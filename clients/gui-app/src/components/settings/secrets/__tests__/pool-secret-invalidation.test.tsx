const openLinkMock = vi.hoisted(() => vi.fn<OpenLink>());
vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => openLinkMock,
}));
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => ({
      hosts: [],
      state: "ready",
      collisions: [],
      retry: () => undefined,
    }),
  }),
);
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

import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type {
  EnvironmentSecretRemovalV12,
  EnvironmentSecretV12,
  EnvironmentSecretsRotationResponse,
  SecretVersion,
} from "@traycer/protocol/host/environment-schemas";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import type { OpenLink } from "@/lib/links/open-link";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  hostIdsOf,
  mountTeamPageOnPoolBuild,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  teamHostBoundary,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { SECRET_READS } from "@/lib/environment/delta-fed-reads";
import { SECRETS_EMPTY_TEXT } from "@/lib/sandboxes/secrets-page-copy";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import type { ReactNode } from "react";
import type { QueryKey } from "@tanstack/react-query";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";

const AT = Date.UTC(2026, 9, 20, 9, 30);
const LOCAL_HOST_ID = mockLocalHostEntry.hostId;
type SecretReadMethod = (typeof SECRET_READS)[number];
type Rotation = EnvironmentSecretsRotationResponse["rotation"];
type RemovedSecret = ResponseOfMethod<
  HostRpcRegistry,
  "environment.secrets.list"
>["removed"][number];

interface SecretHostState {
  secrets: EnvironmentSecretV12[];
  removed: RemovedSecret[];
  versions: SecretVersion[];
  removal: EnvironmentSecretRemovalV12 | null;
  rotation: Rotation;
}

function secretFixture(
  overrides: Partial<EnvironmentSecretV12>,
): EnvironmentSecretV12 {
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
    ...overrides,
  };
}

function versionFixture(overrides: Partial<SecretVersion>): SecretVersion {
  return {
    versionId: "ver-2",
    ordinal: 2,
    createdAt: AT,
    supersededAt: null,
    destroyedAt: null,
    current: true,
    rotationState: null,
    ...overrides,
  };
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

function rotationFixture(): NonNullable<Rotation> {
  return {
    rotationId: "rot-1",
    fromVersionId: "ver-2",
    toVersionId: "ver-3",
    state: "enforcing",
    issuedAt: AT,
    producers: [
      {
        producer: "worker",
        workerClass: "https",
        incarnation: "inc-1",
        status: "missing",
        evidence: null,
      },
    ],
  };
}

function stateWithSecret(overrides: Partial<SecretHostState>): SecretHostState {
  return {
    secrets: [secretFixture({})],
    removed: [],
    versions: [
      versionFixture({}),
      versionFixture({
        versionId: "ver-1",
        ordinal: 1,
        createdAt: AT - 1_000,
        current: false,
        supersededAt: AT,
      }),
    ],
    removal: null,
    rotation: null,
    ...overrides,
  };
}

function handlersFor(state: SecretHostState): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.list": () => ({ environments: [] }),
    "environment.secrets.list": () => ({
      secrets: [...state.secrets],
      removed: [...state.removed],
    }),
    "environment.secrets.versions": () => ({
      versions: [...state.versions],
      removal: state.removal,
    }),
    "environment.secrets.rotation": () => ({
      rotation: state.rotation,
      lastVerify: null,
    }),
    "environment.secrets.create": (request) => {
      const secret = secretFixture({
        secretId: "sec-2",
        name: request.name,
        currentVersionId: "ver-1",
      });
      state.secrets = [...state.secrets, secret];
      return { outcome: "created", secret };
    },
    "environment.secrets.replaceValue": () => {
      state.secrets = state.secrets.map((secret) =>
        secret.secretId === "sec-1"
          ? { ...secret, currentVersionId: "ver-3" }
          : secret,
      );
      state.versions = [
        versionFixture({ versionId: "ver-3", ordinal: 3 }),
        versionFixture({
          versionId: "ver-2",
          ordinal: 2,
          current: false,
          supersededAt: AT,
        }),
      ];
      state.rotation = rotationFixture();
      return { outcome: "accepted", rotationId: "rot-1", versionId: "ver-3" };
    },
    "environment.secrets.destroy": () => {
      const nextRemoval = removal(
        state.removed.length === 0 ? "revoked" : "destroyed",
      );
      state.removal = nextRemoval;
      state.removed = [
        { id: "sec-1", name: "STRIPE_KEY", removal: nextRemoval },
      ];
      if (nextRemoval.outcome === "revoked") {
        return { outcome: "revoked" };
      }
      return { outcome: "destroyed", destroyedAt: AT };
    },
    "environment.secrets.undo": () => {
      state.secrets = state.secrets.map((secret) =>
        secret.secretId === "sec-1"
          ? { ...secret, currentVersionId: "ver-1" }
          : secret,
      );
      state.versions = [
        versionFixture({
          versionId: "ver-1",
          ordinal: 1,
          current: true,
          supersededAt: null,
        }),
        versionFixture({
          versionId: "ver-2",
          ordinal: 2,
          current: false,
          supersededAt: AT,
        }),
      ];
      return { outcome: "accepted", rotationId: "rot-2", versionId: "ver-1" };
    },
  };
}

/** Keeps each pool-backed secret read observed while an action runs. */
function SecretReadProbe(props: {
  readonly client: HostClient<HostRpcRegistry>;
}): ReactNode {
  const list = useHostQuery<HostRpcRegistry, "environment.secrets.list">({
    cacheKeyIdentity: ["user-me"],
    client: props.client,
    method: "environment.secrets.list",
    params: { environmentId: "env-a" },
    options: {},
  });
  const versions = useHostQuery<
    HostRpcRegistry,
    "environment.secrets.versions"
  >({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "environment.secrets.versions",
    params: { secretId: "sec-1", environmentId: "env-a" },
    options: {},
  });
  const rotation = useHostQuery<
    HostRpcRegistry,
    "environment.secrets.rotation"
  >({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "environment.secrets.rotation",
    params: { secretId: "sec-1", environmentId: "env-a" },
    options: {},
  });
  return (
    <div hidden>
      <output data-testid="pool-secret-list">
        {list.data?.secrets.map((secret) => secret.name).join(",") ?? ""}
      </output>
      <output data-testid="pool-secret-version">
        {versions.data?.versions.find((version) => version.current)
          ?.versionId ?? ""}
      </output>
      <output data-testid="pool-secret-rotation">
        {rotation.data?.rotation?.rotationId ?? ""}
      </output>
    </div>
  );
}

interface MountPageOptions {
  readonly noSurfaceHost?: boolean;
  readonly includeProbe?: boolean;
}

function mountPage(
  state: SecretHostState,
  options: MountPageOptions | undefined,
): TeamPageHarness {
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "team", environmentId: "env-a" },
  });
  const harness = mountTeamPageOnPoolBuild(
    poolSource("editor"),
    handlersFor(state),
  );
  const initialClient = requireTeamHostClient();
  if (options?.noSurfaceHost === true) {
    useSelectionAuthorityStore.getState().reset();
    teamHostBoundary.client = initialClient.createRequesterForHostId(null);
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBeNull();
  }
  const client = requireTeamHostClient();
  const page = (
    <SecretsPage
      client={client}
      hostId={client.getActiveHostId()}
      emptyText={SECRETS_EMPTY_TEXT}
      hostName={(hostId) => hostId}
    />
  );
  render(
    options?.includeProbe === false ? (
      page
    ) : (
      <>
        {page}
        <SecretReadProbe client={client} />
      </>
    ),
    { wrapper: harness.Wrapper },
  );
  return harness;
}

function seedHostScopedDecoy(
  harness: TeamPageHarness,
  method: SecretReadMethod,
): QueryKey {
  const key = hostQueryKeys.methodScope(LOCAL_HOST_ID, method);
  harness.queryClient.setQueryDefaults(key, { gcTime: 60_000 });
  harness.queryClient.setQueryData(key, { decoy: method });
  return key;
}

function seedHostScopedDecoys(
  harness: TeamPageHarness,
): Record<SecretReadMethod, QueryKey> {
  return {
    "environment.secrets.list": seedHostScopedDecoy(
      harness,
      "environment.secrets.list",
    ),
    "environment.secrets.versions": seedHostScopedDecoy(
      harness,
      "environment.secrets.versions",
    ),
    "environment.secrets.rotation": seedHostScopedDecoy(
      harness,
      "environment.secrets.rotation",
    ),
  };
}

function readCounts(
  harness: TeamPageHarness,
): Record<SecretReadMethod, number> {
  return {
    "environment.secrets.list": hostIdsOf(harness, "environment.secrets.list")
      .length,
    "environment.secrets.versions": hostIdsOf(
      harness,
      "environment.secrets.versions",
    ).length,
    "environment.secrets.rotation": hostIdsOf(
      harness,
      "environment.secrets.rotation",
    ).length,
  };
}

async function expectPoolReadsAfter(
  harness: TeamPageHarness,
  before: Record<SecretReadMethod, number>,
  extraVersionReads: number,
): Promise<void> {
  await waitFor(() => {
    for (const method of SECRET_READS) {
      expect(hostIdsOf(harness, method).length).toBeGreaterThan(
        before[method] +
          (method === "environment.secrets.versions" ? extraVersionReads : 0),
      );
    }
  });
  for (const method of SECRET_READS) {
    expect(new Set(hostIdsOf(harness, method))).toEqual(
      new Set([POOL_HOST_ID]),
    );
  }
}

function expectHostDecoysUntouched(
  harness: TeamPageHarness,
  keys: Record<SecretReadMethod, QueryKey>,
): void {
  for (const method of SECRET_READS) {
    const key = keys[method];
    expect(harness.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    expect(harness.queryClient.getQueryData(key)).toEqual({
      decoy: method,
    });
  }
}

async function waitForInitialReads(harness: TeamPageHarness): Promise<void> {
  await waitFor(() => {
    for (const method of SECRET_READS) {
      expect(hostIdsOf(harness, method)).not.toHaveLength(0);
    }
  });
  await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
}

async function openFilledApiKeyForm(): Promise<void> {
  fireEvent.click(await screen.findByTestId("secrets-add"));
  fireEvent.click(await screen.findByTestId("secret-kind-option-api_key"));
  fireEvent.change(await screen.findByTestId("secret-form-name"), {
    target: { value: "DATABASE_URL" },
  });
  fireEvent.change(screen.getByTestId("secret-form-hosts"), {
    target: { value: "db.example.test" },
  });
  fireEvent.change(screen.getByTestId("secret-form-value"), {
    target: { value: "db-secret-test-value" },
  });
  fireEvent.click(await screen.findByTestId("secret-form-continue"));
}

beforeAll(() => {
  settleProcessHostRpcTierPlan(poolEntry);
});

beforeEach(() => {
  openLinkMock.mockResolvedValue(undefined);
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useSelectionAuthorityStore.getState().reset();
  openLinkMock.mockReset();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

describe("secret writes on a build with a server pool", () => {
  it("reads versions and rotation through the real page with no active surface host", async () => {
    const harness = mountPage(
      stateWithSecret({ rotation: rotationFixture() }),
      {
        noSurfaceHost: true,
        includeProbe: false,
      },
    );
    expect(requireTeamHostClient().getActiveHostId()).toBeNull();

    expect(await screen.findByText("STRIPE_KEY")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    expect(await screen.findAllByTestId("secret-version")).toHaveLength(2);
    expect(await screen.findByTestId("secret-rotation-status")).toBeTruthy();

    for (const method of SECRET_READS) {
      expect(new Set(hostIdsOf(harness, method))).toEqual(
        new Set([POOL_HOST_ID]),
      );
    }
  });

  it("refreshes pool list, versions, and rotation after create", async () => {
    const harness = mountPage(stateWithSecret({}), undefined);
    const decoys = seedHostScopedDecoys(harness);
    await waitForInitialReads(harness);
    const before = readCounts(harness);

    await openFilledApiKeyForm();
    fireEvent.click(await screen.findByTestId("secret-save"));

    expect(await screen.findByText("DATABASE_URL")).toBeTruthy();
    await expectPoolReadsAfter(harness, before, 0);
    await waitFor(() =>
      expect(screen.getByTestId("pool-secret-list").textContent).toContain(
        "DATABASE_URL",
      ),
    );
    expectHostDecoysUntouched(harness, decoys);
  });

  it("refreshes pool list, versions, and rotation after replace", async () => {
    const harness = mountPage(stateWithSecret({}), undefined);
    const decoys = seedHostScopedDecoys(harness);
    await waitForInitialReads(harness);
    const before = readCounts(harness);

    fireEvent.click(await screen.findByTestId("secret-row-replace"));
    fireEvent.change(await screen.findByTestId("replace-secret-value"), {
      target: { value: "replacement-test-value" },
    });
    fireEvent.click(await screen.findByTestId("replace-secret-confirm"));

    await expectPoolReadsAfter(harness, before, 0);
    await waitFor(() => {
      expect(screen.getByTestId("pool-secret-version").textContent).toBe(
        "ver-3",
      );
      expect(screen.getByTestId("pool-secret-rotation").textContent).toBe(
        "rot-1",
      );
    });
    expectHostDecoysUntouched(harness, decoys);
  });

  it("refreshes pool list, versions, and rotation after Remove", async () => {
    const harness = mountPage(stateWithSecret({}), undefined);
    const decoys = seedHostScopedDecoys(harness);
    await waitForInitialReads(harness);
    const before = readCounts(harness);

    fireEvent.click(await screen.findByTestId("secret-row-remove"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect(await screen.findByTestId("removed-secret-row")).toBeTruthy();
    await expectPoolReadsAfter(harness, before, 0);
    await waitFor(() =>
      expect(screen.getByTestId("pool-secret-list").textContent).toContain(
        "STRIPE_KEY",
      ),
    );
    expectHostDecoysUntouched(harness, decoys);
  });

  it("refreshes pool list, versions, and rotation after Undo", async () => {
    const harness = mountPage(stateWithSecret({}), undefined);
    const decoys = seedHostScopedDecoys(harness);
    await waitForInitialReads(harness);
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    const rows = await screen.findAllByTestId("secret-version");
    const before = readCounts(harness);

    fireEvent.click(within(rows[1]).getByTestId("secret-version-undo"));

    await expectPoolReadsAfter(harness, before, 0);
    await waitFor(() => {
      expect(screen.getByTestId("pool-secret-version").textContent).toBe(
        "ver-1",
      );
      expect(screen.getByTestId("pool-secret-list").textContent).toContain(
        "STRIPE_KEY",
      );
    });
    expectHostDecoysUntouched(harness, decoys);
  });

  it("refreshes pool list, versions, and rotation after a removal retry", async () => {
    const pending = removal("cleanup_requested");
    const harness = mountPage(
      stateWithSecret({
        secrets: [],
        removed: [{ id: "sec-1", name: "STRIPE_KEY", removal: pending }],
        removal: pending,
      }),
      undefined,
    );
    const decoys = seedHostScopedDecoys(harness);
    await waitForInitialReads(harness);
    const before = readCounts(harness);
    const status = await screen.findByTestId("secret-removal-status");

    fireEvent.click(within(status).getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.queryByTestId("removed-secret-row")).toBeNull(),
    );
    await expectPoolReadsAfter(harness, before, 1);
    expectHostDecoysUntouched(harness, decoys);
  });
});
