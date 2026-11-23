import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inviteReason, nameReason } from "./released-memory-test-support";
import { callHostRpcAtEndpoint, toAgentCliError } from "../host-rpc";
import { resolveHostAuth } from "../host-auth";
import {
  HostRpcError,
  type HostRequestOptions,
} from "../../../../shared/host-transport/host-messenger";
import type { WsRpcClientOptions } from "../../../../shared/host-transport/ws-rpc-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/registry";
import { CLI_ERROR_CODES } from "../../runner/errors";
import {
  MutableBearerLease,
  type BearerLease,
} from "../../../../shared/auth/bearer-source";
import { acquireCliSignIn, type CliSignInHandle } from "../cli-host-tokens";
import { processReleasedHosts } from "@traycer-clients/shared/host-transport/released-sign-on";
import type { HostTokenTable } from "../../../../shared/auth/host-token-store";
import { nextCasePerson } from "./case-person-test-support";

const state = vi.hoisted(() => {
  const requests = vi.fn();
  const mintOutcomes: Array<unknown> = [];
  let table: HostTokenTable = new Map();
  const revalidate = vi.fn();
  const dispose = vi.fn();
  // While set, the stand-in revalidator's adopting read reports it was reached and waits to be released.
  const adoption: { hold: { reached: () => void; released: Promise<void> } | null } = {
    hold: null,
  };
  const mint = vi.fn(async () => {
    const next = mintOutcomes.shift();
    if (next !== undefined) return next;
    return {
      kind: "ok" as const,
      token: {
        token: `host-${mint.mock.calls.length}`,
        expiresAtMs: Date.now() + 3_600_000,
      },
    };
  });
  return {
    requests,
    mintOutcomes,
    mint,
    revalidate,
    dispose,
    adoption,
    get table() {
      return table;
    },
    set table(value: HostTokenTable) {
      table = value;
    },
  };
});

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

type ClientOptions = WsRpcClientOptions<HostRpcRegistry>;

vi.mock(
  "../../../../shared/host-transport/ws-rpc-client",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../shared/host-transport/ws-rpc-client")
      >();
    const { resolveStubbedCallBearer } = await import("./stub-rpc-bearer");
    return {
      ...actual,
      WsRpcClient: class {
        constructor(private readonly clientOptions: ClientOptions) {}
        request = async (
          method: string,
          params: unknown,
          options: HostRequestOptions,
        ) =>
          state.requests(
            method,
            params,
            await resolveStubbedCallBearer(this.clientOptions, method, options),
          );
        releaseIdleLocalSessions = vi.fn();
      },
    };
  },
);

vi.mock("@traycer-clients/shared/auth/host-token-file", () => ({
  createHostTokenFilePersistence: () => ({
    load: async () => state.table,
    update: async (change: (table: HostTokenTable) => HostTokenTable) => {
      state.table = change(state.table);
      return state.table;
    },
  }),
}));

vi.mock("@traycer-clients/shared/host-transport/remote/grant-client", () => ({
  mintHostTokenViaHttp: state.mint,
}));

vi.mock("../host-auth", () => ({ resolveHostAuth: vi.fn() }));
vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createCliCredentialsStore: vi.fn(() => ({ dispose: state.dispose })),
    createStoreBackedRevalidator: vi.fn(
      ({
        lease,
      }: {
        readonly lease: BearerLease & { rotate(token: string): void };
      }) => ({
        revalidateCurrentContext: state.revalidate,
        adoptStoredSignIn: async () => {
          const hold = state.adoption.hold;
          if (hold === null) return;
          hold.reached();
          await hold.released;
        },
        // A rotation it accepts installs a distinct sign-in, which the next mint is sent with.
        rotateSignIn: async () => {
          const tried = lease.getBearerToken();
          const outcome: unknown = await state.revalidate();
          const installed = outcome === "rotated" ? `${tried}+rotated` : null;
          if (installed !== null) lease.rotate(installed);
          return {
            outcome,
            installed,
            refused: outcome === "rejected" ? tried : null,
            accepted: installed,
          };
        },
      }),
    ),
  };
});
vi.mock("../logger", () => ({
  createCliLogger: () => logger,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
}));

const resolveAuthMock = vi.mocked(resolveHostAuth);
const refusedToken = (
  doorReason: "token_expired" | "not_admitted",
): HostRpcError =>
  new HostRpcError({
    code: "UNAUTHORIZED",
    message: "host refused the credential",
    requestId: "request-1",
    method: "agent.list",
    fatalDetails: {
      code: "UNAUTHORIZED",
      reason: "host refused the credential",
      incompatibleMethods: null,
      upgradeGuidance: null,
      doorReason,
    },
  });

const endpoint = { hostId: "host-1", websocketUrl: "ws://127.0.0.1:9/rpc" };
const params = {
  epicId: "epic-1",
  senderAgentId: "agent-1",
  scope: "user" as const,
};

// A person no earlier case used: the process-scope judge of a sign-in is kept per person.
let userId = "";

beforeEach(() => {
  userId = nextCasePerson().userId;
  state.mintOutcomes.length = 0;
  state.table = new Map();
  state.requests.mockReset();
  state.mint.mockClear();
  state.revalidate.mockReset();
  state.dispose.mockClear();
  state.adoption.hold = null;
  resolveAuthMock.mockResolvedValue({
    token: "signin",
    authnBaseUrl: "https://authn.test",
    userId,
  });
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose();
  vi.clearAllMocks();
});

describe("callHostRpc host-token mint recovery", () => {
  it("reports the rejected-credential line when the post-refresh mint is also refused", async () => {
    state.mintOutcomes.push(
      { kind: "sign-in-rejected" },
      { kind: "sign-in-rejected" },
    );
    state.revalidate.mockResolvedValue("rotated");

    await expect(
      toAgentCliError(callHostRpcAtEndpoint("agent.list", params, endpoint)),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "The stored credential was rejected. Run `traycer login` to re-authenticate.",
      exitCode: 1,
    });
    expect(state.mint).toHaveBeenCalledTimes(2);
    expect(state.revalidate).toHaveBeenCalledTimes(1);
    expect(state.requests).not.toHaveBeenCalled();
  });

  it("reports the rejected-credential line when the sign-in refresh itself is refused", async () => {
    state.mintOutcomes.push({ kind: "sign-in-rejected" });
    state.revalidate.mockResolvedValue("rejected");

    await expect(
      toAgentCliError(callHostRpcAtEndpoint("agent.list", params, endpoint)),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "The stored credential was rejected. Run `traycer login` to re-authenticate.",
      exitCode: 1,
    });
    expect(state.mint).toHaveBeenCalledTimes(1);
    expect(state.revalidate).toHaveBeenCalledTimes(1);
    expect(state.requests).not.toHaveBeenCalled();
  });

  it.each(["token_expired", "not_admitted"] as const)(
    "does not send a third request when the replacement token is refused again for %s",
    async (doorReason) => {
      state.requests
        .mockRejectedValueOnce(refusedToken(doorReason))
        .mockRejectedValueOnce(refusedToken(doorReason));

      const error = await toAgentCliError(
        callHostRpcAtEndpoint("agent.list", params, endpoint),
      ).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(state.mint).toHaveBeenCalledTimes(2);
      expect(state.requests).toHaveBeenCalledTimes(2);
      expect(error).not.toMatchObject({
        message:
          "The stored credential was rejected. Run `traycer login` to re-authenticate.",
      });
    },
  );
});

/** The person's one lease takes `token`, as a sibling's save does; an empty token is a person signed out. */
function rotateLease(lease: BearerLease, token: string): void {
  if (!(lease instanceof MutableBearerLease))
    throw new Error("the person's lease is not rotatable");
  lease.rotate(token);
}

function emptyLease(lease: BearerLease): void {
  rotateLease(lease, "");
}

/** The handles a case took on its person's tokens; each is ended with the case. */
const handles: CliSignInHandle[] = [];

async function signedInHandle(): Promise<CliSignInHandle> {
  const handle = await acquireCliSignIn(
    { token: "signin", authnBaseUrl: "https://authn.test", userId },
    null,
  );
  handles.push(handle);
  return handle;
}

/** A person signed out, with a listener on what the command is told ends it. */
async function signedOutHandle(hostId: string): Promise<{
  readonly lease: BearerLease;
  readonly tokens: CliSignInHandle["tokens"];
  readonly ending: string[];
}> {
  const { lease, tokens } = await signedInHandle();
  const ending: string[] = [];
  tokens.onRefusalEndingCommand((evidence) => {
    ending.push(`${evidence.hostId}:${evidence.failure.kind}`);
  });
  emptyLease(lease);
  return { lease, tokens, ending };
}

/** Holds the stand-in revalidator's adopting read until released; `reached` settles once a read waits on it. */
function holdAdoptingRead(): {
  readonly reached: Promise<void>;
  readonly release: () => void;
} {
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    state.adoption.hold = { reached: resolve, released };
  });
  return { reached, release };
}

describe("createCliHostTokens refusals that end a command", () => {
  it("ends the command on a not-admitted mint begun in the same millisecond as the admission before it, once that connection has left", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      nameReason("host-same-millisecond");
      const { tokens } = await signedInHandle();
      const ending: string[] = [];
      tokens.onRefusalEndingCommand((evidence) => {
        ending.push(`${evidence.hostId}:${evidence.failure.kind}`);
      });
      // An open is admitted and its connection leaves; a mint then starts in
      // the same millisecond and authn has no row for it.
      tokens.admitted(
        processReleasedHosts.currentInstance("host-same-millisecond"),
      )();
      state.mintOutcomes.push({ kind: "not-admitted" });

      await tokens.mintFresh("host-same-millisecond", null);

      expect(ending).toEqual(["host-same-millisecond:not-admitted"]);
    } finally {
      now.mockRestore();
    }
  });

  it("ends nothing at the gate when the host invites the sign-in after a not-admitted was told and its invited open is still unanswered", async () => {
    const hostId = "host-invited-after-told";
    nameReason(hostId);
    const { tokens } = await signedInHandle();
    const ending: string[] = [];
    tokens.onRefusalEndingCommand((evidence) => {
      ending.push(`${evidence.hostId}:${evidence.failure.kind}`);
    });
    // A named reason and no invited sign-in pending: the not-admitted is told.
    state.mintOutcomes.push({ kind: "not-admitted" });
    await tokens.mintFresh(hostId, null);
    expect(ending).toEqual([`${hostId}:not-admitted`]);

    // The host invites the sign-in, and an open carrying it is written and not answered.
    inviteReason(hostId);
    processReleasedHosts.invitedSignInWritten(
      processReleasedHosts.currentInstance(hostId),
    );

    await expect(tokens.refusalEndingCommandNow(hostId)).resolves.toBeNull();
  });

  it("ends the command through the next not-admitted once the invited open is answered with a refusal", async () => {
    const hostId = "host-invited-answered-refused";
    nameReason(hostId);
    const instance = processReleasedHosts.currentInstance(hostId);
    const { tokens } = await signedInHandle();
    const ending: string[] = [];
    tokens.onRefusalEndingCommand((evidence) => {
      ending.push(`${evidence.hostId}:${evidence.failure.kind}`);
    });
    // An invited sign-in is on the wire: a not-admitted ends nothing yet.
    inviteReason(hostId);
    processReleasedHosts.invitedSignInWritten(instance);
    state.mintOutcomes.push({ kind: "not-admitted" });
    await tokens.mintFresh(hostId, null);
    expect(ending).toEqual([]);

    // The host answers the invited open with a refusal; the next not-admitted ends the command.
    processReleasedHosts.invitedSignInAnswered(instance);
    nameReason(hostId);
    state.mintOutcomes.push({ kind: "not-admitted" });
    await tokens.mintFresh(hostId, null);

    expect(ending).toEqual([`${hostId}:not-admitted`]);
    await expect(tokens.refusalEndingCommandNow(hostId)).resolves.toMatchObject(
      {
        kind: "host-refusal",
        failure: { kind: "not-admitted" },
      },
    );
  });

  it("ends the command on a no-sign-in answer while no sign-in is stored", async () => {
    const hostId = "host-no-sign-in-stored-none";
    const { tokens, ending } = await signedOutHandle(hostId);

    await tokens.mintFresh(hostId, null);

    expect(state.mint).not.toHaveBeenCalled();
    expect(ending).toEqual([`${hostId}:no-sign-in`]);
    await expect(tokens.refusalEndingCommandNow(hostId)).resolves.toMatchObject(
      {
        kind: "host-refusal",
        failure: { kind: "no-sign-in" },
      },
    );
  });

  it("answers null at the gate for a told no-sign-in once a sibling has saved a sign-in", async () => {
    const hostId = "host-no-sign-in-sibling-saved";
    const { lease, tokens, ending } = await signedOutHandle(hostId);
    await tokens.mintFresh(hostId, null);
    expect(state.mint).not.toHaveBeenCalled();
    expect(ending).toEqual([`${hostId}:no-sign-in`]);

    // A sibling saves a sign-in: the stored one is no longer none.
    rotateLease(lease, "signin");

    await expect(tokens.refusalEndingCommandNow(hostId)).resolves.toBeNull();
  });

  it("tells no ending, and the gate answers null, for a no-sign-in whose report finds a sign-in a sibling saved while the source's adopting read was held", async () => {
    const hostId = "host-no-sign-in-saved-during-read";
    const { lease, tokens, ending } = await signedOutHandle(hostId);
    // The source answers no-sign-in by itself, then reads the credentials file before it reports.
    const { reached, release } = holdAdoptingRead();

    const minting = tokens.mintFresh(hostId, null);
    await reached;
    rotateLease(lease, "signin");
    release();
    await minting;

    expect(state.mint).not.toHaveBeenCalled();
    expect(ending).toEqual([]);
    await expect(tokens.refusalEndingCommandNow(hostId)).resolves.toBeNull();
  });

  it("asks once more for the host process observed now when the process was replaced before the mint started, and the command goes on", async () => {
    const hostId = "host-replaced-before-mint";
    processReleasedHosts.observeInstance(hostId, "process-a");
    const ending: string[] = [];
    const { tokens } = await signedInHandle();
    tokens.onRefusalEndingCommand((evidence) => {
      ending.push(`${evidence.hostId}:${evidence.failure.kind}`);
    });

    // The host is replaced after the wrapper read the process it asks for and
    // before the mint starts.
    const minting = tokens.mintFresh(hostId, null);
    processReleasedHosts.observeInstance(hostId, "process-b");

    await expect(minting).resolves.toMatchObject({ kind: "ok" });
    expect(state.mint).toHaveBeenCalledTimes(1);
    expect(ending).toEqual([]);
  });
});
