import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import { defineVersionedRpcRegistry } from "@traycer/protocol/framework/index";
import { defineVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { retireAllRemoteSessions } from "@traycer-clients/shared/host-transport/remote/active-remote-sessions";
import { createRemoteHostTransport } from "@traycer-clients/shared/host-transport/remote/create-remote-transport";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import { createDesktopHostTokenSource } from "../../../renderer-shell/desktop-host-tokens";
import {
  NO_ISSUED_HOST_TOKEN_ERA,
  type HostTokensBridgeSurface,
} from "../../../ipc-contracts/host-token-types";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
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
      window,
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

/** A source whose table writes can be held, as a slow disk would: the first `writes()` count is the held one. */
function sourceWithHoldableWrites(): {
  readonly source: HostTokenSource;
  readonly writes: () => number;
  readonly hold: () => void;
  readonly release: () => void;
} {
  const inner = createMemoryHostTokenPersistence();
  let writes = 0;
  let holding = false;
  let release: () => void = () => undefined;
  let gate = Promise.resolve();
  const source = createHostTokenSource({
    persistence: {
      load: () => inner.load(),
      update: async (change) => {
        writes += 1;
        if (holding) await gate;
        return inner.update(change);
      },
    },
    mint: () => Promise.resolve({ kind: "no-sign-in" }),
    signIn: null,
    now: () => Date.now(),
  });
  return {
    source,
    writes: () => writes,
    hold: () => {
      holding = true;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
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
      obtain: async () => ({ outcome: { kind: "no-sign-in" }, era: 0 }),
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
        return { era: Reflect.get(Object(reply), "era") };
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
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(socketsCreated).toEqual([]);
      expect(reports).toEqual([]);
    } finally {
      retireAllRemoteSessions();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
