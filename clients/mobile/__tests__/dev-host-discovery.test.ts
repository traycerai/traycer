import { describe, expect, it, vi, type Mock } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { AuthEra } from "@traycer-clients/shared/auth/request-context-provider";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostListItemToDirectoryEntry,
  type HostListFetchResult,
  type RemoteHostFetchOutcome,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  buildDevHostDiscovery,
  createDevHostRegistryMemory,
  fleetRowsOf,
  type DevHostRegistryMemory,
  type DevHostRegistrySource,
} from "../src/web/dev-host-discovery";

const RELAY_BASE_URL = "wss://relay.example.test/attach";
const SANDBOX_HOST_ID = "bc29447a-0000-4000-8000-d9157ce22442";
const DEV_HOST_ID = "dev-host-0000-4000-8000-loopback0001";
const ACCOUNT_ID = "user-signed-in";

const SIGNED_IN_ERA: AuthEra = {
  identity: "user-signed-in",
  credentialGeneration: 3,
};
const SIGNED_OUT_ERA: AuthEra = { identity: null, credentialGeneration: 4 };

/** The sandbox row, as the registry listed it in the field. */
const SANDBOX_ROW: HostListItem = {
  hostId: SANDBOX_HOST_ID,
  displayName: "kzsuhu35wfk9qapmtjlb5",
  platform: "linux-x64",
  kind: "sandbox",
  publicKey: "c2FuZGJveC1wdWJsaWMta2V5",
  createdAt: "2026-10-16T08:00:00.000Z",
  status: {
    connectivity: "connectable",
    clientCloud: "ok",
    updateState: "current",
    viewerReachability: "unknown",
    appVersion: null,
    lastSeenAt: null,
  },
  sandboxState: "awake",
  sandboxFrozen: false,
  profile: "agent",
  updatePolicy: "manual",
};

/** A registry row that is the dev host itself: same hostId, a personal host. */
const DEV_TWIN_ROW: HostListItem = {
  hostId: DEV_HOST_ID,
  displayName: "registry twin of the loopback dev host",
  platform: "darwin-arm64",
  kind: "personal",
  publicKey: "ZGV2LXR3aW4tcHVibGljLWtleQ==",
  createdAt: "2026-10-15T08:00:00.000Z",
  status: {
    connectivity: "connectable",
    clientCloud: "ok",
    updateState: "current",
    viewerReachability: "unknown",
    appVersion: "1.5.2",
    lastSeenAt: null,
  },
  updatePolicy: "manual",
};

const DEV_ENTRY: HostDirectoryEntry = {
  hostId: DEV_HOST_ID,
  label: "Local dev host",
  kind: "local",
  websocketUrl: "ws://127.0.0.1:41234/ws",
  version: "dev",
  transportDialability: "dialable",
};

const DEV_OUTCOME: RemoteHostFetchOutcome = {
  kind: "hosts",
  entries: [DEV_ENTRY],
};

interface RegistryHarness {
  readonly registry: DevHostRegistrySource;
  readonly listRegisteredHosts: Mock<
    (bearerToken: string) => Promise<HostListFetchResult>
  >;
}

function registryHarness(
  token: string | null,
  result: HostListFetchResult,
): RegistryHarness {
  return registryHarnessFor(
    token,
    ACCOUNT_ID,
    result,
    createDevHostRegistryMemory(),
  );
}

function registryHarnessFor(
  token: string | null,
  accountId: string,
  result: HostListFetchResult,
  memory: DevHostRegistryMemory,
): RegistryHarness {
  const listRegisteredHosts = vi
    .fn<(bearerToken: string) => Promise<HostListFetchResult>>()
    .mockResolvedValue(result);
  return {
    listRegisteredHosts,
    registry: {
      signIn: () =>
        Promise.resolve(
          token === null ? null : { bearerToken: token, accountId },
        ),
      listRegisteredHosts,
      relayBaseUrl: RELAY_BASE_URL,
      memory,
    },
  };
}

function okResult(hosts: HostListItem[]): HostListFetchResult {
  return { kind: "ok", response: { hosts } };
}

function hostEntriesOf(
  outcome: RemoteHostFetchOutcome,
): readonly HostDirectoryEntry[] {
  if (outcome.kind !== "hosts") {
    throw new Error(`expected a hosts outcome, got ${outcome.kind}`);
  }
  return outcome.entries;
}

describe("buildDevHostDiscovery", () => {
  it("lists a connectable registry sandbox after the dev host, dialed through the relay", async () => {
    const { registry, listRegisteredHosts } = registryHarness(
      "bearer-1",
      okResult([SANDBOX_ROW]),
    );
    const fetcher = buildDevHostDiscovery(
      () => Promise.resolve(DEV_OUTCOME),
      registry,
    );

    const outcome = await fetcher(SIGNED_IN_ERA);

    expect(listRegisteredHosts).toHaveBeenCalledExactlyOnceWith("bearer-1");
    const entries = hostEntriesOf(outcome);
    expect(entries[0]).toEqual(DEV_ENTRY);
    const sandbox = entries.find((entry) => entry.hostId === SANDBOX_HOST_ID);
    expect(sandbox).toBeDefined();
    expect(sandbox?.transportDialability).toBe("dialable");
    expect(sandbox?.websocketUrl).toBe(RELAY_BASE_URL);
    expect(sandbox).toEqual(
      hostListItemToDirectoryEntry(SANDBOX_ROW, RELAY_BASE_URL),
    );
  });

  it("drops the registry row that is the dev host itself, keeping the loopback entry", async () => {
    const { registry } = registryHarness(
      "bearer-1",
      okResult([DEV_TWIN_ROW, SANDBOX_ROW]),
    );
    const fetcher = buildDevHostDiscovery(
      () => Promise.resolve(DEV_OUTCOME),
      registry,
    );

    const entries = hostEntriesOf(await fetcher(SIGNED_IN_ERA));

    const twins = entries.filter((entry) => entry.hostId === DEV_HOST_ID);
    expect(twins).toEqual([DEV_ENTRY]);
    expect(twins[0]?.kind).toBe("local");
    expect(entries.map((entry) => entry.hostId)).toEqual([
      DEV_HOST_ID,
      SANDBOX_HOST_ID,
    ]);
  });

  it("keeps the dev host when the registry read hits a network error", async () => {
    const { registry, listRegisteredHosts } = registryHarness("bearer-1", {
      kind: "network-error",
    });
    const fetcher = buildDevHostDiscovery(
      () => Promise.resolve(DEV_OUTCOME),
      registry,
    );

    const outcome = await fetcher(SIGNED_IN_ERA);

    expect(listRegisteredHosts).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: "hosts", entries: [DEV_ENTRY] });
  });

  it("keeps the dev host when the registry rejects the bearer", async () => {
    const { registry, listRegisteredHosts } = registryHarness("bearer-1", {
      kind: "unauthorized",
    });
    const fetcher = buildDevHostDiscovery(
      () => Promise.resolve(DEV_OUTCOME),
      registry,
    );

    const outcome = await fetcher(SIGNED_IN_ERA);

    expect(listRegisteredHosts).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: "hosts", entries: [DEV_ENTRY] });
  });

  it("retains the last successfully read registry rows when a later read fails", async () => {
    const { registry, listRegisteredHosts } = registryHarness(
      "bearer-1",
      okResult([SANDBOX_ROW]),
    );
    const fetcher = buildDevHostDiscovery(
      () => Promise.resolve(DEV_OUTCOME),
      registry,
    );

    await fetcher(SIGNED_IN_ERA);
    listRegisteredHosts.mockResolvedValue({ kind: "network-error" });
    const outcome = await fetcher(SIGNED_IN_ERA);

    expect(listRegisteredHosts).toHaveBeenCalledTimes(2);
    const entries = hostEntriesOf(outcome);
    expect(entries[0]).toEqual(DEV_ENTRY);
    expect(entries.map((entry) => entry.hostId)).toEqual([
      DEV_HOST_ID,
      SANDBOX_HOST_ID,
    ]);
    const sandbox = entries.find((entry) => entry.hostId === SANDBOX_HOST_ID);
    expect(sandbox?.transportDialability).toBe("dialable");
  });

  it("never serves one account's retained rows to another account", async () => {
    const memory = createDevHostRegistryMemory();
    const first = registryHarnessFor(
      "bearer-a",
      "user-a",
      okResult([SANDBOX_ROW]),
      memory,
    );
    await buildDevHostDiscovery(
      () => Promise.resolve(DEV_OUTCOME),
      first.registry,
    )(SIGNED_IN_ERA);
    const second = registryHarnessFor(
      "bearer-b",
      "user-b",
      { kind: "network-error" },
      memory,
    );

    const outcome = await buildDevHostDiscovery(
      () => Promise.resolve(DEV_OUTCOME),
      second.registry,
    )(SIGNED_IN_ERA);

    expect(outcome).toEqual({ kind: "hosts", entries: [DEV_ENTRY] });
  });

  it("re-reads the dev host on a failed registry read", async () => {
    const movedDevEntry: HostDirectoryEntry = {
      ...DEV_ENTRY,
      websocketUrl: "ws://127.0.0.1:52999/ws",
    };
    const devHostFetch = vi
      .fn<() => Promise<RemoteHostFetchOutcome>>()
      .mockResolvedValueOnce(DEV_OUTCOME)
      .mockResolvedValueOnce({ kind: "hosts", entries: [movedDevEntry] });
    const { registry, listRegisteredHosts } = registryHarness(
      "bearer-1",
      okResult([SANDBOX_ROW]),
    );
    const fetcher = buildDevHostDiscovery(devHostFetch, registry);

    await fetcher(SIGNED_IN_ERA);
    listRegisteredHosts.mockResolvedValue({ kind: "network-error" });
    const outcome = await fetcher(SIGNED_IN_ERA);

    expect(devHostFetch).toHaveBeenCalledTimes(2);
    const entries = hostEntriesOf(outcome);
    expect(entries[0]).toEqual(movedDevEntry);
    expect(entries[0]?.websocketUrl).toBe("ws://127.0.0.1:52999/ws");
  });

  it("returns the dev host alone, with no registry call, in a signed-out era", async () => {
    const { registry, listRegisteredHosts } = registryHarness(
      "bearer-1",
      okResult([SANDBOX_ROW]),
    );
    const fetcher = buildDevHostDiscovery(
      () => Promise.resolve(DEV_OUTCOME),
      registry,
    );

    const outcome = await fetcher(SIGNED_OUT_ERA);

    expect(outcome).toEqual(DEV_OUTCOME);
    expect(listRegisteredHosts).not.toHaveBeenCalled();
  });

  it("returns the dev host alone, with no registry call, when no bearer is stored", async () => {
    const { registry, listRegisteredHosts } = registryHarness(
      null,
      okResult([SANDBOX_ROW]),
    );
    const fetcher = buildDevHostDiscovery(
      () => Promise.resolve(DEV_OUTCOME),
      registry,
    );

    const outcome = await fetcher(SIGNED_IN_ERA);

    expect(outcome).toEqual(DEV_OUTCOME);
    expect(listRegisteredHosts).not.toHaveBeenCalled();
  });
});

describe("fleetRowsOf", () => {
  it("marks the registry sandbox as a sandbox and the loopback dev host as not", async () => {
    const { registry } = registryHarness("bearer-1", okResult([SANDBOX_ROW]));
    const fetcher = buildDevHostDiscovery(
      () => Promise.resolve(DEV_OUTCOME),
      registry,
    );

    const rows = fleetRowsOf(await fetcher(SIGNED_IN_ERA));

    expect(rows).toEqual([
      { hostId: DEV_HOST_ID, sandbox: false, teamOwned: false },
      { hostId: SANDBOX_HOST_ID, sandbox: true, teamOwned: false },
    ]);
  });

  it("yields no fleet for a failed outcome", () => {
    expect(fleetRowsOf({ kind: "failed" })).toBeNull();
  });
});
