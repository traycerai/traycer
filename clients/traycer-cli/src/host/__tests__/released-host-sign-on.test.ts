import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import {
  createReleasedHostMemory,
  type ReleasedHostMemory,
} from "@traycer-clients/shared/host-transport/released-sign-on";
import { AUTHENTICATED_USER_FIXTURE_ID } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import type { HostTokenTable } from "@traycer-clients/shared/auth/host-token-store";
import type { HostPidMetadata } from "../pid-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config";

// A released personal computer, with no app running: the install probe is the
// client. The host refuses the host-only token the way a level-2 release does
// and admits the sign-in. Authn is the stubbed `fetch`; the socket factory
// never dials.

const USER_ID = AUTHENTICATED_USER_FIXTURE_ID;
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const HOST_TOKEN = "host-only-token";
const SIGN_IN = "person-sign-in";
const HOST_CREDENTIAL = "provisioned-host-credential";

type Ownership =
  | "personal"
  | "team"
  | "network"
  | "missing"
  | "current"
  | "team-missing";

const harness = vi.hoisted(() => {
  class ScriptSocket {
    onopen: ((event: { readonly type: "open" }) => void) | null = null;
    onmessage:
      | ((event: { readonly type: "text"; readonly data: string }) => void)
      | null = null;
    onerror: ((event: { readonly type: "error" }) => void) | null = null;
    onclose:
      | ((event: {
          readonly code: number;
          readonly reason: string;
          readonly wasClean: boolean;
        }) => void)
      | null = null;
    readonly textSent: string[] = [];

    send(data: string | Uint8Array): void {
      if (typeof data !== "string") return;
      this.textSent.push(data);
      harness.wake();
    }

    close(_code: number, _reason: string): void {}

    fireOpen(): void {
      this.onopen?.({ type: "open" });
    }

    fireText(frame: unknown): void {
      this.onmessage?.({ type: "text", data: JSON.stringify(frame) });
    }
  }

  const sockets: ScriptSocket[] = [];
  const listeners = new Set<() => void>();
  const state: { ownership: Ownership; table: HostTokenTable } = {
    ownership: "personal",
    table: new Map(),
  };

  function wake(): void {
    const pending = Array.from(listeners);
    listeners.clear();
    for (const listener of pending) listener();
  }

  return { ScriptSocket, sockets, listeners, state, wake };
});

const releasedMemory = vi.hoisted(() => {
  let current: ReleasedHostMemory | undefined;
  return {
    install(memory: ReleasedHostMemory): void {
      current = memory;
    },
    read(): ReleasedHostMemory {
      if (current === undefined) {
        throw new Error("released host memory is not installed");
      }
      return current;
    },
  };
});

vi.mock(
  "@traycer-clients/shared/host-transport/released-sign-on",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/released-sign-on")
      >();
    return {
      ...actual,
      processReleasedHosts: {
        opensReleasedWay: (userId: string, hostId: string): boolean =>
          releasedMemory.read().opensReleasedWay(userId, hostId),
        namedReason: (hostId: string): boolean =>
          releasedMemory.read().namedReason(hostId),
        signInAdmitted: (userId: string, hostId: string): void => {
          releasedMemory.read().signInAdmitted(userId, hostId);
        },
        hostTokenAdmitted: (hostId: string): void => {
          releasedMemory.read().hostTokenAdmitted(hostId);
        },
        refusedNamingReason: (hostId: string): void => {
          releasedMemory.read().refusedNamingReason(hostId);
        },
        declineProbe: (userId: string, hostId: string): void => {
          releasedMemory.read().declineProbe(userId, hostId);
        },
        probeDeclined: (userId: string, hostId: string): boolean =>
          releasedMemory.read().probeDeclined(userId, hostId),
        forgetAll: (): void => {
          releasedMemory.read().forgetAll();
        },
      },
    };
  },
);

vi.mock("../../../../shared/host-transport/whatwg-stream-ws-factory", () => ({
  createWhatwgStreamWebSocketFactory: () => ({
    create: () => {
      const socket = new harness.ScriptSocket();
      harness.sockets.push(socket);
      queueMicrotask(() => harness.wake());
      return socket;
    },
  }),
}));

vi.mock("../pid-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pid-metadata")>();
  return {
    ...actual,
    readHostPidMetadata: async (): Promise<HostPidMetadata> => ({
      pid: 4242,
      hostId: HOST_ID,
      version: "0.0.0-released",
      websocketUrl: "ws://127.0.0.1:9/rpc",
      startedAt: "2026-11-20T12:00:00.000Z",
      processStartIdentity: null,
      processStartIdentityRead: "absent",
      layer0: null,
      layer0Slot: null,
    }),
  };
});

vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createCliCredentialsStore: () => ({ dispose: () => undefined }),
    createStoreBackedRevalidator: () => ({
      revalidateCurrentContext: async () => "rotated" as const,
    }),
  };
});

vi.mock(
  "@traycer-clients/shared/auth/host-token-file",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/auth/host-token-file")
      >();
    return {
      ...actual,
      createHostTokenFilePersistence: () => ({
        load: async () => harness.state.table,
        update: async (change: (table: HostTokenTable) => HostTokenTable) => {
          harness.state.table = change(harness.state.table);
          return harness.state.table;
        },
      }),
    };
  },
);

import {
  provisionInstalledHostCredential,
  type HostCredentialProvisionOutcome,
} from "../credential-provisioning";
import { noopLogger } from "../../logger";

function readObject(raw: string): Record<string, unknown> | null {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const frame: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    frame[key] = entry;
  }
  return frame;
}

function openOf(
  socket: InstanceType<typeof harness.ScriptSocket>,
): { readonly token: string; readonly manifest: unknown } | null {
  for (const raw of socket.textSent) {
    const frame = readObject(raw);
    if (frame === null || frame.kind !== "open") continue;
    if (typeof frame.token !== "string") continue;
    return { token: frame.token, manifest: frame.manifest };
  }
  return null;
}

function openTokens(): string[] {
  const tokens: string[] = [];
  for (const socket of harness.sockets) {
    const open = openOf(socket);
    if (open !== null) tokens.push(open.token);
  }
  return tokens;
}

function provisionFrames(): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  for (const socket of harness.sockets) {
    for (const raw of socket.textSent) {
      const frame = readObject(raw);
      if (frame !== null && frame.kind === "hostCredentialProvision") {
        frames.push(frame);
      }
    }
  }
  return frames;
}

function releasedRefusal(): {
  readonly kind: "fatalError";
  readonly details: {
    readonly code: "UNAUTHORIZED";
    readonly reason: string;
    readonly incompatibleMethods: null;
    readonly upgradeGuidance: null;
  };
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "released-host-token-refusal",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ownershipBody(): unknown {
  if (
    harness.state.ownership === "team" ||
    harness.state.ownership === "team-missing"
  ) {
    return {
      hosts: [
        {
          hostId: HOST_ID,
          owner: { kind: "team", id: "team-1", name: "Team" },
          kind: "machine",
          remoteAccess: false,
        },
      ],
    };
  }
  return {
    hosts: [
      {
        hostId: HOST_ID,
        owner: { kind: "user", id: USER_ID },
        kind: "personal",
        remoteAccess: false,
      },
    ],
  };
}

function namedRefusal(): {
  readonly kind: "fatalError";
  readonly details: {
    readonly code: "UNAUTHORIZED";
    readonly reason: string;
    readonly doorReason: "not_admitted";
    readonly retryable: false;
    readonly incompatibleMethods: null;
    readonly upgradeGuidance: null;
  };
} {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "current-host-refusal",
      doorReason: "not_admitted",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    async (
      input: RequestInfo | URL,
      init: RequestInit | undefined,
    ): Promise<Response> => {
      const url = new URL(requestUrl(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/v3/hosts" && method === "GET") {
        if (harness.state.ownership === "network") {
          throw new TypeError("authn unreachable");
        }
        if (
          harness.state.ownership === "missing" ||
          harness.state.ownership === "current"
        ) {
          return jsonResponse({ message: "missing" }, 404);
        }
        return jsonResponse(ownershipBody(), 200);
      }
      if (method === "POST" && url.pathname.endsWith("/session-grant")) {
        if (
          harness.state.ownership === "missing" ||
          harness.state.ownership === "current" ||
          harness.state.ownership === "team-missing"
        ) {
          return jsonResponse({ message: "missing" }, 404);
        }
        return jsonResponse(
          {
            session_grant: HOST_TOKEN,
            session_grant_expires_in: 300,
          },
          200,
        );
      }
      if (method === "POST" && url.pathname === "/api/v3/hosts/token") {
        return jsonResponse(
          {
            token: HOST_CREDENTIAL,
            refreshToken: "provisioned-host-refresh",
            familyId: "family-1",
            hostId: HOST_ID,
            expiresIn: 900,
            provisionedAt: "2026-07-08T12:00:00.123Z",
          },
          200,
        );
      }
      return jsonResponse({ url: url.toString() }, 500);
    },
  );
}

function waitForWork(stop: { current: boolean }): Promise<void> {
  if (stop.current) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      harness.listeners.delete(finish);
      resolve();
    };
    harness.listeners.add(finish);
    if (stop.current) finish();
  });
}

/** Answers each dial the probe opens. A sign-in is admitted only for a personal row. */
async function answerReleasedHost(
  ownership: Ownership,
  stop: { current: boolean },
): Promise<void> {
  const answered = new Set<InstanceType<typeof harness.ScriptSocket>>();
  let signInAcks = 0;
  while (!stop.current) {
    const pending = harness.sockets.filter((socket) => !answered.has(socket));
    if (pending.length === 0) {
      await waitForWork(stop);
      continue;
    }
    let waiting = false;
    for (const socket of pending) {
      if (socket.textSent.length === 0) socket.fireOpen();
      const open = openOf(socket);
      if (open === null) {
        waiting = true;
        continue;
      }
      answered.add(socket);
      const admitsSignIn =
        ownership === "personal" ||
        ownership === "network" ||
        ownership === "missing";
      if (open.token === SIGN_IN && admitsSignIn) {
        signInAcks += 1;
        socket.fireText({
          kind: "openAck",
          manifest: open.manifest,
          capabilities: ["hostCredentialProvision"],
          hostCredentialState: signInAcks === 1 ? "missing" : "active",
        });
        continue;
      }
      if (open.token === SIGN_IN && ownership === "current") {
        socket.fireText(namedRefusal());
        continue;
      }
      socket.fireText(releasedRefusal());
    }
    if (waiting) await waitForWork(stop);
  }
}

async function probe(
  ownership: Ownership,
  deadlineMs: number,
): Promise<HostCredentialProvisionOutcome> {
  harness.state.ownership = ownership;
  const stop = { current: false };
  const answering = answerReleasedHost(ownership, stop);
  try {
    return await provisionInstalledHostCredential({
      environment: "dev",
      auth: {
        token: SIGN_IN,
        authnBaseUrl: config.authnBaseUrl,
        userId: USER_ID,
      },
      deadlineMs,
      progress: () => undefined,
      logger: noopLogger,
    });
  } finally {
    stop.current = true;
    harness.wake();
    await answering;
  }
}

beforeEach(() => {
  releasedMemory.install(createReleasedHostMemory());
  harness.sockets.splice(0);
  harness.listeners.clear();
  harness.state.table = new Map();
  harness.state.ownership = "personal";
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CLI credential probe against a released host", () => {
  it("opens a personal computer with the sign-in and sends hostCredentialProvision", async () => {
    const outcome = await probe("personal", 20_000);
    const tokens = openTokens();
    const firstSignIn = tokens.indexOf(SIGN_IN);
    expect(outcome).toEqual({ kind: "active", minted: true });
    expect(tokens[0]).toBe(HOST_TOKEN);
    expect(firstSignIn).toBeGreaterThan(0);
    expect(tokens[firstSignIn + 1]).toBe(SIGN_IN);
    expect(tokens[tokens.length - 1]).toBe(SIGN_IN);
    expect(
      tokens.every((token) => token === HOST_TOKEN || token === SIGN_IN),
    ).toBe(true);
    expect(provisionFrames()).toEqual([
      {
        kind: "hostCredentialProvision",
        token: HOST_CREDENTIAL,
        refreshToken: "provisioned-host-refresh",
        familyId: "family-1",
        provisionedAt: "2026-07-08T12:00:00.123Z",
      },
    ]);
  }, 30_000);

  it("never sends the sign-in when authn says the computer is a team's", async () => {
    const outcome = await probe("team", 8_000);
    expect(openTokens()).toEqual([HOST_TOKEN]);
    expect(outcome).toEqual({
      kind: "error",
      message:
        "the host closed the connection before authorization was confirmed",
    });
    expect(provisionFrames()).toEqual([]);
  }, 15_000);

  it("opens with the sign-in when authn cannot be reached for that refusal", async () => {
    const outcome = await probe("network", 20_000);
    const tokens = openTokens();
    const firstSignIn = tokens.indexOf(SIGN_IN);
    expect(outcome).toEqual({ kind: "active", minted: true });
    expect(tokens[0]).toBe(HOST_TOKEN);
    expect(firstSignIn).toBeGreaterThan(0);
    expect(tokens[firstSignIn + 1]).toBe(SIGN_IN);
    expect(tokens[tokens.length - 1]).toBe(SIGN_IN);
    expect(provisionFrames()).toHaveLength(1);
  }, 30_000);

  it("opens with the sign-in when authn has no row, and still sends hostCredentialProvision", async () => {
    const outcome = await probe("missing", 20_000);
    const tokens = openTokens();
    expect(outcome).toEqual({ kind: "active", minted: true });
    expect(tokens[0]).toBe(NO_HOST_TOKEN_PROBE);
    const signInAt = tokens.indexOf(SIGN_IN);
    expect(signInAt).toBeGreaterThan(0);
    expect(
      tokens.every(
        (token) => token === NO_HOST_TOKEN_PROBE || token === SIGN_IN,
      ),
    ).toBe(true);
    expect(provisionFrames()).toHaveLength(1);
  }, 30_000);

  it("sends the sign-in once when a current host names its refusal, then ends on the second 404", async () => {
    const outcome = await probe("current", 20_000);
    expect(outcome).toEqual({ kind: "mint-unavailable" });
    expect(openTokens().filter((token) => token === SIGN_IN)).toEqual([
      SIGN_IN,
    ]);
    expect(provisionFrames()).toEqual([]);
  }, 30_000);

  it("ends on the first 404 when authn says the computer is a team's", async () => {
    const outcome = await probe("team-missing", 8_000);
    expect(outcome).toEqual({ kind: "mint-unavailable" });
    expect(openTokens()).not.toContain(SIGN_IN);
    expect(provisionFrames()).toEqual([]);
  }, 15_000);
});
