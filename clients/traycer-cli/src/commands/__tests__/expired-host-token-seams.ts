import type { WebSocketLike } from "@traycer/protocol/host-transport/websocket";
import type { StubStreamWebSocket } from "../../../../shared/host-transport/__testing__/stub-stream-socket";

/**
 * What the test files mock the commands' neighbours with. This module imports
 * nothing a mocked module imports: a mock factory that awaited the harness
 * would wait on a module that is itself waiting on that mock.
 */

/** What a case's endpoint and unary reads answer; see `hostRpcModule`. */
export interface Seams {
  endpoint: { hostId: string; websocketUrl: string };
  rpc: (method: string, params: unknown) => Promise<unknown>;
}

export const seams: Seams = {
  endpoint: { hostId: "", websocketUrl: "ws://127.0.0.1:9/rpc" },
  rpc: () => Promise.reject(new Error("no unary read was expected")),
};
/**
 * How long each `resolveEndpoint` call of the case waits before it answers, in
 * call order; a call past the list answers at once. A command's set-up slowed
 * past its wait.
 */
export const endpointDelaysMs: number[] = [];
/** Every unary read the case's commands made, by method, in order. */
export const rpcCalls: string[] = [];
/** The case's host door; `streamFactoryModule` dials it. */
export const live: {
  door: { accept: () => StubStreamWebSocket } | null;
} = { door: null };
/** The case's unary door; `unaryFactoryModule` dials it. */
export const liveUnary: {
  door: { accept: () => WebSocketLike } | null;
} = { door: null };

/** What the case's unary reads (`bot.list` and the like) answer. */
export function answerUnaryReads(
  routes: Readonly<Record<string, (params: unknown) => unknown>>,
): void {
  seams.rpc = (method, params) => {
    const route = routes[method];
    if (route === undefined)
      return Promise.reject(new Error(`unexpected host RPC ${method}`));
    return Promise.resolve(route(params));
  };
}

/**
 * Every running mint a session handed the client to wait on, after a host's
 * `owner_sign_in` invitation; see `cliHostTokensModule`.
 */
export const runningMintWaits: Promise<unknown>[] = [];

// ---- the seams the test files mock ---------------------------------------- //

type CliHostTokensModule = typeof import("../../internal/cli-host-tokens");

/**
 * `cli-host-tokens`: the real sessions, whose `runningMint` records each mint
 * it hands out. The client's wait on it puts nothing on the wire, so this is
 * how a case sees the client reach it.
 */
export function cliHostTokensModule(
  actual: CliHostTokensModule,
): CliHostTokensModule {
  const recording: CliHostTokensModule["requireCliHostSession"] = async (
    auth,
    hostId,
    signal,
  ) => {
    const session = await actual.requireCliHostSession(auth, hostId, signal);
    return {
      ...session,
      tokens: {
        ...session.tokens,
        runningMint: (askedHostId) => {
          const running = session.tokens.runningMint(askedHostId);
          if (running !== null) runningMintWaits.push(running);
          return running;
        },
      },
    };
  };
  return { ...actual, requireCliHostSession: recording };
}

/** `whatwg-stream-ws-factory`: every socket the stream dials is the host door's. */
export function streamFactoryModule(): {
  createWhatwgStreamWebSocketFactory: () => {
    create: () => StubStreamWebSocket;
  };
} {
  return {
    createWhatwgStreamWebSocketFactory: () => ({
      create: () => {
        const door = live.door;
        if (door === null) throw new Error("no case is open");
        return door.accept();
      },
    }),
  };
}

/** `host-rpc`: the endpoint this machine's host pid names, and the unary reads. */
export function hostRpcModule<T extends object>(
  actual: T,
): T & {
  resolveEndpoint: () => Promise<Seams["endpoint"]>;
  callHostRpc: (method: string, params: unknown) => Promise<unknown>;
} {
  return {
    ...actual,
    resolveEndpoint: async () => {
      const delay = endpointDelaysMs.shift() ?? 0;
      if (delay > 0)
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      return seams.endpoint;
    },
    callHostRpc: (method, params) => {
      rpcCalls.push(method);
      return seams.rpc(method, params);
    },
  };
}

/** Every line handed to the CLI's logger, its fields and errors as text. */
export const loggedLines: string[] = [];

function recordedAt(level: string): (...parts: unknown[]) => void {
  return (...parts) => {
    const text = JSON.stringify(parts, (_key, value: unknown) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value,
    );
    loggedLines.push(`${level} ${text}`);
  };
}

export function loggerModule(): {
  createCliLogger: () => Record<string, (...parts: unknown[]) => void>;
  noopLogger: Record<string, () => void>;
  errorFromUnknown: (value: unknown) => Error;
} {
  const recording = {
    debug: recordedAt("debug"),
    info: recordedAt("info"),
    warn: recordedAt("warn"),
    error: recordedAt("error"),
  };
  const quiet = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return {
    createCliLogger: () => recording,
    noopLogger: quiet,
    errorFromUnknown: (value) =>
      value instanceof Error ? value : new Error(String(value)),
  };
}

/** `sign-in-environments`: the environments the sign-in lists. */
export function signInEnvironmentsModule<T extends object>(
  actual: T,
): T & {
  readSignInEnvironments: () => Promise<{
    readonly userId: string;
    readonly environments: readonly never[];
  }>;
} {
  return {
    ...actual,
    // The person the command acts as is the stored sign-in's user.
    readSignInEnvironments: async () => ({
      userId:
        (
          await (
            await import("../../internal/host-auth")
          ).resolveHostAuth("required")
        )?.userId ?? "",
      environments: [],
    }),
  };
}

/** `host-ownership`: authn's directory has no row for this computer. */
export function hostOwnershipModule<T extends object>(
  actual: T,
): T & {
  readHostOwnershipViaHttp: () => Promise<{ readonly kind: "not-found" }>;
} {
  return {
    ...actual,
    readHostOwnershipViaHttp: () => Promise.resolve({ kind: "not-found" }),
  };
}

/** `whatwg-ws-factory`: every unary socket the real `callHostRpc` dials is the unary door's. */
export function unaryFactoryModule(): {
  createWhatwgWebSocketFactory: () => { create: () => WebSocketLike };
} {
  return {
    createWhatwgWebSocketFactory: () => ({
      create: () => {
        const door = liveUnary.door;
        if (door === null) throw new Error("no case is open");
        return door.accept();
      },
    }),
  };
}

/**
 * `pid-metadata`: this machine's host pid file names the case's endpoint, and
 * its process is alive, so the real `resolveEndpoint` answers it.
 */
export function pidMetadataModule<T extends object>(
  actual: T,
): T & {
  readHostPidMetadata: () => Promise<Record<string, unknown>>;
  publishedHostProcessGone: () => boolean;
} {
  return {
    ...actual,
    readHostPidMetadata: () =>
      Promise.resolve({
        pid: process.pid,
        hostId: seams.endpoint.hostId,
        version: "0.0.0",
        websocketUrl: seams.endpoint.websocketUrl,
        startedAt: "2026-01-01T00:00:00.000Z",
        processStartIdentity: null,
        processStartIdentityRead: "absent",
        layer0: null,
        layer0Slot: null,
      }),
    publishedHostProcessGone: () => false,
  };
}

/**
 * What the case holds back of the token source's `update()`: the real write
 * has landed and the lock is released, and the source has not yet set the
 * table the person's choices read. `written` settles when that point is reached.
 */
export const publishLag: {
  hold: Promise<void> | null;
  written: (() => void) | null;
  /** Settles `hold`: the world's close calls it, so no await stays held. */
  release: (() => void) | null;
} = { hold: null, written: null, release: null };

type HostTokenFileModule =
  typeof import("@traycer-clients/shared/auth/host-token-file");

/**
 * `host-token-file`: the real file persistence, whose `update()` returns to
 * the token source only once `publishLag.hold` (when set) settles.
 */
export function hostTokenFileModule(
  actual: HostTokenFileModule,
): HostTokenFileModule {
  return {
    ...actual,
    createHostTokenFilePersistence: (options) => {
      const real = actual.createHostTokenFilePersistence(options);
      return {
        ...real,
        update: async (change) => {
          const next = await real.update(change);
          publishLag.written?.();
          if (publishLag.hold !== null) await publishLag.hold;
          return next;
        },
      };
    },
  };
}
