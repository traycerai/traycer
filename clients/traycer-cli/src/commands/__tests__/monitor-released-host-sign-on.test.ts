import { NO_HOST_TOKEN_PROBE } from "@traycer/protocol/framework/door-reason";
import type { HostTokenTable } from "@traycer-clients/shared/auth/host-token-store";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nameReason } from "../../internal/__tests__/released-memory-test-support";
import { buildProgramWithAgentRoles } from "../../index";
import { runMonitor } from "../monitor";
import { CLI_ERROR_CODES } from "../../runner/errors";

const USER_ID = "monitor-test-user";
let hostCount = 0;

/** A computer id no earlier test used: a named reason is remembered per computer for the whole process. */
function nextHostId(): string {
  hostCount += 1;
  return `11111111-1111-4111-8111-${String(hostCount).padStart(12, "0")}`;
}
const SIGN_IN = "monitor-test-sign-in";
const TEAM_REFUSAL = "the host has not admitted this sign-in";
const WAIT = { timeout: 2_000, interval: 10 };
/** When the proactive upkeep refreshes the sign-in, after the command starts (never before 60 s). */
const UPKEEP_FIRES_AT_MS = 68_500;

const monitorHarness = vi.hoisted(() => {
  class ScriptSocket {
    readonly sent: string[] = [];
    readonly dialStarted = Promise.resolve();
    closed: { readonly code: number; readonly reason: string } | null = null;
    onopen: ((event: { readonly type: "open" }) => void) | null = null;
    onmessage:
      | ((
          event:
            | { readonly type: "text"; readonly data: string }
            | { readonly type: "binary"; readonly data: Uint8Array },
        ) => void)
      | null = null;
    onerror: ((event: { readonly message: string }) => void) | null = null;
    onclose:
      | ((event: {
          readonly code: number;
          readonly reason: string;
          readonly wasClean: boolean;
        }) => void)
      | null = null;

    send(data: string | Uint8Array): void {
      if (typeof data === "string") this.sent.push(data);
    }

    close(code: number, reason: string): void {
      this.closed = { code, reason };
    }

    fireOpen(): void {
      this.onopen?.({ type: "open" });
    }

    fireFrame(frame: unknown): void {
      this.onmessage?.({ type: "text", data: JSON.stringify(frame) });
    }
  }

  return {
    ScriptSocket,
    sockets: [] as InstanceType<typeof ScriptSocket>[],
    /** Every line the monitor printed, to stdout or stderr. */
    printed: [] as string[],
    /** The host each host-only mint request authn took was for, in the order asked. */
    grantHosts: [] as string[],
    /** The sign-in each of those requests carried, and the fake time each began. */
    grantSignIns: [] as string[],
    grantStartedAt: [] as number[],
    /** The exit code each `finishAndExit` the command reached was given. */
    exits: [] as number[],
    state: {
      hostTokenTable: new Map() as HostTokenTable,
      reader: new AbortController(),
      grants: 0,
      /** The computer this monitor finds running; a named reason is remembered per computer for the whole process. */
      hostId: "",
      /** The host process the pid file names; a new one is a restarted host. */
      pid: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      /** The stored sign-in the command reads; set to `SIGN_IN` before each test. */
      signIn: "",
      /** What the scripted store answers its first `rotate`: a sibling's pair adopted, or a real refresh. */
      firstRotation: "superseded" as "superseded" | "applied",
      /** The sign-in a real refresh stores. */
      refreshedSignIn: "refreshed-token",
      /** When set, the stored sign-in is refreshed by the real revalidator against the scripted store below. */
      realRevalidator: false,
      /** What the scripted credentials store answered each `rotate`, in order: the first is a sibling's pair adopted, later ones refresh. */
      rotations: [] as string[],
      /** What refreshing the stored sign-in answers. */
      refresh: "network-error" as "network-error" | "rotated" | "rejected",
      /** What authn answers a host-token mint with. */
      grantResponse: (): Promise<Response> =>
        Promise.resolve(new Response("authn unavailable", { status: 503 })),
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
});

vi.mock("../../runner/exit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../runner/exit")>();
  return {
    ...actual,
    finishAndExit: async (exitCode: number) => {
      monitorHarness.exits.push(exitCode);
    },
  };
});

vi.mock("../../internal/host-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-auth")>();
  return {
    ...actual,
    resolveHostAuth: async () => ({
      token: monitorHarness.state.signIn,
      authnBaseUrl: "https://authn.test",
      userId: USER_ID,
    }),
  };
});

vi.mock("../../internal/agent-session-capability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../internal/agent-session-capability")
    >();
  return {
    ...actual,
    PROCESS_AGENT_ENVIRONMENT: () => undefined,
    readAgentCommandCredential: () => ({ kind: "outside-agent-session" }),
  };
});

vi.mock("../../logger", () => ({
  createCliLogger: () => monitorHarness.logger,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));

vi.mock("../../host/pid-metadata", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/pid-metadata")>();
  return {
    ...actual,
    readHostPidMetadata: async () => ({
      pid: monitorHarness.state.pid,
      hostId: monitorHarness.state.hostId,
      version: "test",
      websocketUrl: "ws://127.0.0.1:9/rpc",
      startedAt: monitorHarness.state.startedAt,
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
    createCliCredentialsStore: () => ({
      dispose: () => undefined,
      rotate: async () => {
        const adopted =
          monitorHarness.state.rotations.length === 0 &&
          monitorHarness.state.firstRotation === "superseded";
        monitorHarness.state.rotations.push(adopted ? "superseded" : "applied");
        return {
          outcome: adopted ? "superseded" : "applied",
          credentials: {
            token: adopted
              ? "adopted-expired-token"
              : monitorHarness.state.refreshedSignIn,
          },
        };
      },
    }),
    createStoreBackedRevalidator: (
      args: Parameters<typeof actual.createStoreBackedRevalidator>[0],
    ) =>
      monitorHarness.state.realRevalidator
        ? actual.createStoreBackedRevalidator(args)
        : {
            revalidateCurrentContext: async () => monitorHarness.state.refresh,
            rotateSignIn: async () => monitorHarness.state.refresh,
          },
  };
});

vi.mock("../../auth/host-credential-mint", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../auth/host-credential-mint")>();
  return {
    ...actual,
    createCliHostCredentialMintFlow: () => null,
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
        load: async () => monitorHarness.state.hostTokenTable,
        update: async (
          change: (table: HostTokenTable) => HostTokenTable,
        ): Promise<HostTokenTable> => {
          monitorHarness.state.hostTokenTable = change(
            monitorHarness.state.hostTokenTable,
          );
          return monitorHarness.state.hostTokenTable;
        },
      }),
    };
  },
);

vi.mock("../../../../shared/host-transport/whatwg-stream-ws-factory", () => ({
  createWhatwgStreamWebSocketFactory: () => ({
    create: () => {
      const socket = new monitorHarness.ScriptSocket();
      monitorHarness.sockets.push(socket);
      return socket;
    },
  }),
}));

vi.mock("../../runner/std-write", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../runner/std-write")>();
  return {
    ...actual,
    stdoutReaderClosed: () => monitorHarness.state.reader.signal,
    writeStdout: (text: string) => {
      monitorHarness.printed.push(text);
    },
    writeStderr: (text: string) => {
      monitorHarness.printed.push(text);
    },
    writeStdoutForAck: () => ({
      confirmation: Promise.resolve(true),
      eventualOutcome: Promise.resolve(true),
    }),
  };
});

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function openToken(
  socket: InstanceType<typeof monitorHarness.ScriptSocket>,
): string | null {
  for (const raw of socket.sent) {
    const frame: unknown = JSON.parse(raw);
    if (
      typeof frame === "object" &&
      frame !== null &&
      "kind" in frame &&
      frame.kind === "open" &&
      "token" in frame &&
      typeof frame.token === "string"
    )
      return frame.token;
  }
  return null;
}

function openFrame(
  socket: InstanceType<typeof monitorHarness.ScriptSocket>,
): Record<string, unknown> {
  for (const raw of socket.sent) {
    const frame: unknown = JSON.parse(raw);
    if (
      typeof frame === "object" &&
      frame !== null &&
      "kind" in frame &&
      frame.kind === "open"
    )
      return frame;
  }
  throw new Error("open frame missing");
}

async function socketAt(
  index: number,
): Promise<InstanceType<typeof monitorHarness.ScriptSocket>> {
  await vi.waitFor(
    () => expect(monitorHarness.sockets.length).toBeGreaterThan(index),
    WAIT,
  );
  const socket = monitorHarness.sockets[index];
  if (socket === undefined) throw new Error("monitor socket missing");
  await vi.waitFor(() => expect(socket.onopen).not.toBeNull(), WAIT);
  return socket;
}

async function readOpen(
  socket: InstanceType<typeof monitorHarness.ScriptSocket>,
): Promise<Record<string, unknown>> {
  socket.fireOpen();
  await vi.waitFor(() => expect(openToken(socket)).not.toBeNull(), WAIT);
  return openFrame(socket);
}

function fatal(
  doorReason: "token_expired" | "not_admitted" | "owner_sign_in",
  reason: string,
): Record<string, unknown> {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason,
      doorReason,
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

/** A released host's refusal of a credential it does not know: no reason named. */
function bareRefusal(): Record<string, unknown> {
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

const NOT_A_MEMBER_SENTENCE =
  "traycer: This computer belongs to a team. This account is not a member. Switch accounts to use Traycer here. Run `traycer login` to switch accounts.";
const OLDER_HOST_SENTENCE =
  "The host is out of date. Reinstall the latest host with 'traycer host update'.";

/** The reasons a released host gives for refusing a credential. */
const RELEASED_REASONS = [
  "Authenticated user does not own this host",
  "Host is not provisioned - run `traycer login` on the host machine to authorize it",
  "Token has been revoked",
] as const;

/** A released host's refusal: bare, with no door reason, naming its own reason. */
function releasedRefusalWith(reason: string): Record<string, unknown> {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

/** A team host's refusal of a non-member; with no door reason it is an older host's. */
function teamRefusal(
  doorReason: "not_admitted" | "membership_removed" | null,
): Record<string, unknown> {
  return {
    kind: "fatalError",
    details: {
      code: "TEAM_MEMBERSHIP_REQUIRED",
      reason: "team admission",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
      ...(doorReason === null ? {} : { doorReason }),
    },
  };
}

let monitorRun: Promise<void> | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  monitorRun = null;
  monitorHarness.sockets.splice(0);
  monitorHarness.printed.splice(0);
  monitorHarness.exits.splice(0);
  monitorHarness.grantHosts.splice(0);
  monitorHarness.grantSignIns.splice(0);
  monitorHarness.grantStartedAt.splice(0);
  monitorHarness.state.hostTokenTable = new Map();
  monitorHarness.state.reader = new AbortController();
  monitorHarness.state.grants = 0;
  monitorHarness.state.refresh = "network-error";
  monitorHarness.state.realRevalidator = false;
  monitorHarness.state.rotations.splice(0);
  monitorHarness.state.signIn = SIGN_IN;
  monitorHarness.state.firstRotation = "superseded";
  monitorHarness.state.refreshedSignIn = "refreshed-token";
  monitorHarness.state.pid = 1;
  monitorHarness.state.startedAt = "2026-01-01T00:00:00.000Z";
  monitorHarness.state.hostId = nextHostId();
  monitorHarness.state.grantResponse = () =>
    Promise.resolve(new Response("authn unavailable", { status: 503 }));
  processReleasedHosts.forgetAll();
  vi.stubGlobal(
    "fetch",
    async (
      input: RequestInfo | URL,
      init: RequestInit | undefined,
    ): Promise<Response> => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.pathname.endsWith("/session-grant")) {
        monitorHarness.state.grants += 1;
        monitorHarness.grantHosts.push(
          decodeURIComponent(url.pathname.split("/")[4] ?? ""),
        );
        monitorHarness.grantSignIns.push(
          (new Headers(init?.headers).get("authorization") ?? "").replace(
            "Bearer ",
            "",
          ),
        );
        monitorHarness.grantStartedAt.push(Date.now());
        return monitorHarness.state.grantResponse();
      }
      if (method === "GET" && url.pathname.startsWith("/api/v3/hosts"))
        return new Response("authn unavailable", { status: 503 });
      return new Response("not found", { status: 404 });
    },
  );
});

afterEach(async () => {
  monitorHarness.state.reader.abort();
  if (monitorRun !== null) await monitorRun.catch(() => undefined);
  processReleasedHosts.forgetAll();

  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("traycer monitor local released-host sign-in", () => {
  it("re-presents the held token after the unknown-row probe is declined", async () => {
    const expiredAt = Date.now() - 11 * 60 * 1000;
    const token = expiredJwt(expiredAt);
    monitorHarness.state.hostTokenTable = new Map([
      [
        USER_ID,
        new Map([
          [monitorHarness.state.hostId, { token, expiresAtMs: expiredAt }],
        ]),
      ],
    ]);

    const running = runMonitor({ agentId: "agent-a", epicId: "epic-a" });
    monitorRun = running;
    void running.catch(() => undefined);
    await vi.waitFor(
      () => expect(monitorHarness.state.grants).toBeGreaterThan(0),
      WAIT,
    );
    await vi.advanceTimersByTimeAsync(500);
    const first = await socketAt(0);
    const firstOpen = await readOpen(first);
    expect(firstOpen.token).toBe(token);
    first.fireFrame(fatal("token_expired", "host token expired"));

    await vi.waitFor(
      () => expect(monitorHarness.state.grants).toBeGreaterThan(1),
      WAIT,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const probe = await socketAt(1);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    probe.fireFrame(fatal("not_admitted", TEAM_REFUSAL));

    await vi.waitFor(
      () => expect(monitorHarness.state.grants).toBeGreaterThan(2),
      WAIT,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const admitted = await socketAt(2);
    const admittedOpen = await readOpen(admitted);
    expect(admittedOpen.token).toBe(token);
    admitted.fireFrame({
      kind: "openAck",
      manifest: admittedOpen.manifest,
      optionalManifest: admittedOpen.optionalManifest,
    });
    await vi.waitFor(() =>
      expect(
        admitted.sent.some((raw) => raw.includes('"kind":"subscribe"')),
      ).toBe(true),
    );
    expect(monitorHarness.sockets.map(openToken)).toEqual([
      token,
      NO_HOST_TOKEN_PROBE,
      token,
    ]);

    monitorHarness.state.reader.abort();
    await expect(running).resolves.toBeUndefined();
  });

  let ended: { readonly error: unknown } | null = null;

  function startMonitor(): void {
    ended = null;
    const running = runMonitor({ agentId: "agent-a", epicId: "epic-a" });
    monitorRun = running;
    running.then(
      () => {
        ended = { error: null };
      },
      (error: unknown) => {
        ended = { error };
      },
    );
  }

  /** What the monitor has done by now: still going, or ended with its error. */
  async function outcomeOf(): Promise<unknown> {
    await vi.advanceTimersByTimeAsync(0);
    return ended === null ? "running" : ended.error;
  }

  async function admitWith(
    socket: InstanceType<typeof monitorHarness.ScriptSocket>,
  ): Promise<void> {
    socket.fireOpen();
    await vi.advanceTimersByTimeAsync(0);
    const open = openFrame(socket);
    socket.fireFrame({
      kind: "openAck",
      manifest: open.manifest,
      optionalManifest: open.optionalManifest,
    });
    await vi.waitFor(() =>
      expect(
        socket.sent.some((raw) => raw.includes('"kind":"subscribe"')),
      ).toBe(true),
    );
  }

  it.each([
    {
      host: "a released host",
      refusal: bareRefusal(),
      sendsSignIn: true,
    },
    {
      host: "a current personal host",
      refusal: fatal("owner_sign_in", "current personal host invited sign-in"),
      sendsSignIn: true,
    },
    {
      host: "a current team host",
      refusal: fatal("not_admitted", TEAM_REFUSAL),
      sendsSignIn: false,
    },
  ])(
    "opens $host's first socket at once with authn taking the mint and never answering it",
    async ({ refusal, sendsSignIn }) => {
      monitorHarness.state.grantResponse = () =>
        new Promise<Response>(() => undefined);
      startMonitor();

      await vi.advanceTimersByTimeAsync(0);
      expect(monitorHarness.sockets).toHaveLength(1);
      const probe = await socketAt(0);
      expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
      expect(monitorHarness.state.grants).toBeGreaterThan(0);
      probe.fireFrame(refusal);

      if (sendsSignIn) {
        await admitWith(await socketAt(1));
        expect(monitorHarness.sockets.map(openToken)).toEqual([
          NO_HOST_TOKEN_PROBE,
          SIGN_IN,
        ]);
      } else {
        // A current team host takes no sign-in, whatever the wait.
        await vi.advanceTimersByTimeAsync(15_000);
        expect(monitorHarness.sockets.map(openToken)).not.toContain(SIGN_IN);
      }
      expect(await outcomeOf()).toBe("running");
    },
  );

  it("goes on past a not-admitted mint answered before the host named a reason, and the sign-in is admitted", async () => {
    monitorHarness.state.grantResponse = () =>
      Promise.resolve(new Response("no row", { status: 404 }));
    startMonitor();
    const probe = await socketAt(0);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    await vi.waitFor(
      () => expect(monitorHarness.state.grants).toBeGreaterThan(0),
      WAIT,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcomeOf()).toBe("running");

    probe.fireFrame(bareRefusal());
    await admitWith(await socketAt(1));

    expect(monitorHarness.sockets.map(openToken)).toEqual([
      NO_HOST_TOKEN_PROBE,
      SIGN_IN,
    ]);
    expect(await outcomeOf()).toBe("running");
  });

  it("ends with the host's forbidden line once the probe drew a named refusal and authn has no row", async () => {
    const answerMint: { current: (response: Response) => void } = {
      current: () => undefined,
    };
    monitorHarness.state.grantResponse = () =>
      new Promise<Response>((resolve) => {
        answerMint.current = resolve;
      });
    startMonitor();
    const probe = await socketAt(0);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    await vi.waitFor(
      () => expect(monitorHarness.state.grants).toBeGreaterThan(0),
      WAIT,
    );
    probe.fireFrame(fatal("not_admitted", TEAM_REFUSAL));
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcomeOf()).toBe("running");

    answerMint.current(new Response("no row", { status: 404 }));

    await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
    expect(ended?.error).toMatchObject({
      code: CLI_ERROR_CODES.FORBIDDEN,
      message: "",
    });
    expect(monitorHarness.sockets.map(openToken)).toEqual([
      NO_HOST_TOKEN_PROBE,
    ]);
  });

  it("ignores a not-admitted mint begun before the host admitted the sign-in", async () => {
    const answerMint: { current: (response: Response) => void } = {
      current: () => undefined,
    };
    monitorHarness.state.grantResponse = () =>
      new Promise<Response>((resolve) => {
        answerMint.current = resolve;
      });
    startMonitor();
    const probe = await socketAt(0);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    // A current personal host names its reason, and takes the sign-in.
    probe.fireFrame(
      fatal("owner_sign_in", "current personal host invited sign-in"),
    );
    await admitWith(await socketAt(1));

    expect(monitorHarness.state.grants).toBeGreaterThan(0);
    answerMint.current(new Response("no row", { status: 404 }));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await outcomeOf()).toBe("running");
    expect(monitorHarness.sockets.map(openToken)).toEqual([
      NO_HOST_TOKEN_PROBE,
      SIGN_IN,
    ]);
  });

  function holdUsableTokens(tokens: ReadonlyMap<string, string>): void {
    monitorHarness.state.hostTokenTable = new Map([
      [
        USER_ID,
        new Map(
          Array.from(tokens, ([hostId, token]) => [
            hostId,
            { token, expiresAtMs: Date.now() + 60 * 60 * 1000 },
          ]),
        ),
      ],
    ]);
  }

  /** A mint authn takes and has not answered: the test answers it when it chooses. */
  function holdMint(): { readonly answer: (response: Response) => void } {
    const held: { resolve: (response: Response) => void } = {
      resolve: () => undefined,
    };
    monitorHarness.state.grantResponse = () =>
      new Promise<Response>((resolve) => {
        held.resolve = resolve;
      });
    return { answer: (response) => held.resolve(response) };
  }

  /** Every mint authn takes is held: the test answers each by its order. */
  function holdMints(): {
    readonly answer: (index: number, response: Response) => void;
  } {
    const held: ((response: Response) => void)[] = [];
    monitorHarness.state.grantResponse = () =>
      new Promise<Response>((resolve) => {
        held.push(resolve);
      });
    return {
      answer: (index, response) => {
        held[index]?.(response);
      },
    };
  }

  function grantedToken(token: string): Response {
    return new Response(
      JSON.stringify({ session_grant: token, session_grant_expires_in: 3600 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  /** The host's process is replaced: the poll reads a new one at the same host id. */
  async function replaceHostProcess(): Promise<void> {
    monitorHarness.state.pid += 1;
    monitorHarness.state.startedAt = `2026-01-01T0${monitorHarness.state.pid}:00:00.000Z`;
    await letPollRead();
  }

  function drop(
    socket: InstanceType<typeof monitorHarness.ScriptSocket>,
  ): void {
    socket.onclose?.({ code: 1006, reason: "drop", wasClean: false });
  }

  async function ackOpen(
    socket: InstanceType<typeof monitorHarness.ScriptSocket>,
    open: Record<string, unknown>,
  ): Promise<void> {
    socket.fireFrame({
      kind: "openAck",
      manifest: open.manifest,
      optionalManifest: open.optionalManifest,
    });
    await vi.waitFor(
      () =>
        expect(
          socket.sent.some((raw) => raw.includes('"kind":"subscribe"')),
        ).toBe(true),
      WAIT,
    );
  }

  /** The monitor's endpoint poll runs every two seconds. */
  async function letPollRead(): Promise<void> {
    await vi.advanceTimersByTimeAsync(2_100);
  }

  /**
   * No token is held and the mint is pending. The probe gets `owner_sign_in`:
   * resolves with the socket dialed for the invited sign-in, not yet opened.
   */
  async function inviteSignIn(): Promise<
    InstanceType<typeof monitorHarness.ScriptSocket>
  > {
    const probe = await socketAt(0);
    expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
    await vi.waitFor(
      () => expect(monitorHarness.state.grants).toBeGreaterThan(0),
      WAIT,
    );
    probe.fireFrame(
      fatal("owner_sign_in", "current personal host invited sign-in"),
    );
    return socketAt(1);
  }

  describe("a credential is keyed by the host its socket was selected for", () => {
    it("opens a socket selected for host A with A's token though the endpoint poll has since read host B", async () => {
      const hostA = monitorHarness.state.hostId;
      const hostB = nextHostId();
      holdUsableTokens(
        new Map([
          [hostA, "token-for-a"],
          [hostB, "token-for-b"],
        ]),
      );
      startMonitor();
      // The dial to host A is waiting; the poll now reads host B's pid file.
      const first = await socketAt(0);
      monitorHarness.state.hostId = hostB;
      await letPollRead();

      const open = await readOpen(first);

      expect(open.token).toBe("token-for-a");
    });

    it("credits A's acknowledgement to A, so host B's first mint refusal still ends the monitor", async () => {
      const hostA = nextHostId();
      const hostB = monitorHarness.state.hostId;
      holdUsableTokens(new Map([[hostA, "token-for-a"]]));
      const mint = holdMint();
      startMonitor();
      // Host B holds no token: its first dial probes, its mint begins and
      // stays pending, and it names a reason.
      const probe = await socketAt(0);
      expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
      monitorHarness.state.hostId = hostA;
      await letPollRead();
      probe.fireFrame(fatal("not_admitted", TEAM_REFUSAL));
      await vi.advanceTimersByTimeAsync(1_500);
      // The redial is selected for host A; the poll then reads host B again.
      const toA = await socketAt(1);
      monitorHarness.state.hostId = hostB;
      await letPollRead();

      const open = await readOpen(toA);
      expect(open.token).toBe("token-for-a");
      await ackOpen(toA, open);
      mint.answer(new Response("no row", { status: 404 }));

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(ended?.error).toMatchObject({ code: CLI_ERROR_CODES.FORBIDDEN });
    });

    it("asks authn for no mint of host A when host B's token is refused after A's was", async () => {
      const hostA = monitorHarness.state.hostId;
      const hostB = nextHostId();
      holdUsableTokens(
        new Map([
          [hostA, "token-for-a"],
          [hostB, "token-for-b"],
        ]),
      );
      startMonitor();
      const toA = await socketAt(0);
      expect((await readOpen(toA)).token).toBe("token-for-a");
      toA.fireFrame(fatal("token_expired", "host token expired"));
      await vi.waitFor(
        () => expect(monitorHarness.grantHosts).toContain(hostA),
        WAIT,
      );
      // Authn answers nothing for A's mint; the redial is selected for B.
      monitorHarness.state.hostId = hostB;
      await letPollRead();
      await vi.advanceTimersByTimeAsync(6_000);
      const toB = await socketAt(1);
      expect((await readOpen(toB)).token).toBe("token-for-b");
      const before = monitorHarness.grantHosts.length;

      toB.fireFrame(fatal("token_expired", "host token expired"));

      await vi.waitFor(
        () => expect(monitorHarness.grantHosts.length).toBeGreaterThan(before),
        WAIT,
      );
      expect(monitorHarness.grantHosts.slice(before)).toContain(hostB);
      expect(monitorHarness.grantHosts.slice(before)).not.toContain(hostA);
    });
  });

  describe("a mint's not-admitted against a current personal host's invited sign-in", () => {
    it("goes on to its subscription when the 404 lands after the invited OPEN and before its ack", async () => {
      const mint = holdMint();
      startMonitor();
      const invited = await inviteSignIn();
      const open = await readOpen(invited);
      expect(open.token).toBe(SIGN_IN);

      mint.answer(new Response("no row", { status: 404 }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await outcomeOf()).toBe("running");
      await ackOpen(invited, open);

      expect(await outcomeOf()).toBe("running");
      expect(monitorHarness.sockets.map(openToken)).toEqual([
        NO_HOST_TOKEN_PROBE,
        SIGN_IN,
      ]);
    });

    it("ends with the mint's line when the invited sign-in is refused and then the 404 lands", async () => {
      const mint = holdMint();
      startMonitor();
      const invited = await inviteSignIn();
      await readOpen(invited);

      invited.fireFrame(fatal("not_admitted", TEAM_REFUSAL));
      await vi.advanceTimersByTimeAsync(0);
      mint.answer(new Response("no row", { status: 404 }));

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(ended?.error).toMatchObject({ code: CLI_ERROR_CODES.FORBIDDEN });
    });

    // A guard: it passes on c8b3e988 by design. A 404 that lands before the
    // invited OPEN is written ends the command, and no sign-in is written.
    it("ends with the mint's line when the 404 lands before the invited OPEN is written, and writes no sign-in", async () => {
      const mint = holdMint();
      startMonitor();
      await inviteSignIn();

      mint.answer(new Response("no row", { status: 404 }));

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(ended?.error).toMatchObject({ code: CLI_ERROR_CODES.FORBIDDEN });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(
        monitorHarness.sockets.flatMap((socket) => socket.sent),
      ).not.toContainEqual(expect.stringContaining(SIGN_IN));
    });
  });

  describe("an invitation heard from one process instance of a host", () => {
    it("is stale once the poll reads a new process: the mint's 404 then ends the command with its line, after the new process names a reason that is no invitation", async () => {
      const mint = holdMint();
      startMonitor();
      const invited = await inviteSignIn();
      monitorHarness.state.pid = 2;
      monitorHarness.state.startedAt = "2026-01-01T01:00:00.000Z";
      await letPollRead();
      // The invited dial ends; the redial is the new process's own open.
      invited.onclose?.({ code: 1006, reason: "drop", wasClean: false });
      await vi.advanceTimersByTimeAsync(6_000);
      const own = await socketAt(2);
      expect((await readOpen(own)).token).toBe(NO_HOST_TOKEN_PROBE);
      own.fireFrame(fatal("not_admitted", TEAM_REFUSAL));
      await vi.advanceTimersByTimeAsync(0);
      expect(await outcomeOf()).toBe("running");

      mint.answer(new Response("no row", { status: 404 }));

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(ended?.error).toMatchObject({ code: CLI_ERROR_CODES.FORBIDDEN });
    });

    it("marks nothing for the new process when a named refusal from the old process's socket arrives late", async () => {
      startMonitor();
      const old = await socketAt(0);
      await readOpen(old);
      monitorHarness.state.pid = 2;
      monitorHarness.state.startedAt = "2026-01-01T01:00:00.000Z";
      await letPollRead();

      old.fireFrame(fatal("not_admitted", TEAM_REFUSAL));
      await vi.advanceTimersByTimeAsync(6_000);

      const redial = await socketAt(1);
      expect((await readOpen(redial)).token).toBe(NO_HOST_TOKEN_PROBE);
      redial.fireFrame(bareRefusal());
      await admitWith(await socketAt(2));
      expect(monitorHarness.sockets.map(openToken)).toEqual([
        NO_HOST_TOKEN_PROBE,
        NO_HOST_TOKEN_PROBE,
        SIGN_IN,
      ]);
    });
  });

  describe("a replacement process at the same host id", () => {
    it("is asked its own mint, and the earlier process's mint answering not-admitted ends nothing", async () => {
      const mints = holdMints();
      startMonitor();
      const earlier = await socketAt(0);
      expect((await readOpen(earlier)).token).toBe(NO_HOST_TOKEN_PROBE);
      await vi.waitFor(
        () => expect(monitorHarness.grantHosts).toHaveLength(1),
        WAIT,
      );
      await replaceHostProcess();
      drop(earlier);
      await vi.advanceTimersByTimeAsync(6_000);
      const own = await socketAt(1);
      expect((await readOpen(own)).token).toBe(NO_HOST_TOKEN_PROBE);

      // The replacement's bearer lookup asks authn for a mint of its own.
      await vi.waitFor(
        () => expect(monitorHarness.grantHosts.length).toBeGreaterThan(1),
        WAIT,
      );
      own.fireFrame(fatal("not_admitted", TEAM_REFUSAL));
      await vi.advanceTimersByTimeAsync(0);
      mints.answer(
        0,
        new Response(JSON.stringify({ code: "no_row" }), { status: 404 }),
      );
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await outcomeOf()).toBe("running");
    });

    it("does not end with the earlier process's reason when its recovery fails after the poll read the replacement", async () => {
      holdUsableTokens(new Map([[monitorHarness.state.hostId, "held-token"]]));
      const mints = holdMints();
      startMonitor();
      const earlier = await socketAt(0);
      expect((await readOpen(earlier)).token).toBe("held-token");
      earlier.fireFrame(fatal("token_expired", "host token expired"));
      await vi.waitFor(
        () => expect(monitorHarness.grantHosts).toHaveLength(1),
        WAIT,
      );
      await replaceHostProcess();

      mints.answer(
        0,
        new Response(JSON.stringify({ code: "team_membership_required" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      );
      await vi.advanceTimersByTimeAsync(6_000);

      expect(await outcomeOf()).toBe("running");
      const own = await socketAt(1);
      await readOpen(own);
      expect(openToken(own)).not.toBeNull();
    });

    it("ends with the mint's line on the replacement's first not-admitted mint after the earlier process's admitted connection left", async () => {
      const mints = holdMints();
      startMonitor();
      const probe = await socketAt(0);
      expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
      probe.fireFrame(
        fatal("owner_sign_in", "current personal host invited sign-in"),
      );
      // The earlier process admits the sign-in; the replacement is read; the earlier connection leaves.
      const admitted = await socketAt(1);
      await admitWith(admitted);
      await replaceHostProcess();
      drop(admitted);
      await vi.advanceTimersByTimeAsync(6_000);
      const own = await socketAt(2);
      expect((await readOpen(own)).token).toBe(NO_HOST_TOKEN_PROBE);
      await vi.waitFor(
        () => expect(monitorHarness.grantHosts.length).toBeGreaterThan(1),
        WAIT,
      );
      own.fireFrame(fatal("not_admitted", TEAM_REFUSAL));
      await vi.advanceTimersByTimeAsync(0);

      mints.answer(1, new Response("no row", { status: 404 }));

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(ended?.error).toMatchObject({ code: CLI_ERROR_CODES.FORBIDDEN });
    });

    it("re-subscribes only after the ordinary delay when a verdict arrives from a replaced process", async () => {
      holdUsableTokens(new Map([[monitorHarness.state.hostId, "held-token"]]));
      const mints = holdMints();
      startMonitor();
      const earlier = await socketAt(0);
      expect((await readOpen(earlier)).token).toBe("held-token");
      earlier.fireFrame(fatal("token_expired", "host token expired"));
      await vi.waitFor(
        () => expect(monitorHarness.grantHosts).toHaveLength(1),
        WAIT,
      );
      await replaceHostProcess();

      mints.answer(0, grantedToken("fresh-1"));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(monitorHarness.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await socketAt(1);
      expect(await outcomeOf()).toBe("running");
    });

    it("reaches the refresh bound through three replaced processes, every re-subscribe paced", async () => {
      holdUsableTokens(new Map([[monitorHarness.state.hostId, "held-token"]]));
      const mints = holdMints();
      startMonitor();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const socket = await socketAt(attempt);
        await readOpen(socket);
        socket.fireFrame(fatal("token_expired", "host token expired"));
        await vi.waitFor(
          () => expect(monitorHarness.grantHosts).toHaveLength(attempt + 1),
          WAIT,
        );
        await replaceHostProcess();
        mints.answer(attempt, grantedToken(`fresh-${attempt + 1}`));
        if (attempt < 3) {
          await vi.advanceTimersByTimeAsync(1_000);
          expect(monitorHarness.sockets).toHaveLength(attempt + 1);
          // The re-subscribe comes after the ordinary 5 s delay.
          await vi.advanceTimersByTimeAsync(5_000);
        }
      }

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(ended?.error).toMatchObject({
        message: expect.stringContaining("session rejected after 4 refreshes"),
      });
    });

    it("ends for a replaced process when the person's sign-in itself is rejected", async () => {
      holdUsableTokens(new Map([[monitorHarness.state.hostId, "held-token"]]));
      monitorHarness.state.refresh = "rejected";
      const mints = holdMints();
      startMonitor();
      const earlier = await socketAt(0);
      expect((await readOpen(earlier)).token).toBe("held-token");
      earlier.fireFrame(fatal("token_expired", "host token expired"));
      await vi.waitFor(
        () => expect(monitorHarness.grantHosts).toHaveLength(1),
        WAIT,
      );
      await replaceHostProcess();

      mints.answer(0, new Response("rejected", { status: 401 }));

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(ended?.error).toMatchObject({
        message: expect.stringContaining("The stored credential was rejected"),
      });
    });

    it("does not end when an older mint answers not-a-member after a newer mint, begun on a refreshed sign-in, succeeded", async () => {
      // The background mints ask with the old sign-in; the proactive upkeep then refreshes
      // the sign-in and buys a token with the new one, a mint that does not join them.
      const oldSignIn = expiredJwt(
        Date.now() + 10 * 60 * 1000 + UPKEEP_FIRES_AT_MS,
      );
      const newSignIn = expiredJwt(Date.now() + 8 * 60 * 60 * 1000);
      monitorHarness.state.signIn = oldSignIn;
      monitorHarness.state.refreshedSignIn = newSignIn;
      monitorHarness.state.firstRotation = "applied";
      monitorHarness.state.realRevalidator = true;
      const mints = holdMints();
      const startedAt = Date.now();
      startMonitor();
      await socketAt(0);
      // The old-sign-in mints retry on the stream's own dial cadence (observed at 10 ms,
      // 10.5 s, 21.5 s, 33.5 s, 47.5 s, growing); the upkeep fires inside the next retry's life.
      for (
        let step = 0;
        step < 400 && !monitorHarness.grantSignIns.includes(newSignIn);
        step += 1
      ) {
        await vi.advanceTimersByTimeAsync(250);
      }
      // Each request is told apart by the sign-in it carried; the older one must still be live.
      const newer = monitorHarness.grantSignIns.indexOf(newSignIn);
      const older = monitorHarness.grantSignIns
        .slice(0, Math.max(newer, 0))
        .lastIndexOf(oldSignIn);
      expect(newer).toBeGreaterThan(-1);
      expect(older).toBeGreaterThan(-1);
      const timeline = monitorHarness.grantSignIns
        .map(
          (signIn, index) =>
            `${signIn === newSignIn ? "new" : "old"}@${(monitorHarness.grantStartedAt[index] ?? 0) - startedAt}ms`,
        )
        .join(" ");
      expect(
        (monitorHarness.grantStartedAt[newer] ?? 0) -
          (monitorHarness.grantStartedAt[older] ?? 0),
        `authn requests: ${timeline}`,
      ).toBeLessThan(9_000);

      mints.answer(newer, grantedToken("fresh-newer"));
      await vi.advanceTimersByTimeAsync(1_000);
      mints.answer(
        older,
        new Response(JSON.stringify({ code: "team_membership_required" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      );
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await outcomeOf()).toBe("running");
    });

    it("does not end on host A's refresh count when the endpoint moved to host B first, and counts B from zero", async () => {
      const hostA = monitorHarness.state.hostId;
      const hostB = nextHostId();
      holdUsableTokens(
        new Map([
          [hostA, "token-a"],
          [hostB, "token-b"],
        ]),
      );
      // The first three recoveries are answered at once; the fourth is held.
      const fourth: { release: (response: Response) => void } = {
        release: () => undefined,
      };
      monitorHarness.state.grantResponse = () =>
        monitorHarness.state.grants === 4
          ? new Promise<Response>((resolve) => {
              fourth.release = resolve;
            })
          : Promise.resolve(
              grantedToken(`fresh-${monitorHarness.state.grants}`),
            );
      startMonitor();
      // Host A refuses its token on three admitted opens: each recovery rotates and counts.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const socket = await socketAt(attempt);
        await admitWith(socket);
        socket.fireFrame(fatal("token_expired", "host token expired"));
        await vi.waitFor(
          () => expect(monitorHarness.grantHosts).toHaveLength(attempt + 1),
          WAIT,
        );
      }
      // The fourth refusal's recovery is pending when the endpoint moves to host B.
      const fourthSocket = await socketAt(3);
      await admitWith(fourthSocket);
      fourthSocket.fireFrame(fatal("token_expired", "host token expired"));
      await vi.waitFor(
        () => expect(monitorHarness.grantHosts).toHaveLength(4),
        WAIT,
      );
      monitorHarness.state.hostId = hostB;
      await letPollRead();

      fourth.release(grantedToken("fresh-4"));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await outcomeOf()).toBe("running");
      expect(monitorHarness.sockets).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(5_000);
      const toB = await socketAt(4);
      await admitWith(toB);
      expect(openToken(toB)).toBe("token-b");
      // Host B's first refusal is its first count, so its recovery rotates and goes on.
      toB.fireFrame(fatal("token_expired", "host token expired"));
      await vi.waitFor(
        () => expect(monitorHarness.grantHosts).toHaveLength(5),
        WAIT,
      );
      await socketAt(5);
      expect(await outcomeOf()).toBe("running");
    });

    it("ends at the cap through successive replaced processes whose recoveries are each rejected, every re-subscribe paced", async () => {
      holdUsableTokens(new Map([[monitorHarness.state.hostId, "held-token"]]));
      const mints = holdMints();
      startMonitor();
      let rounds = 0;
      for (; rounds < 6 && ended === null; rounds += 1) {
        const socket = await socketAt(rounds);
        await readOpen(socket);
        socket.fireFrame(fatal("token_expired", "host token expired"));
        await vi.waitFor(
          () => expect(monitorHarness.grantHosts).toHaveLength(rounds + 1),
          WAIT,
        );
        await replaceHostProcess();
        // authn has no row for the host: the recovery is rejected, and the person is still signed in.
        mints.answer(
          rounds,
          new Response(JSON.stringify({ code: "no_row" }), { status: 404 }),
        );
        await vi.advanceTimersByTimeAsync(1_000);
        if (ended === null) {
          expect(monitorHarness.sockets).toHaveLength(rounds + 1);
          await vi.advanceTimersByTimeAsync(5_000);
        }
      }

      expect(ended).not.toBeNull();
      expect(rounds).toBeGreaterThanOrEqual(3);
      expect(rounds).toBeLessThanOrEqual(4);
    });

    it("refreshes once for real, and does not end, when a mint is refused, a sibling's pair is adopted, and the next mint is refused again", async () => {
      monitorHarness.state.realRevalidator = true;
      monitorHarness.state.grantResponse = () =>
        Promise.resolve(
          monitorHarness.state.grants <= 2
            ? new Response("rejected", { status: 401 })
            : grantedToken("fresh-after-refresh"),
        );
      startMonitor();
      await socketAt(0);

      await vi.waitFor(
        () =>
          expect(monitorHarness.state.rotations).toEqual([
            "superseded",
            "applied",
          ]),
        WAIT,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await outcomeOf()).toBe("running");
    });

    it("subscribes to the new endpoint, and does not end, when the endpoint changes host id during a pending recovery that is then rejected", async () => {
      const hostA = monitorHarness.state.hostId;
      const hostB = nextHostId();
      holdUsableTokens(
        new Map([
          [hostA, "token-a"],
          [hostB, "token-b"],
        ]),
      );
      const mints = holdMints();
      startMonitor();
      const toA = await socketAt(0);
      expect((await readOpen(toA)).token).toBe("token-a");
      toA.fireFrame(fatal("token_expired", "host token expired"));
      await vi.waitFor(
        () => expect(monitorHarness.grantHosts).toEqual([hostA]),
        WAIT,
      );
      monitorHarness.state.hostId = hostB;
      await letPollRead();

      mints.answer(
        0,
        new Response(JSON.stringify({ code: "team_membership_required" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      );
      await vi.advanceTimersByTimeAsync(6_000);

      expect(await outcomeOf()).toBe("running");
      const toB = await socketAt(1);
      expect((await readOpen(toB)).token).toBe("token-b");
    });

    it("gives the replacement a fresh-mint recovery of its own after the earlier process's was spent", async () => {
      holdUsableTokens(new Map([[monitorHarness.state.hostId, "held-token"]]));
      monitorHarness.state.grantResponse = () =>
        Promise.resolve(grantedToken(`fresh-${monitorHarness.state.grants}`));
      startMonitor();
      const earlier = await socketAt(0);
      expect((await readOpen(earlier)).token).toBe("held-token");
      earlier.fireFrame(fatal("token_expired", "host token expired"));
      // The earlier process's one recovery mints a token and the redial presents it.
      const redial = await socketAt(1);
      expect((await readOpen(redial)).token).toBe("fresh-1");
      await replaceHostProcess();
      drop(redial);
      await vi.advanceTimersByTimeAsync(6_000);
      const own = await socketAt(2);
      expect((await readOpen(own)).token).toBe("fresh-1");
      const before = monitorHarness.grantHosts.length;

      own.fireFrame(fatal("token_expired", "host token expired"));

      await vi.waitFor(
        () => expect(monitorHarness.grantHosts.length).toBeGreaterThan(before),
        WAIT,
      );
      expect(await outcomeOf()).toBe("running");
    });
  });

  describe("a host's named reason is forgotten when its process instance changes", () => {
    /** A host that named a reason in this process, then refuses the probe bare: a released host's answer. */
    async function refuseProbeBare(
      afterInstanceChange: () => Promise<void>,
    ): Promise<void> {
      nameReason(monitorHarness.state.hostId);
      startMonitor();
      const probe = await socketAt(0);
      await readOpen(probe);
      await afterInstanceChange();
      probe.fireFrame(bareRefusal());
    }

    it("opens the placeholder first for the new process, and sends the sign-in only after it refuses bare", async () => {
      await refuseProbeBare(async () => {
        monitorHarness.state.pid = 2;
        monitorHarness.state.startedAt = "2026-01-01T01:00:00.000Z";
        await letPollRead();
      });

      // The refusal answered the earlier process's open: it says nothing of the new one.
      const redial = await socketAt(1);
      expect((await readOpen(redial)).token).toBe(NO_HOST_TOKEN_PROBE);
      redial.fireFrame(bareRefusal());
      await admitWith(await socketAt(2));
      expect(monitorHarness.sockets.map(openToken)).toEqual([
        NO_HOST_TOKEN_PROBE,
        NO_HOST_TOKEN_PROBE,
        SIGN_IN,
      ]);
      expect(await outcomeOf()).toBe("running");
    });

    // A control: it passes on c8b3e988 by design. The same process refusing
    // bare is not a released host, so no sign-in goes.
    it("sends no sign-in after a bare refusal from the same process instance", async () => {
      await refuseProbeBare(async () => {
        await letPollRead();
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(
        monitorHarness.sockets.flatMap((socket) => socket.sent),
      ).not.toContainEqual(expect.stringContaining(SIGN_IN));
    });
  });

  describe("a released host that refuses the person's valid sign-in bare", () => {
    /** Refuses every OPEN the monitor writes, as a released host does, until the monitor ends. */
    async function refuseEveryOpenBare(reason: string): Promise<void> {
      const handled = new Set<
        InstanceType<typeof monitorHarness.ScriptSocket>
      >();
      for (let step = 0; step < 40 && ended === null; step += 1) {
        await vi.advanceTimersByTimeAsync(500);
        for (const socket of monitorHarness.sockets) {
          if (handled.has(socket) || socket.onopen === null) continue;
          handled.add(socket);
          socket.fireOpen();
          await vi.advanceTimersByTimeAsync(0);
          socket.fireFrame(releasedRefusalWith(reason));
        }
      }
    }

    /** What the command's own handler printed for the error that ended it. */
    function fatalLinesPrinted(): string[] {
      return monitorHarness.printed.filter((line) =>
        line.startsWith("[traycer monitor] fatal:"),
      );
    }

    /** The real `traycer monitor` command: its error is rendered by the program's own handler. */
    function startMonitorCommand(): void {
      vi.stubEnv("TRAYCER_EPIC_ID", "epic-a");
      ended = null;
      const program = buildProgramWithAgentRoles(false);
      program.exitOverride();
      program.configureOutput({
        writeErr: () => undefined,
        writeOut: () => undefined,
      });
      const running = program
        .parseAsync(["monitor", "--agent-id", "agent-a"], { from: "user" })
        .then((): void => undefined);
      monitorRun = running;
      running.then(
        () => {
          ended = { error: null };
        },
        (error: unknown) => {
          ended = { error };
        },
      );
    }

    it.each(RELEASED_REASONS)(
      "prints the released monitor's line naming the host's reason and exits 1: %s",
      async (reason) => {
        monitorHarness.state.refresh = "rotated";
        startMonitorCommand();

        await refuseEveryOpenBare(reason);

        await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
        expect(fatalLinesPrinted()).toEqual([
          `[traycer monitor] fatal: traycer monitor: ${reason} — the agent/epic may be invalid or inaccessible (check --agent-id and TRAYCER_EPIC_ID).\n`,
        ]);
        expect(monitorHarness.exits).toEqual([1]);
      },
    );

    it("ends with a plain Error carrying no code, as the released monitor's refusal did", async () => {
      monitorHarness.state.refresh = "rotated";
      startMonitor();

      await refuseEveryOpenBare(RELEASED_REASONS[0]);

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(ended?.error).toBeInstanceOf(Error);
      expect(ended?.error).not.toHaveProperty("code");
    });

    it("prints the session-expired line when authn rejects the refresh and the host refuses the sign-in", async () => {
      monitorHarness.state.refresh = "rejected";
      startMonitorCommand();

      await refuseEveryOpenBare(RELEASED_REASONS[0]);

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(fatalLinesPrinted()).toEqual([
        "[traycer monitor] fatal: traycer monitor: session expired — re-authenticate.\n",
      ]);
      expect(monitorHarness.exits).toEqual([1]);
    });

    it("prints the session-expired line when authn refuses the first host-only mint after a released host refused the placeholder bare", async () => {
      monitorHarness.state.refresh = "rotated";
      const mint = holdMint();
      startMonitorCommand();
      const probe = await socketAt(0);
      expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
      await vi.waitFor(
        () => expect(monitorHarness.state.grants).toBeGreaterThan(0),
        WAIT,
      );
      probe.fireFrame(bareRefusal());
      const signIn = await socketAt(1);
      expect((await readOpen(signIn)).token).toBe(SIGN_IN);

      // The refresh authn accepted is followed by one more mint; it is refused too.
      mint.answer(new Response("rejected", { status: 401 }));
      await vi.waitFor(
        () => expect(monitorHarness.state.grants).toBeGreaterThan(1),
        WAIT,
      );
      mint.answer(new Response("rejected", { status: 401 }));

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(fatalLinesPrinted()).toEqual([
        "[traycer monitor] fatal: traycer monitor: session expired — re-authenticate.\n",
      ]);
      expect(monitorHarness.exits).toEqual([1]);
    });

    // A guard: it passes on c8b3e988 by design. With no released-way refusal
    // before it, the same mint refusal keeps the stored-credential line.
    it("keeps the stored-credential line when authn refuses the first mint and no released host has refused", async () => {
      monitorHarness.state.refresh = "rotated";
      const mint = holdMint();
      startMonitorCommand();
      const probe = await socketAt(0);
      expect((await readOpen(probe)).token).toBe(NO_HOST_TOKEN_PROBE);
      await vi.waitFor(
        () => expect(monitorHarness.state.grants).toBeGreaterThan(0),
        WAIT,
      );

      // The refresh authn accepted is followed by one more mint; it is refused too.
      mint.answer(new Response("rejected", { status: 401 }));
      await vi.waitFor(
        () => expect(monitorHarness.state.grants).toBeGreaterThan(1),
        WAIT,
      );
      mint.answer(new Response("rejected", { status: 401 }));

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(fatalLinesPrinted()).toEqual([
        "[traycer monitor] fatal: The stored credential was rejected. Run `traycer login` to re-authenticate.\n",
      ]);
      expect(monitorHarness.exits).toEqual([1]);
    });

    it("refreshes the sign-in once for real after a sibling's already-rotated pair was adopted and refused", async () => {
      monitorHarness.state.realRevalidator = true;
      startMonitorCommand();

      await refuseEveryOpenBare(RELEASED_REASONS[0]);

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      // The sibling's pair is adopted (authn was not asked), and only the next refusal spends a refresh.
      expect(monitorHarness.state.rotations.slice(0, 2)).toEqual([
        "superseded",
        "applied",
      ]);
      expect(monitorHarness.sockets.map(openToken)).toContain(
        "refreshed-token",
      );
    });

    // A guard: it passes at 91ad79a0c. The earlier process takes the released way
    // before the replacement is read, and the mints are refused after it.
    it("keeps the stored-credential line when a released host refused an earlier process and the mints are refused after the poll read the replacement", async () => {
      monitorHarness.state.refresh = "rotated";
      const mints = holdMints();
      startMonitorCommand();
      const earlier = await socketAt(0);
      expect((await readOpen(earlier)).token).toBe(NO_HOST_TOKEN_PROBE);
      await vi.waitFor(
        () => expect(monitorHarness.grantHosts).toHaveLength(1),
        WAIT,
      );
      // The earlier process takes the released way: its bare refusal is answered with the sign-in.
      earlier.fireFrame(bareRefusal());
      const signIn = await socketAt(1);
      expect((await readOpen(signIn)).token).toBe(SIGN_IN);
      await replaceHostProcess();
      drop(signIn);
      monitorHarness.state.grantResponse = () =>
        Promise.resolve(new Response("rejected", { status: 401 }));

      mints.answer(0, new Response("rejected", { status: 401 }));
      await vi.advanceTimersByTimeAsync(30_000);

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(fatalLinesPrinted()).toEqual([
        "[traycer monitor] fatal: The stored credential was rejected. Run `traycer login` to re-authenticate.\n",
      ]);
      expect(monitorHarness.exits).toEqual([1]);
    });

    it("keeps the stored-credential line when the poll read the replacement before the earlier process's bare refusal was processed", async () => {
      monitorHarness.state.refresh = "rotated";
      const mints = holdMints();
      startMonitorCommand();
      const earlier = await socketAt(0);
      expect((await readOpen(earlier)).token).toBe(NO_HOST_TOKEN_PROBE);
      await vi.waitFor(
        () => expect(monitorHarness.grantHosts).toHaveLength(1),
        WAIT,
      );
      await replaceHostProcess();
      // The refusal answers the earlier process's open; the replacement has refused nothing.
      earlier.fireFrame(bareRefusal());
      monitorHarness.state.grantResponse = () =>
        Promise.resolve(new Response("rejected", { status: 401 }));

      mints.answer(0, new Response("rejected", { status: 401 }));
      await vi.advanceTimersByTimeAsync(30_000);

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(fatalLinesPrinted()).toEqual([
        "[traycer monitor] fatal: The stored credential was rejected. Run `traycer login` to re-authenticate.\n",
      ]);
      expect(monitorHarness.exits).toEqual([1]);
    });

    // A guard: a host that named a reason in this process is never handed the sign-in, so
    // its bare refusal of the host-only token is an older host's.
    it("still prints the older-host line for a bare token refusal from a host that named a reason in this process", async () => {
      holdUsableTokens(new Map([[monitorHarness.state.hostId, "held-token"]]));
      nameReason(monitorHarness.state.hostId);
      startMonitor();
      const socket = await socketAt(0);
      await readOpen(socket);

      socket.fireFrame(releasedRefusalWith("released-host-token-refusal"));

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(ended?.error).toMatchObject({
        message: OLDER_HOST_SENTENCE,
        exitCode: 1,
      });
    });
  });

  describe("a team host that refuses a non-member", () => {
    // A guard: the monitor's line for this refusal is the one c8b3e988 printed.
    it("ends at once with the c8b3e988 line when the refusal names membership_removed", async () => {
      holdUsableTokens(new Map([[monitorHarness.state.hostId, "held-token"]]));
      startMonitor();
      const socket = await socketAt(0);
      await readOpen(socket);

      socket.fireFrame(teamRefusal("membership_removed"));

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(ended?.error).toBeInstanceOf(Error);
      expect(ended?.error).toMatchObject({
        message: "traycer monitor: host closed the stream: team admission",
      });
      expect(ended?.error).not.toHaveProperty("code");
    });

    // A guard: a refusal with no reason is an older host's, on c8b3e988 too.
    it("keeps a reasonless TEAM_MEMBERSHIP_REQUIRED on the older-host route", async () => {
      holdUsableTokens(new Map([[monitorHarness.state.hostId, "held-token"]]));
      startMonitor();
      const socket = await socketAt(0);
      await readOpen(socket);

      socket.fireFrame(teamRefusal(null));

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(ended?.error).toMatchObject({
        message: OLDER_HOST_SENTENCE,
        exitCode: 1,
      });
    });
  });

  describe("a held token the team host refused as not_admitted", () => {
    /** The held token is refused; the monitor takes its one recovery. Resolves with the refused socket. */
    async function refuseHeldToken(): Promise<
      InstanceType<typeof monitorHarness.ScriptSocket>
    > {
      holdUsableTokens(new Map([[monitorHarness.state.hostId, "held-token"]]));
      startMonitor();
      const socket = await socketAt(0);
      await readOpen(socket);
      socket.fireFrame(teamRefusal("not_admitted"));
      await vi.waitFor(
        () => expect(monitorHarness.state.grants).toBeGreaterThan(0),
        WAIT,
      );
      return socket;
    }

    const NO_ANSWER_FROM_AUTHN = [
      [
        "authn answers 503",
        (): Promise<Response> =>
          Promise.resolve(new Response("authn unavailable", { status: 503 })),
      ],
      [
        "authn is unreachable",
        (): Promise<Response> => Promise.reject(new TypeError("fetch failed")),
      ],
    ] as const;

    it.each(NO_ANSWER_FROM_AUTHN)(
      "keeps waiting, prints no verdict, and redials on its backoff when the recovery gets no answer: %s",
      async (_name, grant) => {
        monitorHarness.state.grantResponse = grant;
        await refuseHeldToken();

        await vi.advanceTimersByTimeAsync(1_000);
        expect(await outcomeOf()).toBe("running");
        await vi.advanceTimersByTimeAsync(5_000);

        await socketAt(1);
        expect(await outcomeOf()).toBe("running");
        expect(monitorHarness.printed.join("")).not.toContain("not a member");
      },
    );

    it("is admitted by a later answered open, with no restart of the monitor", async () => {
      monitorHarness.state.grantResponse = NO_ANSWER_FROM_AUTHN[0][1];
      await refuseHeldToken();
      await vi.advanceTimersByTimeAsync(6_000);

      const retry = await socketAt(1);
      await admitWith(retry);

      expect(openToken(retry)).toBe("held-token");
      expect(await outcomeOf()).toBe("running");
    });

    it("ends with the team-membership line when the mint answers that the person is not a member", async () => {
      monitorHarness.state.grantResponse = () =>
        Promise.resolve(
          new Response(JSON.stringify({ code: "team_membership_required" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
        );
      await refuseHeldToken();

      await vi.waitFor(() => expect(ended).not.toBeNull(), WAIT);
      expect(ended?.error).toMatchObject({
        code: CLI_ERROR_CODES.TEAM_MEMBERSHIP_REQUIRED,
        message: NOT_A_MEMBER_SENTENCE,
        exitCode: 1,
      });
    });
  });
});

function expiredJwt(nowMs: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(nowMs / 1000) }),
  ).toString("base64url");
  return `${header}.${payload}.`;
}
