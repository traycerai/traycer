import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import type { StreamFrameEnvelope } from "@traycer/protocol/host-transport/stream-session";
import {
  BOT_HOST_UPDATE_MESSAGE,
  BOT_SNAPSHOT_DEADLINE_MS,
} from "../../internal/bot-host";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandResult } from "../../runner/runner";
import {
  BOT_ID_A,
  BOT_ID_B,
  BOT_ID_C,
  OTHER_HOST_ID,
  THIS_HOST_ID,
  FakeStreamClient,
  botDeletedFrame,
  botRecord,
  botSnapshotFrame,
  botSubscribeClient,
  type FakeStreamSession,
  environmentDescriptor,
  fatalClose,
  makeCtx,
  routeRpc,
  unsupportedRpcError,
} from "./bot-test-support";
import { buildBotListCommand, groupByEnvironment } from "../bot-list";
import { createAuthenticatedUserFixture } from "../../../../shared/test-fixtures/authenticated-user";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
  noopLogger: loggerMock,
}));

const hoisted = vi.hoisted(() => ({
  callHostRpc: vi.fn(),
  resolveEndpoint: vi.fn(),
  openLocalStreamClient: vi.fn(),
  resolveHostAuth: vi.fn(),
  validateIdentity: vi.fn(),
  createCredentialsStore: vi.fn(),
  createStoreBackedRevalidator: vi.fn(),
  revalidateCurrentContext: vi.fn(),
  refreshOutcome: "rotated" as "rotated" | "rejected" | "network-error",
  refreshedToken: "refreshed-bearer",
}));

vi.mock("../../internal/host-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-auth")>();
  return { ...actual, resolveHostAuth: hoisted.resolveHostAuth };
});

vi.mock("../../../../shared/auth/auth-validation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../shared/auth/auth-validation")
    >();
  return {
    ...actual,
    validateAuthTokenIdentityAccessOnly: hoisted.validateIdentity,
  };
});

vi.mock("../../store/credentials-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../store/credentials-store")>();
  return {
    ...actual,
    createCliCredentialsStore: hoisted.createCredentialsStore,
    createStoreBackedRevalidator: hoisted.createStoreBackedRevalidator,
  };
});

vi.mock("../../internal/host-rpc", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/host-rpc")
  >("../../internal/host-rpc");
  return {
    ...actual,
    callHostRpc: hoisted.callHostRpc,
    resolveEndpoint: hoisted.resolveEndpoint,
  };
});

vi.mock("../../internal/bot-host", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/bot-host")
  >("../../internal/bot-host");
  return { ...actual, openLocalStreamClient: hoisted.openLocalStreamClient };
});

const ENDPOINT = {
  hostId: THIS_HOST_ID,
  websocketUrl: "ws://127.0.0.1:9999/rpc",
};

function signInUser(input: {
  readonly personalEnvironmentId: string | null;
  readonly teams: readonly {
    readonly teamId: string;
    readonly environmentId: string;
    readonly slug: string | null;
  }[];
}): AuthenticatedUser {
  const base = createAuthenticatedUserFixture(undefined);
  return {
    ...base,
    user: { ...base.user, id: "user-1" },
    environments: {
      personal: input.personalEnvironmentId,
      teams: input.teams.map(({ teamId, environmentId }) => ({
        teamId,
        environmentId,
      })),
    },
    teamSubscriptions: input.teams
      .filter((team) => team.slug !== null)
      .map(
        ({ teamId, slug }) =>
          ({
            team: { id: teamId, slug },
          }) as AuthenticatedUser["teamSubscriptions"][number],
      ),
  };
}

function signInUserFromDescriptors(
  environments: readonly EnvironmentDescriptor[],
): AuthenticatedUser {
  const personal = environments.find(
    (environment) => environment.label === "Personal",
  );
  return signInUser({
    personalEnvironmentId: personal?.environmentId ?? null,
    teams: environments
      .filter((environment) => environment !== personal)
      .map((environment) => ({
        teamId: environment.ownerId,
        environmentId: environment.environmentId,
        slug: environment.label,
      })),
  });
}

/** Wires the sign-in identity, host RPC boundary, and stream client for `bot list`. */
function stage(input: {
  /** Environments carried by the sign-in identity response. */
  readonly environments: readonly EnvironmentDescriptor[];
  /** Host-side answer, deliberately independent from the sign-in record. */
  readonly hostEnvironments?: readonly EnvironmentDescriptor[];
  readonly user?: AuthenticatedUser;
  readonly bots: readonly BotRecord[];
  readonly client: FakeStreamClient;
}): void {
  hoisted.resolveHostAuth.mockResolvedValue({
    token: "sign-in-bearer",
    authnBaseUrl: "https://authn.test",
    userId: "user-1",
  });
  hoisted.validateIdentity.mockResolvedValue({
    kind: "valid",
    user: input.user ?? signInUserFromDescriptors(input.environments),
  });
  hoisted.createCredentialsStore.mockReturnValue({ dispose: vi.fn() });
  hoisted.createStoreBackedRevalidator.mockImplementation(
    (args: { readonly lease: { rotate(token: string): void } }) => {
      hoisted.revalidateCurrentContext.mockImplementation(async () => {
        if (hoisted.refreshOutcome === "rotated") {
          args.lease.rotate(hoisted.refreshedToken);
        }
        return hoisted.refreshOutcome;
      });
      return { revalidateCurrentContext: hoisted.revalidateCurrentContext };
    },
  );
  hoisted.callHostRpc.mockImplementation(
    routeRpc({
      "environment.list": () => ({
        environments: input.hostEnvironments ?? input.environments,
      }),
      "bot.list": () => ({ bots: input.bots, mainBotIds: null }),
    }),
  );
  hoisted.openLocalStreamClient.mockResolvedValue({
    client: input.client,
    endpoint: ENDPOINT,
  });
}

function snapshotAnswers(
  entries: readonly (readonly [BotRecord, number])[],
): Record<string, StreamFrameEnvelope> {
  return Object.fromEntries(
    entries.map(
      ([bot, openRequests]): readonly [string, StreamFrameEnvelope] => [
        bot.botId,
        botSnapshotFrame(bot, [], openRequests),
      ],
    ),
  );
}

async function runList(): Promise<CommandResult> {
  return buildBotListCommand()(makeCtx());
}

beforeEach(() => {
  vi.resetAllMocks();
  hoisted.refreshOutcome = "rotated";
  hoisted.refreshedToken = "refreshed-bearer";
  hoisted.resolveEndpoint.mockResolvedValue(ENDPOINT);
  hoisted.resolveHostAuth.mockResolvedValue({
    token: "sign-in-bearer",
    authnBaseUrl: "https://authn.test",
    userId: "user-1",
  });
  hoisted.validateIdentity.mockResolvedValue({
    kind: "valid",
    user: signInUser({ personalEnvironmentId: null, teams: [] }),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A client that notes, at the moment it is closed, how many times each
 * session had been closed: a client closed before a read settled shows it.
 */
class RecordingClient extends FakeStreamClient {
  readonly sessionClosesAtClose: (readonly number[])[] = [];

  close(reason: string): void {
    this.sessionClosesAtClose.push(
      this.sessions.map((session) => session.closeCount),
    );
    super.close(reason);
  }
}

function botIdOf(session: FakeStreamSession): string {
  const params = session.params;
  if (
    typeof params !== "object" ||
    params === null ||
    !("botId" in params) ||
    typeof params.botId !== "string"
  ) {
    throw new Error("a bot.subscribe without a bot id");
  }
  return params.botId;
}

describe("bot list", () => {
  it("groups bots under the sign-in's environments, not environment.list, and marks this host's bots", async () => {
    const scout = botRecord({
      botId: BOT_ID_B,
      title: "Scout",
      environmentId: "env-personal",
      boundHostId: OTHER_HOST_ID,
    });
    const tracy = botRecord({
      botId: BOT_ID_A,
      title: "Tracy",
      environmentId: "env-team",
      boundHostId: THIS_HOST_ID,
    });
    stage({
      environments: [
        environmentDescriptor("env-personal", "Personal"),
        environmentDescriptor("env-team", "Acme"),
      ],
      hostEnvironments: [environmentDescriptor("env-host-only", "Host only")],
      // The bot.list order is the reverse of the environment order, so the
      // output order comes from the sign-in's own identity response.
      bots: [tracy, scout],
      client: botSubscribeClient(
        snapshotAnswers([
          [scout, 3],
          [tracy, 1],
        ]),
      ),
    });

    const result = await runList();

    expect(result.human).toBe(
      [
        "Personal",
        `  Scout  ${BOT_ID_B}  host ${OTHER_HOST_ID}  3 open requests`,
        "",
        "Acme",
        `  Tracy  ${BOT_ID_A}  host ${THIS_HOST_ID} (this host)  1 open request`,
      ].join("\n"),
    );
    expect(result.data).toEqual({
      environments: [
        {
          environmentId: "env-personal",
          label: "Personal",
          bots: [
            {
              botId: BOT_ID_B,
              title: "Scout",
              boundHostId: OTHER_HOST_ID,
              boundToThisHost: false,
              openRequestCount: 3,
              readFailed: false,
            },
          ],
        },
        {
          environmentId: "env-team",
          label: "Acme",
          bots: [
            {
              botId: BOT_ID_A,
              title: "Tracy",
              boundHostId: THIS_HOST_ID,
              boundToThisHost: true,
              openRequestCount: 1,
              readFailed: false,
            },
          ],
        },
      ],
    });
    expect(result.exitCode).toBe(0);
    expect(hoisted.validateIdentity).toHaveBeenCalledTimes(1);
    expect(hoisted.validateIdentity.mock.calls[0]?.[1]).toBe("sign-in-bearer");
    expect(hoisted.callHostRpc.mock.calls.map(([method]) => method)).toEqual([
      "bot.list",
    ]);
  });

  it("puts Personal first, sorts teams by slug then team id, and omits teams without a slug", async () => {
    const user = signInUser({
      personalEnvironmentId: "env-personal",
      teams: [
        { teamId: "team-z", environmentId: "env-z", slug: "acme" },
        { teamId: "team-b", environmentId: "env-b", slug: "acme" },
        { teamId: "team-a", environmentId: "env-a", slug: "beta" },
        { teamId: "team-no-slug", environmentId: "env-no-slug", slug: null },
      ],
    });
    stage({ environments: [], user, bots: [], client: botSubscribeClient({}) });

    const result = await runList();

    expect(result.data).toMatchObject({
      environments: [
        { environmentId: "env-personal", label: "Personal" },
        { environmentId: "env-b", label: "acme" },
        { environmentId: "env-z", label: "acme" },
        { environmentId: "env-a", label: "beta" },
      ],
    });
  });

  it("returns environments after one sign-in refresh when the refreshed bearer is valid", async () => {
    const user = signInUserFromDescriptors([
      environmentDescriptor("env-sign-in", "Personal"),
    ]);
    stage({ environments: [], user, bots: [], client: botSubscribeClient({}) });
    hoisted.validateIdentity
      .mockResolvedValueOnce({ kind: "rejected" })
      .mockResolvedValueOnce({ kind: "valid", user });

    const result = await runList();

    expect(result.human).toBe("Personal\n  no bots");
    expect(
      hoisted.validateIdentity.mock.calls.map(([, token]) => token),
    ).toEqual(["sign-in-bearer", "refreshed-bearer"]);
    expect(hoisted.createStoreBackedRevalidator).toHaveBeenCalledTimes(1);
    expect(hoisted.revalidateCurrentContext).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected sign-in refresh with the existing re-authentication line", async () => {
    stage({ environments: [], bots: [], client: botSubscribeClient({}) });
    hoisted.validateIdentity.mockResolvedValueOnce({ kind: "rejected" });
    hoisted.refreshOutcome = "rejected";

    await expect(runList()).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "The stored credential was rejected. Run `traycer login` to re-authenticate.",
      exitCode: 1,
    });
    expect(hoisted.revalidateCurrentContext).toHaveBeenCalledTimes(1);
    expect(hoisted.validateIdentity).toHaveBeenCalledTimes(1);
  });

  it("reports a second sign-in refusal after one successful refresh with the existing re-authentication line", async () => {
    stage({ environments: [], bots: [], client: botSubscribeClient({}) });
    hoisted.validateIdentity
      .mockResolvedValueOnce({ kind: "rejected" })
      .mockResolvedValueOnce({ kind: "rejected" });

    await expect(runList()).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
      message:
        "The stored credential was rejected. Run `traycer login` to re-authenticate.",
      exitCode: 1,
    });
    expect(hoisted.revalidateCurrentContext).toHaveBeenCalledTimes(1);
    expect(
      hoisted.validateIdentity.mock.calls.map(([, token]) => token),
    ).toEqual(["sign-in-bearer", "refreshed-bearer"]);
  });

  it("returns bare cloud-unreachable when the one sign-in refresh cannot reach authn", async () => {
    stage({ environments: [], bots: [], client: botSubscribeClient({}) });
    hoisted.validateIdentity.mockResolvedValueOnce({ kind: "rejected" });
    hoisted.refreshOutcome = "network-error";

    await expect(runList()).rejects.toMatchObject({
      code: CLI_ERROR_CODES.CLOUD_UNREACHABLE,
      exitCode: 1,
    });
    expect(hoisted.revalidateCurrentContext).toHaveBeenCalledTimes(1);
    expect(hoisted.validateIdentity).toHaveBeenCalledTimes(1);
  });

  it("prints '  no bots' under an environment that has none", async () => {
    const tracy = botRecord({ botId: BOT_ID_A, environmentId: "env-team" });
    stage({
      environments: [
        environmentDescriptor("env-personal", "Personal"),
        environmentDescriptor("env-team", "Acme"),
      ],
      bots: [tracy],
      client: botSubscribeClient(snapshotAnswers([[tracy, 0]])),
    });

    const result = await runList();

    expect(result.human).toBe(
      [
        "Personal",
        "  no bots",
        "",
        "Acme",
        `  Tracy  ${BOT_ID_A}  host ${THIS_HOST_ID} (this host)  0 open requests`,
      ].join("\n"),
    );
    expect(result.data).toMatchObject({
      environments: [
        { environmentId: "env-personal", label: "Personal", bots: [] },
        { environmentId: "env-team", label: "Acme" },
      ],
    });
  });

  it("marks '(this host)' only on a bot whose boundHostId equals the endpoint's host id", async () => {
    const here = botRecord({
      botId: BOT_ID_A,
      title: "Here",
      boundHostId: THIS_HOST_ID,
    });
    const there = botRecord({
      botId: BOT_ID_B,
      title: "There",
      boundHostId: OTHER_HOST_ID,
    });
    stage({
      environments: [environmentDescriptor("env-personal", "Personal")],
      bots: [here, there],
      client: botSubscribeClient(
        snapshotAnswers([
          [here, 0],
          [there, 0],
        ]),
      ),
    });

    const result = await runList();

    const lines = (result.human ?? "").split("\n");
    expect(lines.filter((line) => line.includes("(this host)"))).toEqual([
      `  Here  ${BOT_ID_A}  host ${THIS_HOST_ID} (this host)  0 open requests`,
    ]);
    expect(result.data).toMatchObject({
      environments: [
        {
          bots: [
            { title: "Here", boundToThisHost: true },
            { title: "There", boundToThisHost: false },
          ],
        },
      ],
    });
  });

  it("says '1 open request' for one and 'N open requests' for any other count", async () => {
    const one = botRecord({ botId: BOT_ID_A, title: "One" });
    const many = botRecord({ botId: BOT_ID_B, title: "Many" });
    const none = botRecord({ botId: BOT_ID_C, title: "None" });
    stage({
      environments: [environmentDescriptor("env-personal", "Personal")],
      bots: [one, many, none],
      client: botSubscribeClient(
        snapshotAnswers([
          [one, 1],
          [many, 12],
          [none, 0],
        ]),
      ),
    });

    const result = await runList();

    expect(result.human).toContain(
      `${BOT_ID_A}  host ${THIS_HOST_ID} (this host)  1 open request\n`,
    );
    expect(result.human).toContain("  12 open requests\n");
    expect(result.human).toMatch(/ {2}0 open requests$/);
    expect(result.human).not.toContain("1 open requests");
  });

  it("leaves out a bot whose stream answers deleted", async () => {
    const kept = botRecord({ botId: BOT_ID_A, title: "Kept" });
    const gone = botRecord({ botId: BOT_ID_B, title: "Gone" });
    stage({
      environments: [environmentDescriptor("env-personal", "Personal")],
      bots: [kept, gone],
      client: botSubscribeClient({
        [BOT_ID_A]: botSnapshotFrame(kept, [], 2),
        [BOT_ID_B]: botDeletedFrame(),
      }),
    });

    const result = await runList();

    expect(result.human).toContain("Kept");
    expect(result.human).not.toContain("Gone");
    expect(result.human).not.toContain(BOT_ID_B);
    expect(result.data).toMatchObject({
      environments: [{ bots: [{ botId: BOT_ID_A }] }],
    });
    expect(JSON.stringify(result.data)).not.toContain(BOT_ID_B);
  });

  it("shows no group for an unknown environment whose only bot was deleted", async () => {
    const gone = botRecord({ botId: BOT_ID_A, environmentId: "env-gone" });
    stage({
      environments: [environmentDescriptor("env-personal", "Personal")],
      bots: [gone],
      client: botSubscribeClient({ [BOT_ID_A]: botDeletedFrame() }),
    });

    const result = await runList();

    expect(result.human).toBe("Personal\n  no bots");
    expect(result.human).not.toContain("env-gone");
  });

  it("lists a bot naming an environment absent from the sign-in record under that environment's id", async () => {
    const known = botRecord({
      botId: BOT_ID_A,
      title: "Known",
      environmentId: "env-personal",
    });
    const stray = botRecord({
      botId: BOT_ID_B,
      title: "Stray",
      environmentId: "env-removed",
    });
    const strayToo = botRecord({
      botId: BOT_ID_C,
      title: "StrayToo",
      environmentId: "env-removed",
    });
    stage({
      environments: [environmentDescriptor("env-personal", "Personal")],
      bots: [stray, known, strayToo],
      client: botSubscribeClient(
        snapshotAnswers([
          [known, 0],
          [stray, 0],
          [strayToo, 4],
        ]),
      ),
    });

    const result = await runList();

    expect(result.human).toBe(
      [
        "Personal",
        `  Known  ${BOT_ID_A}  host ${THIS_HOST_ID} (this host)  0 open requests`,
        "",
        "env-removed",
        `  Stray  ${BOT_ID_B}  host ${THIS_HOST_ID} (this host)  0 open requests`,
        `  StrayToo  ${BOT_ID_C}  host ${THIS_HOST_ID} (this host)  4 open requests`,
      ].join("\n"),
    );
    expect(result.data).toMatchObject({
      environments: [
        { environmentId: "env-personal", label: "Personal" },
        {
          environmentId: "env-removed",
          label: "env-removed",
          bots: [{ botId: BOT_ID_B }, { botId: BOT_ID_C }],
        },
      ],
    });
  });

  it("says so when the person belongs to no environments", async () => {
    stage({
      environments: [],
      bots: [],
      client: botSubscribeClient({}),
    });

    const result = await runList();

    expect(result.human).toBe("You belong to no environments yet.");
    expect(result.data).toEqual({ environments: [] });
    expect(result.exitCode).toBe(0);
  });

  it("opens one bot.subscribe per bot, closes each session, and closes the client afterwards", async () => {
    const first = botRecord({ botId: BOT_ID_A });
    const second = botRecord({ botId: BOT_ID_B });
    const client = botSubscribeClient(
      snapshotAnswers([
        [first, 0],
        [second, 0],
      ]),
    );
    stage({
      environments: [environmentDescriptor("env-personal", "Personal")],
      bots: [first, second],
      client,
    });

    await runList();

    expect(client.sessions.map((session) => session.method)).toEqual([
      "bot.subscribe",
      "bot.subscribe",
    ]);
    expect(client.sessions.map((session) => session.params)).toEqual([
      { botId: BOT_ID_A },
      { botId: BOT_ID_B },
    ]);
    expect(client.sessions.map((session) => session.closeCount)).toEqual([
      1, 1,
    ]);
    expect(client.closeReasons).toEqual(["bot-list-settled"]);
  });

  it("lists a bot whose read fails as could-not-read, exits 1, and closes the client", async () => {
    const bot = botRecord({ botId: BOT_ID_A, title: "Tracy" });
    const client = new FakeStreamClient((session) => {
      session.pushStatus(
        "closed",
        fatalClose({
          code: "INTERNAL",
          reason: "host blew up",
          incompatibleMethod: null,
        }),
      );
    });
    stage({
      environments: [environmentDescriptor("env-personal", "Personal")],
      bots: [bot],
      client,
    });

    const result = await runList();

    expect(result.human).toBe(
      [
        "Personal",
        `  Tracy  ${BOT_ID_A}  host ${THIS_HOST_ID} (this host)  could not read Tracy`,
      ].join("\n"),
    );
    expect(result.data).toEqual({
      environments: [
        {
          environmentId: "env-personal",
          label: "Personal",
          bots: [
            {
              botId: BOT_ID_A,
              title: "Tracy",
              boundHostId: THIS_HOST_ID,
              boundToThisHost: true,
              openRequestCount: null,
              readFailed: true,
            },
          ],
        },
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(client.sessions.map((session) => session.closeCount)).toEqual([1]);
    expect(client.closeReasons).toEqual(["bot-list-settled"]);
  });

  it("lists a bot whose stream is dropped as could-not-read, and the others normally", async () => {
    const good = botRecord({ botId: BOT_ID_A, title: "Good" });
    const dropped = botRecord({ botId: BOT_ID_B, title: "Dropped" });
    const client = new FakeStreamClient((session) => {
      if (botIdOf(session) === BOT_ID_A) {
        session.pushFrame(botSnapshotFrame(good, [], 2));
      } else {
        session.pushStatus("closed", { kind: "caller" });
      }
    });
    stage({
      environments: [environmentDescriptor("env-personal", "Personal")],
      bots: [good, dropped],
      client,
    });

    const result = await runList();

    expect(result.human).toBe(
      [
        "Personal",
        `  Good  ${BOT_ID_A}  host ${THIS_HOST_ID} (this host)  2 open requests`,
        `  Dropped  ${BOT_ID_B}  host ${THIS_HOST_ID} (this host)  could not read Dropped`,
      ].join("\n"),
    );
    expect(result.exitCode).toBe(1);
  });

  it("says 'open requests unknown' for a count the host does not know, apart from a failed read, and exits 0", async () => {
    const unknown = botRecord({ botId: BOT_ID_A, title: "Elsewhere" });
    const known = botRecord({ botId: BOT_ID_B, title: "Here" });
    const client = new FakeStreamClient((session) => {
      // A host that is not the bot's bound host, or has not read the bot's
      // conversations yet, sends no count.
      session.pushFrame(
        botSnapshotFrame(
          botIdOf(session) === BOT_ID_A ? unknown : known,
          [],
          botIdOf(session) === BOT_ID_A ? null : 2,
        ),
      );
    });
    stage({
      environments: [environmentDescriptor("env-personal", "Personal")],
      bots: [unknown, known],
      client,
    });

    const result = await runList();

    expect(result.human).toBe(
      [
        "Personal",
        `  Elsewhere  ${BOT_ID_A}  host ${THIS_HOST_ID} (this host)  open requests unknown`,
        `  Here  ${BOT_ID_B}  host ${THIS_HOST_ID} (this host)  2 open requests`,
      ].join("\n"),
    );
    expect(result.human).not.toContain("could not read");
    expect(result.data).toMatchObject({
      environments: [
        {
          bots: [
            { botId: BOT_ID_A, openRequestCount: null, readFailed: false },
            { botId: BOT_ID_B, openRequestCount: 2, readFailed: false },
          ],
        },
      ],
    });
    expect(result.exitCode).toBe(0);
  });

  describe("a bot whose stream never answers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("lists it as could-not-read after the deadline, lists the others normally, and closes everything once all settled", async () => {
      const first = botRecord({ botId: BOT_ID_A, title: "First" });
      const stalled = botRecord({ botId: BOT_ID_B, title: "Stalled" });
      const third = botRecord({ botId: BOT_ID_C, title: "Third" });
      const client = new RecordingClient((session) => {
        const botId = botIdOf(session);
        if (botId === BOT_ID_A)
          session.pushFrame(botSnapshotFrame(first, [], 1));
        if (botId === BOT_ID_C)
          session.pushFrame(botSnapshotFrame(third, [], 4));
        // BOT_ID_B: no answer, ever.
      });
      stage({
        environments: [environmentDescriptor("env-personal", "Personal")],
        bots: [first, stalled, third],
        client,
      });

      const run = runList().then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(BOT_SNAPSHOT_DEADLINE_MS - 1);
      // Nothing is printed, and nothing closed, while a read is still pending.
      expect(client.closeReasons).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      const settled = await run;
      if (!("result" in settled)) throw settled.error;
      const { result } = settled;

      expect(result.human).toBe(
        [
          "Personal",
          `  First  ${BOT_ID_A}  host ${THIS_HOST_ID} (this host)  1 open request`,
          `  Stalled  ${BOT_ID_B}  host ${THIS_HOST_ID} (this host)  could not read Stalled`,
          `  Third  ${BOT_ID_C}  host ${THIS_HOST_ID} (this host)  4 open requests`,
        ].join("\n"),
      );
      expect(result.data).toMatchObject({
        environments: [
          {
            bots: [
              { botId: BOT_ID_A, openRequestCount: 1, readFailed: false },
              { botId: BOT_ID_B, openRequestCount: null, readFailed: true },
              { botId: BOT_ID_C, openRequestCount: 4, readFailed: false },
            ],
          },
        ],
      });
      expect(result.exitCode).toBe(1);
      expect(client.sessions.map((session) => session.closeCount)).toEqual([
        1, 1, 1,
      ]);
      // Closed once, and only after every read had settled and closed its
      // session.
      expect(client.closeReasons).toEqual(["bot-list-settled"]);
      expect(client.sessionClosesAtClose).toEqual([[1, 1, 1]]);
    });
  });

  it("waits for every read before it fails on a host-update close, then closes the client once", async () => {
    const slow = botRecord({ botId: BOT_ID_A, title: "Slow" });
    const old = botRecord({ botId: BOT_ID_B, title: "Old" });
    const client = new RecordingClient((session) => {
      if (botIdOf(session) === BOT_ID_B) {
        session.pushStatus(
          "closed",
          fatalClose({
            code: "INCOMPATIBLE",
            reason: "host does not offer bot.subscribe",
            incompatibleMethod: "bot.subscribe",
          }),
        );
      } else {
        // Answers a turn later than the failing one.
        queueMicrotask(() => {
          queueMicrotask(() => {
            session.pushFrame(botSnapshotFrame(slow, [], 1));
          });
        });
      }
    });
    stage({
      environments: [environmentDescriptor("env-personal", "Personal")],
      bots: [slow, old],
      client,
    });

    const error: unknown = await runList().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw error;
    expect(error.message).toBe(BOT_HOST_UPDATE_MESSAGE);
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNSUPPORTED);
    expect(client.closeReasons).toEqual(["bot-list-settled"]);
    expect(client.sessionClosesAtClose).toEqual([[1, 1]]);
  });
});

describe("bot list on a host without bots", () => {
  async function expectUpdateMessage(run: Promise<CommandResult>) {
    const error: unknown = await run.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw error;
    expect(error.message).toBe(BOT_HOST_UPDATE_MESSAGE);
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNSUPPORTED);
    expect(error.exitCode).toBe(1);
  }

  it("rejects with the update message when bot.list is unsupported", async () => {
    hoisted.callHostRpc.mockImplementation(
      routeRpc({
        "environment.list": () => ({ environments: [] }),
        "bot.list": () => {
          throw unsupportedRpcError("bot.list");
        },
      }),
    );

    await expectUpdateMessage(runList());

    // The bot RPC failed first: no stream client was ever opened.
    expect(hoisted.openLocalStreamClient).not.toHaveBeenCalled();
  });

  it("rejects with the update message when bot.subscribe closes as incompatible for that method", async () => {
    const bot = botRecord({ botId: BOT_ID_A });
    const client = new FakeStreamClient((session) => {
      session.pushStatus(
        "closed",
        fatalClose({
          code: "INCOMPATIBLE",
          reason: "host does not offer bot.subscribe",
          incompatibleMethod: "bot.subscribe",
        }),
      );
    });
    stage({
      environments: [environmentDescriptor("env-personal", "Personal")],
      bots: [bot],
      client,
    });

    await expectUpdateMessage(runList());

    expect(client.closeReasons).toEqual(["bot-list-settled"]);
  });

  it("rejects with the update message when the client reports bot.subscribe unsupported", async () => {
    const bot = botRecord({ botId: BOT_ID_A });
    const client = new FakeStreamClient((session) => {
      session.pushStatus("closed", { kind: "caller" });
    });
    client.methodSupport = "unsupported";
    stage({
      environments: [environmentDescriptor("env-personal", "Personal")],
      bots: [bot],
      client,
    });

    await expectUpdateMessage(runList());
  });

  it("does not read an INCOMPATIBLE close about another method as a missing bots capability", async () => {
    const bot = botRecord({ botId: BOT_ID_A, title: "Tracy" });
    const client = new FakeStreamClient((session) => {
      session.pushStatus(
        "closed",
        fatalClose({
          code: "INCOMPATIBLE",
          reason: "protocol skew",
          incompatibleMethod: "chat.subscribe",
        }),
      );
    });
    stage({
      environments: [environmentDescriptor("env-personal", "Personal")],
      bots: [bot],
      client,
    });

    // Not the update line: this bot could not be read, and it says so.
    const result = await runList();

    expect(result.human).toContain("could not read Tracy");
    expect(result.human).not.toContain(BOT_HOST_UPDATE_MESSAGE);
    expect(result.exitCode).toBe(1);
  });
});

describe("groupByEnvironment", () => {
  it("keeps an environment with no rows and orders unknown environments after the listed ones", () => {
    const bots = [
      botRecord({ botId: BOT_ID_A, environmentId: "env-z" }),
      botRecord({ botId: BOT_ID_B, environmentId: "env-a" }),
    ];
    const rows = bots.map((bot) => ({
      botId: bot.botId,
      title: bot.title,
      boundHostId: bot.boundHostId,
      boundToThisHost: true,
      openRequestCount: 0,
      readFailed: false,
    }));

    const groups = groupByEnvironment(
      [
        environmentDescriptor("env-a", "A"),
        environmentDescriptor("env-b", "B"),
      ],
      rows,
      bots,
    );

    expect(
      groups.map((group) => [
        group.environmentId,
        group.label,
        group.bots.map((row) => row.botId),
      ]),
    ).toEqual([
      ["env-a", "A", [BOT_ID_B]],
      ["env-b", "B", []],
      ["env-z", "env-z", [BOT_ID_A]],
    ]);
  });
});
