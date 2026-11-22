import { RECONNECT_MAX_BACKOFF_MS } from "@traycer/protocol/host-transport/remote/config";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenMintOutcome,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import { defineVersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { defineVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { HostToken } from "@traycer-clients/shared/auth/host-token-store";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { retireAllRemoteSessions } from "@traycer-clients/shared/host-transport/remote/active-remote-sessions";
import { createRemoteHostTransport } from "@traycer-clients/shared/host-transport/remote/create-remote-transport";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { createDesktopHostTokenSource } from "../../../renderer-shell/desktop-host-tokens";
import {
  NO_ISSUED_HOST_TOKEN_ERA,
  type HostTokenBridgeChange,
  type HostTokensBridgeSurface,
} from "../../../ipc-contracts/host-token-types";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../../ipc-contracts/ipc-channels";
import { registerAuthIpc } from "../auth-ipc";
import {
  RunnerIpcBridge,
  type IpcHostLifecycle,
  type IpcManagedWindow,
} from "../runner-ipc-bridge";
import {
  buildStoredCredentials,
  FakeAuthTokenStore,
} from "./fake-auth-token-store";
import { FakeHostController } from "./fake-host-controller";

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("@sentry/electron/main", () => ({
  init: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

type InvokeHandler = (
  event: unknown,
  ...args: unknown[]
) => unknown | Promise<unknown>;

const handlers = vi.hoisted(() => new Map<string, InvokeHandler>());

vi.mock("electron", () => ({
  app: { getVersion: (): string => "1.0.0", getPath: (): string => "/tmp" },
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler): void => {
      handlers.set(channel, handler);
    },
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
  shell: {},
}));

/** The lifecycle `registerAuthIpc` never reads: a bridge needs one to exist. */
class IdleHost extends EventEmitter implements IpcHostLifecycle {
  readonly pidMetadataFile = "/tmp/idle-host/pid.json";
  readonly identityEnrollmentFile = "/tmp/idle-host/enrollment.json";
  readonly isDisposed = false;
  getSnapshot(): null {
    return null;
  }
  notifyRespawning(): void {}
  async reloadSnapshotFromDisk(): Promise<null> {
    return null;
  }
  noteEndpointAnswered(): void {}
  ensureWatcherInstalled(): void {}
  async getRecentLogTail(): Promise<null> {
    return null;
  }
}

const window: IpcManagedWindow = {
  isDestroyed: () => false,
  isFocused: () => true,
  isVisible: () => true,
  show: (): void => {},
  focus: (): void => {},
  webContents: { send: (): void => {} },
};

/** The single-window shell's one trusted renderer (web contents id 0). */
const RENDERER = { sender: { id: 0 }, senderFrame: { parent: null } };

const TOKEN_B1 = { token: "token-of-b", expiresAtMs: 9_000_000_000 };
const TOKEN_A1 = { token: "token-a-host-1", expiresAtMs: 9_000_000_000 };
const TOKEN_A2 = { token: "token-a-host-2", expiresAtMs: 9_000_000_000 };

async function heldTokens(): Promise<HostTokenSource> {
  const tokens = createHostTokenSource({
    persistence: createMemoryHostTokenPersistence(),
    mint: () => Promise.resolve({ kind: "no-sign-in" }),
    signIn: null,
    now: () => Date.now(),
  });
  await tokens.adopt(
    "user-a",
    "host-1",
    TOKEN_A1,
    tokens.era("user-a"),
    () => true,
  );
  await tokens.adopt(
    "user-a",
    "host-2",
    TOKEN_A2,
    tokens.era("user-a"),
    () => true,
  );
  await tokens.adopt(
    "user-b",
    "host-1",
    TOKEN_B1,
    tokens.era("user-b"),
    () => true,
  );
  return tokens;
}

function registerFor(
  tokens: HostTokenSource,
  signedInUserId: string | null,
): void {
  registerForWindow(tokens, signedInUserId, window);
}

function registerForWindow(
  tokens: HostTokenSource,
  signedInUserId: string | null,
  target: IpcManagedWindow,
): void {
  registerAuthIpc(
    new RunnerIpcBridge({
      host: new IdleHost(),
      hostController: new FakeHostController(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      hostTokens: tokens,
      authTokenStore: new FakeAuthTokenStore(async () =>
        signedInUserId === null
          ? null
          : buildStoredCredentials(signedInUserId, "sign-in-token"),
      ),
      window: target,
    }),
  );
}

function snapshot(): unknown {
  const handler = handlers.get(RunnerHostInvoke.hostTokensSnapshot);
  if (handler === undefined) throw new Error("snapshot handler not registered");
  return handler(RENDERER);
}

beforeEach(() => {
  handlers.clear();
});

afterEach(() => {
  handlers.clear();
  processReleasedHosts.forgetAll();
});

describe("the hostTokensSnapshot handler", () => {
  it("answers the tokens main holds for the person signed in there, and no one else's", async () => {
    const tokens = await heldTokens();
    registerFor(tokens, "user-a");

    const reply = await snapshot();

    expect(reply).toEqual({
      userId: "user-a",
      era: tokens.era("user-a"),
      tokens: [
        { hostId: "host-1", token: TOKEN_A1 },
        { hostId: "host-2", token: TOKEN_A2 },
      ],
    });
  });

  it("answers no token and no person while no one is signed in, though main holds some", async () => {
    const tokens = await heldTokens();
    registerFor(tokens, null);

    await expect(snapshot()).resolves.toEqual({
      userId: null,
      era: NO_ISSUED_HOST_TOKEN_ERA,
      tokens: [],
    });
  });
});

/** A source whose table writes can be held, as a slow disk would. */
function sourceWithHoldableWrites(): {
  readonly source: HostTokenSource;
  readonly writes: () => number;
  /** Holds every write from now on, until `release`. */
  readonly hold: () => void;
  /** Holds only the next write; later writes pass, until `release`. */
  readonly holdNextWrite: () => void;
  readonly release: () => void;
} {
  const inner = createMemoryHostTokenPersistence();
  let writes = 0;
  let holding = false;
  let holdingNext = false;
  let release: () => void = () => undefined;
  let gate = Promise.resolve();
  const source = createHostTokenSource({
    persistence: {
      load: () => inner.load(),
      update: async (change) => {
        writes += 1;
        if (holding || holdingNext) {
          holdingNext = false;
          await gate;
        }
        return inner.update(change);
      },
    },
    mint: () => Promise.resolve({ kind: "no-sign-in" }),
    signIn: null,
    now: () => Date.now(),
  });
  const newGate = (): void => {
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  return {
    source,
    writes: () => writes,
    hold: () => {
      holding = true;
      newGate();
    },
    holdNextWrite: () => {
      holdingNext = true;
      newGate();
    },
    release: () => {
      holding = false;
      release();
    },
  };
}

function adoptHandler(): InvokeHandler {
  const handler = handlers.get(RunnerHostInvoke.hostTokensAdopt);
  if (handler === undefined) throw new Error("adopt handler not registered");
  return handler;
}

describe("the hostTokensAdopt handler", () => {
  const HELD = { token: "held-host-token", expiresAtMs: 9_000_000_000 };
  const SENT = { token: "sent-host-token", expiresAtMs: 9_000_000_000 };

  it("keeps the held token and announces nothing when main observes another host process between the window's send and the write", async () => {
    const hostId = "host-adopt-replaced-before-write";
    const rig = sourceWithHoldableWrites();
    const tokens = rig.source;
    await tokens.adopt(
      "user-a",
      hostId,
      HELD,
      tokens.era("user-a"),
      () => true,
    );
    processReleasedHosts.observeInstance(hostId, "100");
    registerFor(tokens, "user-a");
    const announced: string[] = [];
    tokens.subscribe((change) => announced.push(change.hostId));
    const writesBeforeSend = rig.writes();
    rig.hold();

    const adopting = adoptHandler()(
      RENDERER,
      "user-a",
      hostId,
      SENT,
      tokens.era("user-a"),
      { observed: "100" },
    );
    await vi.waitFor(() => expect(rig.writes()).toBe(writesBeforeSend + 1));
    processReleasedHosts.observeInstance(hostId, "200");
    rig.release();
    await adopting;

    expect(tokens.current("user-a", hostId)).toEqual(HELD);
    expect(announced).toEqual([]);
  });

  it("stores the token main was sent for the same host process, and the retired attempt's relay leg dials nothing with it, when the window retires the attempt after the send", async () => {
    const hostId = "host-adopt-attempt-retired-after-send";
    const rig = sourceWithHoldableWrites();
    const main = rig.source;
    processReleasedHosts.observeInstance(hostId, "100");
    registerFor(main, "user-a");
    const bridge: HostTokensBridgeSurface = {
      era: (userId) => main.era(userId),
      obtain: async () => ({
        outcome: { kind: "no-sign-in" },
        era: 0,
        held: false,
      }),
      renew: async () => ({ renewal: { kind: "no-sign-in" }, era: 0 }),
      adopt: async (userId, hostId, token, expectedEra, owner) => {
        // Main's real handler, over the same arguments the IPC carries.
        const reply: unknown = await adoptHandler()(
          RENDERER,
          userId,
          hostId,
          token,
          expectedEra,
          owner,
        );
        return {
          era: Reflect.get(Object(reply), "era"),
          kept: Reflect.get(Object(reply), "kept") === true,
        };
      },
      forgetUser: async (userId) => ({ era: main.era(userId) }),
      snapshot: async () => ({
        userId: null,
        era: NO_ISSUED_HOST_TOKEN_ERA,
        tokens: [],
      }),
      subscribe: () => ({ dispose: () => undefined }),
    };
    const windowTokens = createDesktopHostTokenSource(bridge);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              grant: "relay-pass",
              role: "client",
              expires_in: 300,
              session_grant: "minted-host-token",
              session_grant_expires_in: 3_600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reports: string[] = [];
    const socketsCreated: string[] = [];
    vi.useFakeTimers();
    rig.hold();
    const built = createRemoteHostTransport({
      clientIdentity: TEST_CLIENT_IDENTITY,
      opensReleasedWay: () => false,
      confirmRowBeforeSignIn: null,
      hostId,
      userId: "user-a",
      relayAttachUrl: "wss://relay.invalid/attach",
      authnBaseUrl: "https://authn.invalid",
      hostPublicKey: "ab".repeat(32),
      bearer: () => ({
        getBearerToken: () => "sign-in-token",
        identity: { userId: "user-a" },
      }),
      hostTokens: windowTokens,
      door: null,
      onState: (_hostId, state) => reports.push(state),
      cloudAuthorized: () => true,
      auth: null,
      clock: null,
      rpcRegistry: defineVersionedRpcRegistry({}),
      streamRegistry: defineVersionedStreamRpcRegistry({}),
      webSocketFactory: {
        create: (url) => {
          socketsCreated.push(url);
          throw new Error("the retired attempt must dial nothing");
        },
      },
      requestId: () => "req-1",
      proactiveWakeEligible: true,
      evidence: NO_TRANSPORT_EVIDENCE,
    });
    if (built === null) throw new Error("expected a built remote transport");
    try {
      built.session.start();
      await vi.waitFor(() => expect(rig.writes()).toBe(1));

      built.session.close();
      retireAllRemoteSessions();
      rig.release();

      await vi.waitFor(() =>
        expect(main.current("user-a", hostId)?.token).toBe("minted-host-token"),
      );
      // Past the longest redial backoff: no later dial or report either.
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_BACKOFF_MS);
      expect(socketsCreated).toEqual([]);
      expect(reports).toEqual([]);
    } finally {
      vi.useRealTimers();
      retireAllRemoteSessions();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});

function invokeHandler(channel: string): InvokeHandler {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} not registered`);
  return handler;
}

/**
 * One window's source over `main`, through main's real handlers: what the
 * window asks and adopts crosses as the IPC carries it, and every change main
 * announces reaches the window as the bridge's change event.
 */
function windowOverMain(main: HostTokenSource): HostTokenSource {
  let onChange: ((change: HostTokenBridgeChange) => void) | null = null;
  main.subscribe(({ userId, hostId, replaced }) => {
    onChange?.({
      userId,
      hostId,
      token: main.current(userId, hostId),
      era: main.era(userId),
      replaced,
    });
  });
  const bridge: HostTokensBridgeSurface = {
    era: (userId) => main.era(userId),
    obtain: async (userId, hostId, fresh, expectedEra, owner) => {
      const reply: unknown = await invokeHandler(
        RunnerHostInvoke.hostTokensObtain,
      )(RENDERER, userId, hostId, fresh, expectedEra, owner);
      return {
        outcome: Reflect.get(Object(reply), "outcome"),
        held: Reflect.get(Object(reply), "held") === true,
        era: Reflect.get(Object(reply), "era"),
      };
    },
    renew: async (userId) => ({
      renewal: { kind: "already-current" },
      era: main.era(userId),
    }),
    adopt: async (userId, hostId, token, expectedEra, owner) => {
      const reply: unknown = await invokeHandler(
        RunnerHostInvoke.hostTokensAdopt,
      )(RENDERER, userId, hostId, token, expectedEra, owner);
      return {
        kept: Reflect.get(Object(reply), "kept") === true,
        era: Reflect.get(Object(reply), "era"),
      };
    },
    forgetUser: async (userId) => {
      await main.forgetUser(userId);
      return { era: main.era(userId) };
    },
    snapshot: async () => ({
      userId: null,
      era: NO_ISSUED_HOST_TOKEN_ERA,
      tokens: [],
    }),
    subscribe: (next) => {
      onChange = next;
      return { dispose: () => undefined };
    },
  };
  return createDesktopHostTokenSource(bridge);
}

/** A host-only token shaped as authn issues it: a JWT whose `iat` says when. */
function issuedAt(label: string, issuedAtSeconds: number): HostToken {
  const payload = Buffer.from(
    JSON.stringify({ iat: issuedAtSeconds, jti: label }),
  ).toString("base64url");
  return { token: `header.${payload}.signature`, expiresAtMs: 9_000_000_000 };
}

describe("a window's copy of what main wrote", () => {
  const OLDER = issuedAt("older", 1_000);
  const NEWER = issuedAt("newer", 2_000);

  it("does not install an adopted token main declined because the host process was replaced before the write", async () => {
    const hostId = "host-window-declined-adopt";
    const rig = sourceWithHoldableWrites();
    processReleasedHosts.observeInstance(hostId, "100");
    registerFor(rig.source, "user-a");
    const window = windowOverMain(rig.source);
    await window.whenLoaded();
    rig.hold();

    const adopting = window.adopt(
      "user-a",
      hostId,
      NEWER,
      window.era("user-a"),
      () => true,
    );
    await vi.waitFor(() => expect(rig.writes()).toBe(1));
    processReleasedHosts.observeInstance(hostId, "200");
    rig.release();

    await expect(adopting).resolves.toBe(false);
    expect(window.current("user-a", hostId)).toBeNull();
    expect(rig.source.current("user-a", hostId)).toBeNull();
  });

  it("does not install a minted token main declined for a host process replaced while its mint ran", async () => {
    const hostId = "host-window-declined-mint";
    const requests: Array<(outcome: HostTokenMintOutcome) => void> = [];
    const main = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () =>
        new Promise<HostTokenMintOutcome>((resolve) => {
          requests.push(resolve);
        }),
      signIn: (userId) => (userId === "user-a" ? "sign-in-token" : null),
      now: () => Date.now(),
    });
    processReleasedHosts.observeInstance(hostId, "100");
    registerFor(main, "user-a");
    const window = windowOverMain(main);
    await window.whenLoaded();

    const asking = window.obtain("user-a", hostId, true, {
      signal: null,
      owner: { hostId, observed: "100" },
      observedNow: () => "100",
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    processReleasedHosts.observeInstance(hostId, "200");
    requests[0]({ kind: "ok", token: NEWER });
    await asking;

    expect(main.current("user-a", hostId)).toBeNull();
    expect(window.current("user-a", hostId)).toBeNull();
  });

  it("leaves both windows and main at the later-issued token when the earlier-issued one's adopt reaches main last, for a host only the relay reaches", async () => {
    const hostId = "host-relay-only-two-windows";
    const rig = sourceWithHoldableWrites();
    registerFor(rig.source, "user-a");
    const windowA = windowOverMain(rig.source);
    const windowB = windowOverMain(rig.source);
    await Promise.all([windowA.whenLoaded(), windowB.whenLoaded()]);
    rig.holdNextWrite();

    const earlier = windowA.adopt(
      "user-a",
      hostId,
      OLDER,
      windowA.era("user-a"),
      () => true,
    );
    await vi.waitFor(() => expect(rig.writes()).toBe(1));
    await windowB.adopt(
      "user-a",
      hostId,
      NEWER,
      windowB.era("user-a"),
      () => true,
    );
    rig.release();
    await earlier;

    expect(rig.source.current("user-a", hostId)).toEqual(NEWER);
    expect(windowA.current("user-a", hostId)).toEqual(NEWER);
    expect(windowB.current("user-a", hostId)).toEqual(NEWER);
  });

  it("answers process-replaced and records nothing when the window asks for a host process main no longer observes, and mints for the process the window observes next", async () => {
    const hostId = "host-window-out-of-sync";
    let mints = 0;
    const main = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => {
        mints += 1;
        return Promise.resolve({ kind: "ok", token: OLDER });
      },
      signIn: (userId) => (userId === "user-a" ? "sign-in-token" : null),
      now: () => Date.now(),
    });
    // Main observes the replacement before the window does.
    processReleasedHosts.observeInstance(hostId, "process-b");
    registerFor(main, "user-a");
    const window = windowOverMain(main);
    await window.whenLoaded();
    const staleOwner = { hostId, observed: "process-a" };

    await expect(
      window.obtain("user-a", hostId, true, {
        signal: null,
        owner: staleOwner,
        observedNow: () => "process-a",
      }),
    ).resolves.toEqual({ kind: "process-replaced" });
    expect(mints).toBe(0);
    expect(window.lastFailureOf("user-a", staleOwner)).toBeNull();

    const nextOwner = { hostId, observed: "process-b" };
    await expect(
      window.obtain("user-a", hostId, true, {
        signal: null,
        owner: nextOwner,
        observedNow: () => "process-b",
      }),
    ).resolves.toEqual({ kind: "ok", token: OLDER });
    expect(mints).toBe(1);
  });

  it("installs the token main held for a single window's obtain and adopt, as before", async () => {
    const hostId = "host-single-window-guard";
    const main = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      mint: () => Promise.resolve({ kind: "ok", token: OLDER }),
      signIn: (userId) => (userId === "user-a" ? "sign-in-token" : null),
      now: () => Date.now(),
    });
    registerFor(main, "user-a");
    const window = windowOverMain(main);
    await window.whenLoaded();

    await expect(
      window.obtain("user-a", hostId, true, { signal: null, owner: null }),
    ).resolves.toEqual({ kind: "ok", token: OLDER });
    expect(window.current("user-a", hostId)).toEqual(OLDER);

    await expect(
      window.adopt("user-a", hostId, NEWER, window.era("user-a"), () => true),
    ).resolves.toBe(true);
    expect(window.current("user-a", hostId)).toEqual(NEWER);
    expect(main.current("user-a", hostId)).toEqual(NEWER);
  });
});

/** An unsigned token with the issue second authn's `iat` carries, the one the tokens are ordered by. */
function tokenIssuedAt(label: string, iatSeconds: number): HostToken {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return {
    token: `${encode({ alg: "none" })}.${encode({ iat: iatSeconds, label })}.`,
    expiresAtMs: 9_000_000_000_000,
  };
}

function isBridgeChange(value: unknown): value is HostTokenBridgeChange {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "userId") === "string" &&
    typeof Reflect.get(value, "hostId") === "string" &&
    typeof Reflect.get(value, "era") === "number"
  );
}

describe("main's broadcast of a kept host-token write", () => {
  const USER = "user-a";
  const HOST = "host-refused-token";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Two windows over main's real handlers and main's real broadcast: every
   * change main announces reaches each window as the payload `fanOut` sent,
   * and what a window asks or snapshots crosses as the IPC carries it.
   */
  function twoWindowsOverMain(main: HostTokenSource): {
    readonly windows: readonly [HostTokenSource, HostTokenSource];
  } {
    const subscribers = new Set<(change: HostTokenBridgeChange) => void>();
    const broadcasting: IpcManagedWindow = {
      ...window,
      webContents: {
        send: (channel: string, payload: unknown): void => {
          if (channel !== RunnerHostEvent.hostTokensChange) return;
          if (!isBridgeChange(payload)) throw new Error("malformed change");
          for (const subscriber of Array.from(subscribers)) subscriber(payload);
        },
      },
    };
    registerForWindow(main, USER, broadcasting);
    const windowOver = (): HostTokenSource =>
      createDesktopHostTokenSource({
        era: (userId) => main.era(userId),
        obtain: async (userId, hostId, fresh, expectedEra, owner) => {
          const reply: unknown = await invokeHandler(
            RunnerHostInvoke.hostTokensObtain,
          )(RENDERER, userId, hostId, fresh, expectedEra, owner);
          return {
            outcome: Reflect.get(Object(reply), "outcome"),
            held: Reflect.get(Object(reply), "held") === true,
            era: Reflect.get(Object(reply), "era"),
          };
        },
        renew: async (userId) => ({
          renewal: { kind: "already-current" },
          era: main.era(userId),
        }),
        adopt: async () => ({ kept: false, era: NO_ISSUED_HOST_TOKEN_ERA }),
        forgetUser: async (userId) => ({ era: main.era(userId) }),
        snapshot: async () => {
          const reply: unknown = await invokeHandler(
            RunnerHostInvoke.hostTokensSnapshot,
          )(RENDERER);
          return {
            userId: Reflect.get(Object(reply), "userId"),
            era: Reflect.get(Object(reply), "era"),
            tokens: Reflect.get(Object(reply), "tokens"),
          };
        },
        subscribe: (next) => {
          subscribers.add(next);
          return { dispose: () => subscribers.delete(next) };
        },
      });
    return { windows: [windowOver(), windowOver()] };
  }

  it("makes a sibling window drop the refused token for the older-issued one main kept, as the asking window does", async () => {
    const refused = tokenIssuedAt("refused", 2_000);
    const reissued = tokenIssuedAt("reissued", 1_990);
    const main = createHostTokenSource({
      persistence: createMemoryHostTokenPersistence(),
      // authn issues the replacement with an earlier issue second (skew).
      mint: () => Promise.resolve({ kind: "ok", token: reissued }),
      signIn: () => "sign-in-token",
      now: () => 1_000_000,
    });
    await main.adopt(USER, HOST, refused, main.era(USER), () => true);
    const { windows } = twoWindowsOverMain(main);
    const [asking, sibling] = windows;
    await Promise.all([asking.whenLoaded(), sibling.whenLoaded()]);
    expect(asking.current(USER, HOST)).toEqual(refused);
    expect(sibling.current(USER, HOST)).toEqual(refused);

    // A host refused the token; the asking window asks for a fresh one.
    const outcome = await asking.obtain(USER, HOST, true, {
      signal: null,
      owner: null,
    });

    expect(outcome).toEqual({ kind: "ok", token: reissued });
    expect(main.current(USER, HOST)).toEqual(reissued);
    expect(asking.current(USER, HOST)).toEqual(reissued);
    expect(sibling.current(USER, HOST)).toEqual(reissued);
  });
});
