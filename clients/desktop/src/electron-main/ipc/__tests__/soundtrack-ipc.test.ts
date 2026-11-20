import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  RunnerHostInvoke,
  RunnerHostSync,
} from "../../../ipc-contracts/ipc-channels";
import { DesktopAuthSession } from "../../auth/desktop-auth-session";
import type { SoundtrackSourceOptions } from "../../soundtrack/soundtrack-source";
import { registerSoundtrackIpc } from "../soundtrack-ipc";
import type { RunnerIpcBridge } from "../runner-ipc-bridge";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MANIFEST_URL =
  "https://storage.googleapis.com/traycerai-dev-soundtrack/sets/team/v1.json";

const SIGNED_IN = {
  status: "signed-in" as const,
  token: "bearer-fixture",
  profile: { userId: "u1", userName: "Ada", email: "ada@example.com" },
};

const MANIFEST = {
  version: 1,
  tracks: [],
  views: { home: [], task: [], bot: [], settings: [] },
  stems: { tracks: [] },
};

let keyDir: string;
let keyFilePath: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  keyDir = mkdtempSync(join(tmpdir(), "traycer-soundtrack-ipc-test-"));
  keyFilePath = join(keyDir, "key.json");
  writeFileSync(
    keyFilePath,
    JSON.stringify({
      client_email: "signer@fixture.iam.example",
      private_key: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      private_key_id: "key-id-fixture",
    }),
  );
});

afterAll(() => {
  rmSync(keyDir, { recursive: true, force: true });
});

const INVOKE_EVENT = {} as IpcMainInvokeEvent;
const SYNC_EVENT = {} as IpcMainEvent;

type SyncCompute = () => unknown;
type InvokeHandler = () => unknown;

const fetchMock = vi.fn<typeof fetch>();

function register(
  overrides: Partial<SoundtrackSourceOptions>,
  authSession: DesktopAuthSession,
) {
  const syncs = new Map<string, SyncCompute>();
  const invokes = new Map<string, InvokeHandler>();
  const bridge: Pick<
    RunnerIpcBridge,
    "authSession" | "handleInvoke" | "handleSync"
  > = {
    authSession,
    handleInvoke: (channel, handler) => {
      invokes.set(channel, () => handler(INVOKE_EVENT));
    },
    handleSync: (channel, compute) => {
      syncs.set(channel, () => compute(SYNC_EVENT));
    },
  };
  registerSoundtrackIpc(bridge, {
    keyFilePath,
    audience: "audience-fixture",
    set: "team",
    manifestVersion: 1,
    fetch: fetchMock,
    now: () => 1_800_000_000_000,
    warn: () => {},
    ...overrides,
  });
  return {
    flag: () => syncs.get(RunnerHostSync.soundtrackSourceAvailable)?.(),
    read: () => invokes.get(RunnerHostInvoke.readSoundtrackSet)?.(),
  };
}

function verifiedSession(): DesktopAuthSession {
  const session = new DesktopAuthSession();
  session.setVerified(SIGNED_IN, session.beginSet());
  return session;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((input) =>
    Promise.resolve(
      String(input) === TOKEN_URL
        ? Response.json({ access_token: "access-token-fixture" })
        : Response.json(MANIFEST),
    ),
  );
});

describe("registerSoundtrackIpc", () => {
  it("reports no source with no key, and true with a key and an audience", () => {
    expect(
      register({ keyFilePath: null }, new DesktopAuthSession()).flag(),
    ).toBe(false);
    expect(register({}, new DesktopAuthSession()).flag()).toBe(true);
  });

  it("answers unavailable with no key, even for a verified session", async () => {
    const ipc = register({ keyFilePath: null }, verifiedSession());

    await expect(ipc.read()).resolves.toEqual({ kind: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers unavailable and makes no request while the session is not verified", async () => {
    const unverified = new DesktopAuthSession();
    unverified.set(SIGNED_IN);

    const ipc = register({}, unverified);

    await expect(ipc.read()).resolves.toEqual({ kind: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers the set once the session is verified", async () => {
    const ipc = register({}, verifiedSession());

    await expect(ipc.read()).resolves.toEqual({
      kind: "ok",
      manifest: MANIFEST,
    });
    expect(fetchMock).toHaveBeenCalledWith(MANIFEST_URL, expect.anything());
  });

  it("answers unavailable, not a rejection, when the read fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const ipc = register({}, verifiedSession());

    await expect(ipc.read()).resolves.toEqual({ kind: "unavailable" });
  });
});
