import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenFrameBearerSource } from "../../../../shared/auth/bearer-source";
import type { HostTransportEndpoint } from "../../../../shared/host-transport/host-messenger";
import { openLocalStreamClient, readBotSnapshot } from "../bot-host";

type CapturedOptions = {
  readonly endpoint: () => HostTransportEndpoint;
  readonly bearer: () => OpenFrameBearerSource | null;
};

const state = vi.hoisted(() => ({
  home: { path: null as string | null },
  options: null as CapturedOptions | null,
  status: null as ((status: string, reason: unknown) => void) | null,
  resolveHostAuth: vi.fn(),
  resolveEndpoint: vi.fn(),
  fetch: vi.fn(),
}));

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
  state.fetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        session_grant: "bot-host-only-token",
        session_grant_expires_in: 3600,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", state.fetch);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const home = state.home.path;
  state.home.path = null;
  if (home !== null) await rm(home, { recursive: true, force: true });
});

describe("openLocalStreamClient host authority", () => {
  it("uses the host-only token bought with the stored sign-in", async () => {
    const { endpoint } = await openLocalStreamClient();
    const options = state.options;
    expect(options?.endpoint()).toEqual(endpoint);
    expect(state.fetch).toHaveBeenCalledTimes(1);
    const signIn = new Headers(state.fetch.mock.calls[0]?.[1]?.headers);
    expect(signIn.get("Authorization")).toBe("Bearer stored-sign-in-token");
    const bearer = options?.bearer();
    expect(bearer?.getBearerToken()).toBe("bot-host-only-token");
    expect(bearer?.getBearerToken()).not.toBe("stored-sign-in-token");
  });

  it("maps a reasonless non-retryable door refusal to the older-host line", async () => {
    const { client } = await openLocalStreamClient();
    const pending = readBotSnapshot(client, "bot-1");
    state.status?.("closed", {
      kind: "fatalError",
      details: {
        code: "UNAUTHORIZED",
        reason: "legacy host refusal",
        incompatibleMethods: null,
        upgradeGuidance: null,
        retryable: false,
      },
    });

    await expect(pending).rejects.toMatchObject({
      code: "E_HOST_INCOMPATIBLE",
      message:
        "The host is out of date. Reinstall the latest host with 'traycer host update'.",
    });
  });
});
