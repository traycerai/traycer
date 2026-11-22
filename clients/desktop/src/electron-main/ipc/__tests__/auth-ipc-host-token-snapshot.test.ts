import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  type HostTokenSource,
} from "@traycer-clients/shared/auth/host-token-source";
import { NO_ISSUED_HOST_TOKEN_ERA } from "../../../ipc-contracts/host-token-types";
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
