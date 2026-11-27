import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenFrameBearerSource } from "../../../../shared/auth/bearer-source";
import type { HostTransportEndpoint } from "../../../../shared/host-transport/host-messenger";
import { readBotSnapshot, withLocalBotStream } from "../bot-host";
import { config } from "../../config";
import { cliCredentialsPath } from "@traycer/protocol/config/paths";
import type { LocalStreamLimit } from "../local-stream";

/** The dial a first read is made on: no redial, no admission watch. */
const FIRST_DIAL = {
  onAdmitted: (): void => undefined,
  endsAt: 0,
  redial: false,
} as const;

/** A bot read with no limit of its own: the tests end it themselves. */
const NO_LIMIT: LocalStreamLimit<never> = {
  span: { kind: "from-first-dial", ms: 3_600_000 },
  ended: () => Promise.reject(new Error("no limit was expected")),
};
/** A bot read the gate does not end: the tests give it no sign-in refusal. */
const NO_REFUSAL = (): Promise<never> =>
  Promise.reject(new Error("no refusal was expected"));

type CapturedOptions = {
  readonly endpoint: () => HostTransportEndpoint;
  readonly bearer: (hostId: string) => OpenFrameBearerSource | null;
};

const state = vi.hoisted(() => ({
  home: { path: null as string | null },
  options: null as CapturedOptions | null,
  status: null as ((status: string, reason: unknown) => void) | null,
  resolveHostAuth: vi.fn(),
  resolveEndpoint: vi.fn(),
  fetch: vi.fn(),
}));
let hostTokenFetchAt: number | null = null;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => state.home.path ?? actual.homedir() };
});
vi.mock("../host-auth", () => ({ resolveHostAuth: state.resolveHostAuth }));
vi.mock("../host-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../host-rpc")>();
  return { ...actual, resolveEndpoint: state.resolveEndpoint };
});
vi.mock("../../../../shared/host-transport/ws-stream-client", () => ({
  WsStreamClient: class {
    constructor(options: CapturedOptions) {
      state.options = options;
    }

    subscribe() {
      return {
        onServerFrame: (_handler: (envelope: unknown) => void) => undefined,
        onStatusChange: (
          handler: (status: string, reason: unknown) => void,
        ) => {
          state.status = handler;
        },
        close: () => undefined,
      };
    }

    getMethodSupport() {
      return "supported" as const;
    }

    close() {
      return undefined;
    }
  },
}));

beforeEach(async () => {
  state.home.path = await mkdtemp(join(tmpdir(), "traycer-cli-bot-host-"));
  state.options = null;
  state.status = null;
  state.resolveHostAuth.mockReset();
  state.resolveHostAuth.mockResolvedValue({
    token: "stored-sign-in-token",
    userId: "user-1",
    authnBaseUrl: "https://authn.test",
  });
  state.resolveEndpoint.mockReset();
  state.resolveEndpoint.mockResolvedValue({
    hostId: "host-1",
    websocketUrl: "ws://127.0.0.1:9999/rpc",
  });
  state.fetch.mockReset();
  hostTokenFetchAt = null;
  state.fetch.mockImplementation(async () => {
    hostTokenFetchAt = performance.now();
    return new Response(
      JSON.stringify({
        session_grant: "bot-host-only-token",
        session_grant_expires_in: 3600,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", state.fetch);
});

afterEach(async () => {
  const cleanupStartedAt = performance.now();
  const lockPath = `${cliCredentialsPath(config.environment)}.lock`;
  const lockPresentAtCleanup = existsSync(lockPath);
  if (lockPresentAtCleanup) {
    await vi.waitFor(() => expect(existsSync(lockPath)).toBe(false), {
      timeout: 10_000,
    });
  }
  console.info(
    `[timing] bot-host cleanup-at=${performance.now().toFixed(1)} elapsed=${(performance.now() - cleanupStartedAt).toFixed(1)}ms fetch-at=${hostTokenFetchAt === null ? "none" : hostTokenFetchAt.toFixed(1)} token-lock-at-entry=${lockPresentAtCleanup}`,
  );
  vi.unstubAllGlobals();
  const home = state.home.path;
  state.home.path = null;
  if (home !== null) await rm(home, { recursive: true, force: true });
}, 15_000);

describe("withLocalBotStream host authority", () => {
  it("uses the host-only token bought with the stored sign-in", async () => {
    await withLocalBotStream(
      null,
      NO_LIMIT,
      NO_REFUSAL,
      async (_client, endpoint) => {
        const options = state.options;
        expect(options?.endpoint()).toEqual(endpoint);
        // No token was held, so the read waited for the one mint before the
        // dial: the first ask presents the token it bought.
        expect(options?.bearer("host-1")?.getBearerToken()).toBe(
          "bot-host-only-token",
        );
        expect(options?.bearer("host-1")?.getBearerToken()).not.toBe(
          "stored-sign-in-token",
        );
      },
    );
    expect(state.fetch).toHaveBeenCalledTimes(1);
    const signIn = new Headers(state.fetch.mock.calls[0]?.[1]?.headers);
    expect(signIn.get("Authorization")).toBe("Bearer stored-sign-in-token");
  });

  it("maps a reasonless non-retryable door refusal to the older-host line", async () => {
    const startedAt = performance.now();
    let hostSessionReadyAt = 0;
    const pending = withLocalBotStream(
      null,
      NO_LIMIT,
      NO_REFUSAL,
      async (client) => {
        hostSessionReadyAt = performance.now();
        const read = readBotSnapshot(client, "bot-1", FIRST_DIAL);
        state.status?.("closed", {
          kind: "fatalError",
          signInVerdict: null,
          details: {
            code: "UNAUTHORIZED",
            reason: "legacy host refusal",
            incompatibleMethods: null,
            upgradeGuidance: null,
            retryable: false,
          },
        });
        return read;
      },
    );

    await expect(pending).rejects.toMatchObject({
      code: "E_HOST_INCOMPATIBLE",
      message:
        "The host is out of date. Reinstall the latest host with 'traycer host update'.",
    });
    console.info(
      `[timing] bot-host reasonless-refusal settled-at=${performance.now().toFixed(1)} session-ready-at=${hostSessionReadyAt.toFixed(1)} fetch-at=${hostTokenFetchAt === null ? "none" : hostTokenFetchAt.toFixed(1)} elapsed-from-start=${(performance.now() - startedAt).toFixed(1)}ms`,
    );
  });
});
