import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nameReason } from "./released-memory-test-support";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import type { HostTokenTable } from "../../../../shared/auth/host-token-store";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { callHostRpcAtEndpoint, toAgentCliError } from "../host-rpc";

// The unary call, over the real client and its real recovery, against a host
// whose answers a scripted socket gives. Authn is a stubbed refresh and a
// token table; no host is dialed.

const USER_ID = "user-1";
const SIGN_IN = "unary-sign-in";
const HELD_TOKEN = "unary-held-host-token";
/** The fake clock steps, and the longest the client may take to write an OPEN once its socket is open. */
const WAIT_STEP_MS = 10;
const OPEN_DEADLINE_MS = 5_000;

const OLDER_HOST_SENTENCE =
  "The host is out of date. Reinstall the latest host with 'traycer host update'.";

/** The reasons a released host gives for refusing a credential. */
const RELEASED_REASONS = [
  "Authenticated user does not own this host",
  "Host is not provisioned - run `traycer login` on the host machine to authorize it",
  "Token has been revoked",
] as const;

const harness = vi.hoisted(() => {
  class UnarySocket {
    onopen: ((event: { readonly type: "open" }) => void) | null = null;
    onmessage: ((event: { readonly data: string }) => void) | null = null;
    onerror: ((event: { readonly type: "error" }) => void) | null = null;
    onclose:
      | ((event: {
          readonly code: number;
          readonly reason: string;
          readonly wasClean: boolean;
        }) => void)
      | null = null;
    readonly sent: string[] = [];
    /** Settles when the client writes its first frame: its OPEN. */
    readonly openWritten: Promise<void>;
    private noteOpenWritten: () => void = () => undefined;

    constructor() {
      this.openWritten = new Promise<void>((resolve) => {
        this.noteOpenWritten = resolve;
      });
    }

    send(data: string): void {
      this.sent.push(data);
      this.noteOpenWritten();
    }

    close(_code: number, _reason: string): void {}

    fireOpen(): void {
      this.onopen?.({ type: "open" });
    }

    fireMessage(frame: unknown): void {
      this.onmessage?.({ data: JSON.stringify(frame) });
    }
  }
  return {
    UnarySocket,
    sockets: [] as InstanceType<typeof UnarySocket>[],
    state: {
      table: new Map() as HostTokenTable,
      refresh: "network-error" as "network-error" | "rotated" | "rejected",
    },
  };
});

vi.mock("../host-auth", () => ({
  resolveHostAuth: async () => ({
    token: SIGN_IN,
    authnBaseUrl: "https://authn.test",
    userId: USER_ID,
  }),
}));

vi.mock("../../logger", () => {
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return {
    createCliLogger: () => logger,
    noopLogger: logger,
    errorFromUnknown: (value: unknown) =>
      value instanceof Error ? value : new Error(String(value)),
  };
});

vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createCliCredentialsStore: () => ({ dispose: () => undefined }),
    createStoreBackedRevalidator: () => ({
      revalidateCurrentContext: async () => harness.state.refresh,
    }),
  };
});

vi.mock("@traycer-clients/shared/auth/host-token-file", () => ({
  createHostTokenFilePersistence: () => ({
    load: async () => harness.state.table,
    update: async (change: (table: HostTokenTable) => HostTokenTable) => {
      harness.state.table = change(harness.state.table);
      return harness.state.table;
    },
  }),
}));

vi.mock("@traycer-clients/shared/host-transport/remote/grant-client", () => ({
  mintHostTokenViaHttp: async () => ({ kind: "unavailable", detail: "none" }),
}));

vi.mock("../../../../shared/host-transport/whatwg-ws-factory", () => ({
  createWhatwgWebSocketFactory: () => ({
    create: () => {
      const socket = new harness.UnarySocket();
      harness.sockets.push(socket);
      return socket;
    },
  }),
}));

let hostCount = 0;
let hostId = "";

function endpoint(): { hostId: string; websocketUrl: string } {
  return { hostId, websocketUrl: "ws://127.0.0.1:9/rpc" };
}

const params = {
  epicId: "epic-1",
  senderAgentId: "agent-1",
  scope: "user" as const,
};

beforeEach(() => {
  vi.useFakeTimers();
  harness.sockets.splice(0);
  harness.state.refresh = "network-error";
  hostCount += 1;
  // A named reason is remembered per computer for the whole process.
  hostId = `33333333-3333-4333-8333-${String(hostCount).padStart(12, "0")}`;
  harness.state.table = new Map([
    [
      USER_ID,
      new Map([
        [hostId, { token: HELD_TOKEN, expiresAtMs: Date.now() + 3_600_000 }],
      ]),
    ],
  ]);
  processReleasedHosts.forgetAll();
});

afterEach(() => {
  processReleasedHosts.forgetAll();
  vi.useRealTimers();
});

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

/** Refuses every OPEN the call writes the same way, until the call settles. */
async function refuseEveryOpen(
  call: Promise<unknown>,
  refusal: Record<string, unknown>,
): Promise<void> {
  const finished = { value: false };
  const note = (): void => {
    finished.value = true;
  };
  void call.then(note, note);
  const handled = new Set<InstanceType<typeof harness.UnarySocket>>();
  for (let step = 0; step < 400 && !finished.value; step += 1) {
    for (const socket of harness.sockets) {
      if (handled.has(socket) || socket.onopen === null) continue;
      handled.add(socket);
      socket.fireOpen();
      // The client writes its OPEN once the socket is open; the host answers that.
      const written = { value: false };
      void socket.openWritten.then(() => {
        written.value = true;
      });
      for (let waited = 0; !written.value && !finished.value;) {
        if (waited >= OPEN_DEADLINE_MS) {
          throw new Error(
            `expected an OPEN frame on socket ${harness.sockets.indexOf(socket)}, none written in ${OPEN_DEADLINE_MS} ms`,
          );
        }
        await vi.advanceTimersByTimeAsync(WAIT_STEP_MS);
        waited += WAIT_STEP_MS;
      }
      socket.fireMessage(refusal);
    }
    await vi.advanceTimersByTimeAsync(WAIT_STEP_MS);
  }
}

function run(refusal: Record<string, unknown>): Promise<unknown> {
  const call = toAgentCliError(
    callHostRpcAtEndpoint("agent.list", params, endpoint()),
  ).then(
    () => null,
    (error: unknown) => error,
  );
  return refuseEveryOpen(call, refusal).then(() => call);
}

describe("a unary call to a released host that refuses the person's valid sign-in bare", () => {
  it.each(RELEASED_REASONS)(
    "rejects with the host's reason as the stored credential's refusal: %s",
    async (reason) => {
      harness.state.refresh = "rotated";

      const error = await run(releasedRefusalWith(reason));

      expect(error).toMatchObject({
        code: CLI_ERROR_CODES.AUTH_REJECTED,
        message: reason,
        exitCode: 1,
      });
    },
  );

  // A guard: a host that named a reason in this process is never handed the sign-in, so
  // its bare refusal of the host-only token is an older host's.
  it("still prints the older-host line for a bare token refusal from a host that named a reason in this process", async () => {
    nameReason(hostId);

    const error = await run(releasedRefusalWith("released-host-token-refusal"));

    expect(error).toMatchObject({
      message: OLDER_HOST_SENTENCE,
      exitCode: 1,
    });
  });
});

describe("a unary call to a team host that refuses a non-member", () => {
  // A guard: a named TEAM_MEMBERSHIP_REQUIRED prints the generic line c8b3e988
  // printed, the host's own message.
  it.each(["not_admitted", "membership_removed"] as const)(
    "rejects with the host's own message, as c8b3e988 did, when the refusal names %s",
    async (doorReason) => {
      const error = await run(teamRefusal(doorReason));

      expect(error).toMatchObject({
        code: CLI_ERROR_CODES.UNEXPECTED,
        message: "team admission",
        exitCode: 1,
      });
    },
  );

  // A guard: a refusal with no reason is an older host's, on c8b3e988 too.
  it("keeps a reasonless TEAM_MEMBERSHIP_REQUIRED on the older-host route", async () => {
    const error = await run(teamRefusal(null));

    expect(error).toMatchObject({
      message: OLDER_HOST_SENTENCE,
      exitCode: 1,
    });
  });
});
