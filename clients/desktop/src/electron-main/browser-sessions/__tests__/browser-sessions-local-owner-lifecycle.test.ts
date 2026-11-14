import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import type { BrowserSessionsServerFrame } from "@traycer/protocol/host/browser/contracts";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenMintOutcome,
} from "@traycer-clients/shared/auth/host-token-source";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostListFetchResult } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { BrowserSessionsHostTransport } from "../browser-sessions-transport";
import { createBrowserSessionsHostDirectory } from "../browser-sessions-transport";
import { openBrowserSessionsTransport } from "../browser-sessions-transport";
import { BrowserSessionsRegistry } from "../browser-sessions-owner";
import {
  createRegistryHarness,
  FakeStreamClient,
  hostListResultForOwner,
} from "./browser-sessions-stream-fixture";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

const localWsClients = vi.hoisted(() => ({ clients: [] as unknown[] }));
vi.mock("@traycer-clients/shared/host-transport/ws-stream-client", async () => {
  const { FakeStreamClient } =
    await import("@traycer-clients/shared/host-transport/__testing__/fake-stream-client");
  return {
    WsStreamClient: class extends FakeStreamClient {
      constructor(_options: unknown) {
        super(false);
        localWsClients.clients.push(this);
      }
    },
  };
});

const LOCAL_HOST_ID = "host-local";
const WINDOW_ID = "window-1";
const OPEN_REQUEST = {
  scope: { kind: "epic", epicId: "epic-1" } as const,
  hostId: LOCAL_HOST_ID,
  identityKey: "identity-1",
};
const PERSONAL_OWNER: HostOwnerPrincipal = { kind: "user", id: "user-1" };
const TEAM_OWNER: HostOwnerPrincipal = {
  kind: "team",
  id: "team-1",
  name: "Team One",
};
const SNAPSHOT: BrowserSessionsServerFrame = {
  kind: "snapshot",
  hasBinaryPayload: false,
  sessions: [],
};

const BEARER: BearerSourceProvider = () => ({
  getBearerToken: () => "bearer-token",
  identity: { userId: "user-1" },
});
const HOST_TOKENS = createHostTokenSource({
  persistence: createMemoryHostTokenPersistence(),
  mint: (): Promise<HostTokenMintOutcome> =>
    Promise.resolve({ kind: "no-sign-in" }),
  signIn: null,
  now: () => Date.now(),
});
const TRANSPORT_DEPS = {
  authnBaseUrl: () => "https://authn.test",
  bearer: BEARER,
  cloudAuthorized: () => true,
  endpoint: () => null,
  appVersion: "1.5.0",
  hostTokens: HOST_TOKENS,
};

interface LocalOwnerHarness {
  readonly pendingListings: Array<(result: HostListFetchResult) => void>;
  readonly listRegisteredHosts: ReturnType<typeof vi.fn>;
  readonly directory: ReturnType<typeof createBrowserSessionsHostDirectory>;
  readonly registry: BrowserSessionsRegistry;
  readonly openedTransports: BrowserSessionsHostTransport[];
  readonly openTransport: ReturnType<typeof vi.fn>;
}

function createLocalOwnerHarness(): LocalOwnerHarness {
  const pendingListings: Array<(result: HostListFetchResult) => void> = [];
  const listRegisteredHosts = vi.fn(
    (_authnBaseUrl: string, _bearer: string) =>
      new Promise<HostListFetchResult>((resolve) => {
        pendingListings.push(resolve);
      }),
  );
  const directory = createBrowserSessionsHostDirectory({
    authnBaseUrl: () => "https://authn.test",
    relayBaseUrl: "wss://relay.test/attach",
    localHost: () => ({
      hostId: LOCAL_HOST_ID,
      websocketUrl: "ws://127.0.0.1:4455/ws",
      version: "1.5.0",
    }),
    bearerToken: () => "bearer-token",
    listRegisteredHosts,
    now: () => 1_000_000,
  });
  const appHarness = createRegistryHarness();
  const openedTransports: BrowserSessionsHostTransport[] = [];
  const openTransport = vi.fn((target: HostDirectoryEntry, userId: string) => {
    const transport = openBrowserSessionsTransport(
      target,
      userId,
      TRANSPORT_DEPS,
    );
    if (transport !== null) openedTransports.push(transport);
    return transport;
  });
  const registry = new BrowserSessionsRegistry({
    ...appHarness.deps,
    directory,
    openTransport,
    localHostId: () => LOCAL_HOST_ID,
  });

  return {
    pendingListings,
    listRegisteredHosts,
    directory,
    registry,
    openedTransports,
    openTransport,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function openLiveLocalStream(harness: LocalOwnerHarness): Promise<{
  readonly client: FakeStreamClient;
  readonly session: FakeStreamClient["sessions"][number];
}> {
  harness.registry.open(WINDOW_ID, OPEN_REQUEST);
  await settle();
  const client = localWsClients.clients.at(-1) as FakeStreamClient | undefined;
  if (client === undefined)
    throw new Error("the local transport was not opened");
  const session = client.sessions[0];
  if (session === undefined)
    throw new Error("the browser.sessions stream was not subscribed");
  session.emitStatus("open");
  session.emit(SNAPSHOT, null);
  return { client, session };
}

function resolveListing(
  harness: LocalOwnerHarness,
  owner: HostOwnerPrincipal,
  index = 0,
): void {
  const resolve = harness.pendingListings[index];
  if (resolve === undefined)
    throw new Error(`no registry listing ${index} is pending`);
  resolve(hostListResultForOwner(LOCAL_HOST_ID, owner));
}

const activeRegistries: BrowserSessionsRegistry[] = [];
afterEach(() => {
  for (const registry of activeRegistries.splice(0)) registry.dispose();
  localWsClients.clients.length = 0;
});

describe("local browser.sessions ownership changes", () => {
  it("keeps the same live stream when unknown ownership becomes personal", async () => {
    const harness = createLocalOwnerHarness();
    activeRegistries.push(harness.registry);
    const { client, session } = await openLiveLocalStream(harness);

    expect(harness.listRegisteredHosts).toHaveBeenCalledTimes(1);
    expect(harness.openTransport).toHaveBeenCalledTimes(1);
    expect(harness.directory.peek(LOCAL_HOST_ID)?.owner).toBeNull();

    resolveListing(harness, PERSONAL_OWNER);
    await settle();

    expect(harness.directory.peek(LOCAL_HOST_ID)?.owner).toEqual(
      PERSONAL_OWNER,
    );
    expect(harness.openTransport).toHaveBeenCalledTimes(1);
    expect(harness.openedTransports).toHaveLength(1);
    expect(client.isClosed()).toBe(false);
    expect(session.closed).toBe(false);
  });

  it("retires the same live stream when unknown ownership becomes team", async () => {
    const harness = createLocalOwnerHarness();
    activeRegistries.push(harness.registry);
    const { client, session } = await openLiveLocalStream(harness);

    resolveListing(harness, TEAM_OWNER);
    await settle();

    expect(harness.directory.peek(LOCAL_HOST_ID)?.owner).toEqual(TEAM_OWNER);
    expect(harness.openTransport).toHaveBeenCalledTimes(1);
    expect(harness.openedTransports).toHaveLength(1);
    expect(client.isClosed()).toBe(true);
    expect(session.closed).toBe(true);
  });

  it("retires a personal stream when its owner changes to team", async () => {
    const harness = createLocalOwnerHarness();
    activeRegistries.push(harness.registry);

    await harness.directory.resolve(LOCAL_HOST_ID);
    resolveListing(harness, PERSONAL_OWNER);
    await settle();
    expect(harness.directory.peek(LOCAL_HOST_ID)?.owner).toEqual(
      PERSONAL_OWNER,
    );

    const { client, session } = await openLiveLocalStream(harness);
    expect(harness.openTransport).toHaveBeenCalledTimes(1);

    harness.directory.invalidate(LOCAL_HOST_ID);
    await harness.directory.resolve(LOCAL_HOST_ID);
    expect(harness.pendingListings).toHaveLength(2);
    resolveListing(harness, TEAM_OWNER, 1);
    await settle();

    expect(harness.directory.peek(LOCAL_HOST_ID)?.owner).toEqual(TEAM_OWNER);
    expect(harness.openTransport).toHaveBeenCalledTimes(1);
    expect(harness.openedTransports).toHaveLength(1);
    expect(client.isClosed()).toBe(true);
    expect(session.closed).toBe(true);
  });

  it("opens the local jar stream while the cold registry read stays pending", async () => {
    const harness = createLocalOwnerHarness();
    activeRegistries.push(harness.registry);

    const { client, session } = await openLiveLocalStream(harness);

    expect(harness.listRegisteredHosts).toHaveBeenCalledTimes(1);
    expect(harness.pendingListings).toHaveLength(1);
    expect(harness.openTransport).toHaveBeenCalledTimes(1);
    expect(harness.openedTransports).toHaveLength(1);
    expect(client.isClosed()).toBe(false);
    expect(session.closed).toBe(false);
  });
});
