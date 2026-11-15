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
  useHostBinding: () => requireTeamEnvironmentAuthnBinding(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
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
import { ConfigurationSourceBoundary } from "@/components/settings/environment/configuration-source-boundary";
import { SecretsPage } from "@/components/settings/secrets/secrets-page";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  hostIdsOf,
  mountTeamPageOnPoolBuild,
  poolSource,
  requireTeamEnvironmentAuthnBinding,
  requireTeamHostClient,
  resetTeamPageHarness,
  teamHostBoundary,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { useSecretsRead } from "@/hooks/environment/use-environment-secrets-calls";
import { SECRET_READS } from "@/lib/environment/delta-fed-reads";
import { SECRETS_EMPTY_TEXT } from "@/lib/sandboxes/secrets-page-copy";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import type { ReactNode } from "react";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  RETIRED_PROVIDER_VARIABLES,
  RETIRED_SECRET_ROW_FIELDS,
} from "@traycer/protocol/host/released-wire-rows";

const AT = Date.UTC(2026, 9, 20, 9, 30);
/** The revision poll's 5 seconds, and the time to see its answer re-read. */
const REVISION_POLL_WAIT_MS = 9_000;
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
  /** authn's configuration revision: it moves on every committed change. */
  revision: number;
}

function secretFixture(
  overrides: Partial<EnvironmentSecretV12>,
): EnvironmentSecretV12 {
  return {
    ...RETIRED_SECRET_ROW_FIELDS,
    providerVariables: [...RETIRED_PROVIDER_VARIABLES],
    secretId: "sec-1",
    name: "STRIPE_KEY",
    kind: "api_key",
    protocol: null,
    destinations: [],
    currentVersionId: "ver-2",
    revoked: false,
    updatedAt: AT,
    variables: [],
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
    revision: 1,
    ...overrides,
  };
}

function handlersFor(state: SecretHostState): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.list": () => ({
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
    }),
    "environment.configuration.revision": () => ({
      revision: String(state.revision),
    }),
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
      state.revision += 1;
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
      state.revision += 1;
      return { outcome: "accepted", rotationId: "rot-1", versionId: "ver-3" };
    },
    "environment.secrets.destroy": () => {
      const nextRemoval = removal(
        state.removed.length === 0 ? "revoked" : "destroyed",
      );
      state.removal = nextRemoval;
      state.revision += 1;
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
      state.revision += 1;
      return { outcome: "accepted", rotationId: "rot-2", versionId: "ver-1" };
    },
  };
}

/** Keeps each of the team's secret reads, authn's own, observed while an action runs. */
function SecretReadProbe(props: {
  readonly client: HostClient<HostRpcRegistry>;
}): ReactNode {
  const list = useSecretsRead({
    client: props.client,
    method: "environment.secrets.list",
    params: { environmentId: "env-a" },
    enabled: true,
    poll: false,
  });
  const versions = useSecretsRead({
    client: props.client,
    method: "environment.secrets.versions",
    params: { secretId: "sec-1", environmentId: "env-a" },
    enabled: true,
    poll: false,
  });
  const rotation = useSecretsRead({
    client: props.client,
    method: "environment.secrets.rotation",
    params: { secretId: "sec-1", environmentId: "env-a" },
    enabled: true,
    poll: false,
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
  // The boundary Settings mounts every team page in: its revision hook is what
  // re-reads the reads a committed change moved.
  render(
    <ConfigurationSourceBoundary
      section={null}
      target={{ kind: "team", environmentId: "env-a" }}
    >
      {options?.includeProbe === false ? (
        page
      ) : (
        <>
          {page}
          <SecretReadProbe client={client} />
        </>
      )}
    </ConfigurationSourceBoundary>,
    { wrapper: harness.Wrapper },
  );
  return harness;
}

function readCounts(
  harness: TeamPageHarness,
): Record<SecretReadMethod, number> {
  return {
    "environment.secrets.list": harness.paramsOf("environment.secrets.list")
      .length,
    "environment.secrets.versions": harness.paramsOf(
      "environment.secrets.versions",
    ).length,
    "environment.secrets.rotation": harness.paramsOf(
      "environment.secrets.rotation",
    ).length,
  };
}

/**
 * More reads of each secret method reached authn, and none reached a host. A
 * committed change moves authn's revision, which the boundary re-reads within
 * its 5 second poll and answers by re-reading what it moved.
 */
async function expectAuthnReadsAfter(
  harness: TeamPageHarness,
  before: Record<SecretReadMethod, number>,
  extraVersionReads: number,
): Promise<void> {
  await waitFor(
    () => {
      for (const method of SECRET_READS) {
        expect(harness.paramsOf(method).length).toBeGreaterThan(
          before[method] +
            (method === "environment.secrets.versions" ? extraVersionReads : 0),
        );
      }
    },
    { timeout: REVISION_POLL_WAIT_MS },
  );
  for (const method of SECRET_READS) {
    expect(hostIdsOf(harness, method)).toEqual([]);
  }
}

async function waitForInitialReads(harness: TeamPageHarness): Promise<void> {
  await waitFor(() => {
    for (const method of SECRET_READS) {
      expect(harness.paramsOf(method)).not.toHaveLength(0);
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
      expect(harness.paramsOf(method)).not.toHaveLength(0);
      expect(hostIdsOf(harness, method)).toEqual([]);
    }
  });

  it("refreshes pool list, versions, and rotation after create", async () => {
    const harness = mountPage(stateWithSecret({}), undefined);
    await waitForInitialReads(harness);
    const before = readCounts(harness);

    await openFilledApiKeyForm();
    fireEvent.click(await screen.findByTestId("secret-save"));

    expect(await screen.findByText("DATABASE_URL")).toBeTruthy();
    await expectAuthnReadsAfter(harness, before, 0);
    await waitFor(() =>
      expect(screen.getByTestId("pool-secret-list").textContent).toContain(
        "DATABASE_URL",
      ),
    );
  });

  it("refreshes pool list, versions, and rotation after replace", async () => {
    const harness = mountPage(stateWithSecret({}), undefined);
    await waitForInitialReads(harness);
    const before = readCounts(harness);

    fireEvent.click(await screen.findByTestId("secret-row-replace"));
    fireEvent.change(await screen.findByTestId("replace-secret-value"), {
      target: { value: "replacement-test-value" },
    });
    fireEvent.click(await screen.findByTestId("replace-secret-confirm"));

    await expectAuthnReadsAfter(harness, before, 0);
    await waitFor(() => {
      expect(screen.getByTestId("pool-secret-version").textContent).toBe(
        "ver-3",
      );
      expect(screen.getByTestId("pool-secret-rotation").textContent).toBe(
        "rot-1",
      );
    });
  });

  it("refreshes pool list, versions, and rotation after Remove", async () => {
    const harness = mountPage(stateWithSecret({}), undefined);
    await waitForInitialReads(harness);
    const before = readCounts(harness);

    fireEvent.click(await screen.findByTestId("secret-row-remove"));
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect(await screen.findByTestId("removed-secret-row")).toBeTruthy();
    await expectAuthnReadsAfter(harness, before, 0);
    await waitFor(() =>
      expect(screen.getByTestId("pool-secret-list").textContent).toContain(
        "STRIPE_KEY",
      ),
    );
  });

  it("refreshes pool list, versions, and rotation after Undo", async () => {
    const harness = mountPage(stateWithSecret({}), undefined);
    await waitForInitialReads(harness);
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    const rows = await screen.findAllByTestId("secret-version");
    const before = readCounts(harness);

    fireEvent.click(within(rows[1]).getByTestId("secret-version-undo"));

    await expectAuthnReadsAfter(harness, before, 0);
    await waitFor(() => {
      expect(screen.getByTestId("pool-secret-version").textContent).toBe(
        "ver-1",
      );
      expect(screen.getByTestId("pool-secret-list").textContent).toContain(
        "STRIPE_KEY",
      );
    });
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
    await waitForInitialReads(harness);
    const before = readCounts(harness);
    const status = await screen.findByTestId("secret-removal-status");

    fireEvent.click(within(status).getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.queryByTestId("removed-secret-row")).toBeNull(),
    );
    await expectAuthnReadsAfter(harness, before, 1);
  });
});
