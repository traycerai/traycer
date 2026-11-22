import { EventEmitter } from "node:events";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import { registerAuthIpc } from "../auth-ipc";
import {
  RunnerIpcBridge,
  type IpcHostLifecycle,
  type IpcManagedWindow,
} from "../runner-ipc-bridge";
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
const OFFER = { offerSdp: "v=0 offer", input: "the briefing" };

function mint(request: unknown): unknown {
  const handler = handlers.get(RunnerHostInvoke.mintVoiceSession);
  if (handler === undefined) throw new Error("mint handler not registered");
  return handler(RENDERER, "user-jwt", request);
}

function stubFetch(): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ error: "x" }), { status: 500 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeAll(() => {
  registerAuthIpc(
    new RunnerIpcBridge({
      host: new IdleHost(),
      hostController: new FakeHostController(),
      authnBaseUrl: "http://localhost:5005",
      authRedirectUri: null,
      tray: null,
      zoomController: undefined,
      authTokenStore: undefined,
      window,
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the mintVoiceSession handler", () => {
  it("forwards voice and voicePolicy to the mint request body", async () => {
    const fetchMock = stubFetch();

    await mint({ ...OFFER, voice: "marin", voicePolicy: "exact" });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      ...OFFER,
      voice: "marin",
      voicePolicy: "exact",
    });
  });

  it.each([
    ["absent", {}],
    ["null", { voice: null, voicePolicy: null }],
  ])(
    "sends today's body when voice and voicePolicy are %s",
    async (_n, extra) => {
      const fetchMock = stubFetch();

      await mint({ ...OFFER, ...extra });

      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(
        OFFER,
      );
    },
  );

  it.each([
    [
      "a voice that is not a voice name",
      { voice: "Not A Voice", voicePolicy: "fallback" },
    ],
    [
      "a policy outside fallback and exact",
      { voice: "marin", voicePolicy: "strict" },
    ],
    ["exact with no voice", { voice: null, voicePolicy: "exact" }],
  ])("rejects %s without calling the server", async (_n, extra) => {
    const fetchMock = stubFetch();

    await expect(
      Promise.resolve().then(() => mint({ ...OFFER, ...extra })),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
