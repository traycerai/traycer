import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providersListUpgradeV1010ToV1011 } from "@traycer/protocol/host/registry";
import {
  providerCliStateSchema,
  providerMutationCliStateSchemaV21,
  providersAnswerProfileNameRequestSchema,
  providersAnswerProfileNameResponseSchema,
  providersListResponseSchema,
  providersListResponseSchemaV1010Preimage,
  type ProviderMutationCliStateV21,
  type ProvidersAnswerProfileNameResponse,
  type ProvidersListResponse,
} from "@traycer/protocol/host/provider-schemas";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import {
  callHostRpcWithDispatch,
  type HostRpcDispatch,
} from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext, CommandResult } from "../../runner/runner";
import {
  buildProfileRemoveCommand,
  buildProfileRenameCommand,
  buildProfileSetEnabledCommand,
} from "../profile-mutations";

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

const promptMock = vi.hoisted(() => ({
  question: vi.fn<(query: string) => Promise<string>>(),
  close: vi.fn<() => void>(),
}));

vi.mock("node:readline/promises", () => ({
  createInterface: () => promptMock,
}));

vi.mock("../../internal/host-rpc", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/host-rpc")
  >("../../internal/host-rpc");
  return {
    ...actual,
    callHostRpcWithDispatch: vi.fn(),
  };
});

const dispatchMock = vi.mocked(callHostRpcWithDispatch);

function makeCtx(json: boolean, nonInteractive: boolean): CommandContext {
  return {
    runtime: {
      json,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive,
      environment: "production",
      logger: noopLogger,
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

function mutationState(): ProviderMutationCliStateV21 {
  return providerMutationCliStateSchemaV21.parse({
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    profiles: [],
  });
}

/** What every `providers.setEnabled` profile action must name as its floor. */
const PROFILE_ACTION_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: null,
  requiredHostMethodVersion: {
    method: "providers.setEnabled",
    version: { major: 2, minor: 1 },
  },
  signal: null,
  failFast: false,
  reauthenticate: "always",
  idempotencyKey: null,
};

const PLAIN_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: null,
  requiredHostMethodVersion: null,
  signal: null,
  failFast: false,
  reauthenticate: "always",
  idempotencyKey: null,
};

async function failureOf(run: Promise<unknown>): Promise<CliError> {
  const error = await run.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(CliError);
  if (!(error instanceof CliError)) throw new Error("unreachable");
  return error;
}

const EMPTY_LIST = providersListResponseSchema.parse({
  providers: [],
  native: null,
});

let listed: ProvidersListResponse = EMPTY_LIST;
let mutationAnswer: object = { state: mutationState() };
let nameAnswer: ProvidersAnswerProfileNameResponse | null = null;
let nameRefusal: HostRpcError | null = null;

function installHost(): void {
  dispatchMock.mockImplementation((method) => {
    if (method === "providers.list") return Promise.resolve(listed);
    if (method === "providers.answerProfileName") {
      if (nameRefusal !== null) return Promise.reject(nameRefusal);
      if (nameAnswer !== null) return Promise.resolve(nameAnswer);
      return Promise.reject(
        new Error("unexpected providers.answerProfileName"),
      );
    }
    return Promise.resolve(mutationAnswer);
  });
}

type DispatchCall = (typeof dispatchMock.mock.calls)[number];

function onlyCallTo(method: string): DispatchCall {
  const calls = dispatchMock.mock.calls.filter((call) => call[0] === method);
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (call === undefined) throw new Error(`unreachable: no ${method} call`);
  return call;
}

beforeEach(() => {
  vi.clearAllMocks();
  listed = EMPTY_LIST;
  mutationAnswer = { state: mutationState() };
  nameAnswer = null;
  nameRefusal = null;
  installHost();
});

describe("traycer profile rename", () => {
  it("renames through providers.setEnabled with the 2.1 floor", async () => {
    const result = await buildProfileRenameCommand({
      provider: "claude",
      profile: "prof_work",
      label: "Work account",
    })(makeCtx(false, false));

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock).toHaveBeenCalledWith(
      "providers.setEnabled",
      {
        providerId: "claude-code",
        enabled: true,
        profileAction: {
          type: "rename",
          profileId: "prof_work",
          label: "Work account",
        },
      },
      PROFILE_ACTION_DISPATCH,
    );
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      providerId: "claude-code",
      profileId: "prof_work",
      label: "Work account",
    });
    expect(result.human).toBe(
      'Renamed claude (Claude Code) profile prof_work to "Work account".',
    );
  });

  it("escapes control characters in the human line and sends the label unchanged", async () => {
    const label = "Work\u001b[31m";

    const result = await buildProfileRenameCommand({
      provider: "claude",
      profile: "prof_work",
      label,
    })(makeCtx(false, false));

    expect(onlyCallTo("providers.setEnabled")[1]).toEqual(
      expect.objectContaining({
        profileAction: expect.objectContaining({ label }),
      }),
    );
    expect(result.data).toEqual(expect.objectContaining({ label }));
    expect(result.human).toBe(
      'Renamed claude (Claude Code) profile prof_work to "Work\\x1b[31m".',
    );
    expect(result.human).not.toContain("\u001b");
  });

  it("trims the label before sending it", async () => {
    await buildProfileRenameCommand({
      provider: "claude-code",
      profile: "prof_work",
      label: "  Work  ",
    })(makeCtx(false, false));

    expect(onlyCallTo("providers.setEnabled")[1]).toEqual(
      expect.objectContaining({
        profileAction: expect.objectContaining({ label: "Work" }),
      }),
    );
  });

  it("can rename the ambient profile", async () => {
    await buildProfileRenameCommand({
      provider: "claude",
      profile: "ambient",
      label: "Terminal",
    })(makeCtx(false, false));

    expect(onlyCallTo("providers.setEnabled")[1]).toEqual(
      expect.objectContaining({
        profileAction: {
          type: "rename",
          profileId: "ambient",
          label: "Terminal",
        },
      }),
    );
  });

  it("rejects an empty or whitespace-only label before any RPC", async () => {
    for (const label of ["", "   "]) {
      const error = await failureOf(
        buildProfileRenameCommand({
          provider: "claude",
          profile: "prof_work",
          label,
        })(makeCtx(false, false)),
      );
      expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    }
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("rejects a label over 64 characters before any RPC, and accepts exactly 64", async () => {
    const error = await failureOf(
      buildProfileRenameCommand({
        provider: "claude",
        profile: "prof_work",
        label: "x".repeat(65),
      })(makeCtx(false, false)),
    );
    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(dispatchMock).not.toHaveBeenCalled();

    await buildProfileRenameCommand({
      provider: "claude",
      profile: "prof_work",
      label: "x".repeat(64),
    })(makeCtx(false, false));
    expect(dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an unknown provider and an empty profile before any RPC", async () => {
    const unknownProvider = await failureOf(
      buildProfileRenameCommand({
        provider: "nope",
        profile: "prof_work",
        label: "Work",
      })(makeCtx(false, false)),
    );
    const emptyProfile = await failureOf(
      buildProfileRenameCommand({
        provider: "claude",
        profile: "  ",
        label: "Work",
      })(makeCtx(false, false)),
    );

    expect(unknownProvider.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(emptyProfile.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe("traycer profile enable / disable", () => {
  it("sends providers.setProfileEnabled with enabled true", async () => {
    mutationAnswer = { profileId: "prof_work", enabled: true };

    const result = await buildProfileSetEnabledCommand({
      provider: "claude",
      profile: "prof_work",
      enabled: true,
    })(makeCtx(false, false));

    expect(dispatchMock).toHaveBeenCalledWith(
      "providers.setProfileEnabled",
      { providerId: "claude-code", profileId: "prof_work", enabled: true },
      PLAIN_DISPATCH,
    );
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      providerId: "claude-code",
      profileId: "prof_work",
      enabled: true,
    });
    expect(result.human).toBe(
      "Enabled claude (Claude Code) profile prof_work.",
    );
  });

  it("sends providers.setProfileEnabled with enabled false", async () => {
    mutationAnswer = { profileId: "prof_work", enabled: false };

    const result = await buildProfileSetEnabledCommand({
      provider: "claude-code",
      profile: "prof_work",
      enabled: false,
    })(makeCtx(false, false));

    expect(dispatchMock).toHaveBeenCalledWith(
      "providers.setProfileEnabled",
      { providerId: "claude-code", profileId: "prof_work", enabled: false },
      PLAIN_DISPATCH,
    );
    expect(result.human).toBe(
      "Disabled claude (Claude Code) profile prof_work.",
    );
  });

  it("reports the state the host answered, not the one requested", async () => {
    mutationAnswer = { profileId: "prof_work", enabled: true };

    const result = await buildProfileSetEnabledCommand({
      provider: "claude",
      profile: "prof_work",
      enabled: false,
    })(makeCtx(false, false));

    expect(result.data).toEqual(expect.objectContaining({ enabled: true }));
    expect(result.human).toContain("Enabled");
  });

  it("can disable the ambient profile", async () => {
    mutationAnswer = { profileId: "ambient", enabled: false };

    await buildProfileSetEnabledCommand({
      provider: "claude",
      profile: "ambient",
      enabled: false,
    })(makeCtx(false, false));

    expect(onlyCallTo("providers.setProfileEnabled")[1]).toEqual({
      providerId: "claude-code",
      profileId: "ambient",
      enabled: false,
    });
  });
});

describe("traycer profile remove", () => {
  it("refuses the ambient profile before any RPC, even with --yes", async () => {
    const error = await failureOf(
      buildProfileRemoveCommand({
        provider: "claude",
        profile: "ambient",
        yes: true,
      })(makeCtx(false, false)),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(error.message).toContain("ambient");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("refuses without --yes in a JSON context before any RPC", async () => {
    const error = await failureOf(
      buildProfileRemoveCommand({
        provider: "claude",
        profile: "prof_work",
        yes: false,
      })(makeCtx(true, false)),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(error.message).toContain("--yes");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("refuses without --yes in a non-interactive context before any RPC", async () => {
    const error = await failureOf(
      buildProfileRemoveCommand({
        provider: "claude",
        profile: "prof_work",
        yes: false,
      })(makeCtx(false, true)),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(error.message).toContain("--yes");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("removes through providers.setEnabled with the 2.1 floor when --yes is given", async () => {
    const result = await buildProfileRemoveCommand({
      provider: "claude",
      profile: "prof_work",
      yes: true,
    })(makeCtx(true, true));

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock).toHaveBeenCalledWith(
      "providers.setEnabled",
      {
        providerId: "claude-code",
        enabled: true,
        profileAction: { type: "remove", profileId: "prof_work" },
      },
      PROFILE_ACTION_DISPATCH,
    );
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      providerId: "claude-code",
      profileId: "prof_work",
      removed: true,
    });
    expect(result.human).toBe(
      "Removed claude (Claude Code) profile prof_work.",
    );
  });

  describe("at the prompt", () => {
    const stdinTtyBefore = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );

    function removeAtPrompt(): Promise<unknown> {
      return buildProfileRemoveCommand({
        provider: "claude",
        profile: "prof_work",
        yes: false,
      })(makeCtx(false, false));
    }

    beforeEach(() => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      if (stdinTtyBefore === undefined) {
        Reflect.deleteProperty(process.stdin, "isTTY");
      } else {
        Object.defineProperty(process.stdin, "isTTY", stdinTtyBefore);
      }
    });

    it("treats a rejected question (Ctrl+C or a closed stdin) as no, and removes nothing", async () => {
      promptMock.question.mockRejectedValue(new Error("readline was closed"));

      const error = await failureOf(removeAtPrompt());

      expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
      expect(error.message).toBe("traycer: profile not removed.");
      expect(promptMock.close).toHaveBeenCalledTimes(1);
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("treats an answer other than yes as no, and removes nothing", async () => {
      promptMock.question.mockResolvedValue("n");

      const error = await failureOf(removeAtPrompt());

      expect(error.message).toBe("traycer: profile not removed.");
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("removes the profile on a yes", async () => {
      promptMock.question.mockResolvedValue("y");

      await removeAtPrompt();

      const questionAt = promptMock.question.mock.invocationCallOrder[0];
      const listAt = dispatchMock.mock.invocationCallOrder[0];
      const removalAt = dispatchMock.mock.invocationCallOrder[1];
      if (
        questionAt === undefined ||
        listAt === undefined ||
        removalAt === undefined
      ) {
        throw new Error("unreachable");
      }
      expect(dispatchMock.mock.calls.map((call) => call[0])).toEqual([
        "providers.list",
        "providers.setEnabled",
      ]);
      expect(questionAt).toBeLessThan(listAt);
      expect(listAt).toBeLessThan(removalAt);
      expect(promptMock.close).toHaveBeenCalledTimes(1);
    });
  });

  it("validates the provider before anything else", async () => {
    const error = await failureOf(
      buildProfileRemoveCommand({
        provider: "nope",
        profile: "prof_work",
        yes: true,
      })(makeCtx(false, false)),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

interface ListedRowSpec {
  readonly profileId: string;
  readonly aliases: readonly string[];
  /** Null omits the key. An empty array is a row rename still sends as today. */
  readonly otherNames: readonly string[] | null;
}

interface RemovedSpec {
  readonly providerId: string;
  readonly profileId: string;
  readonly aliases: readonly string[];
}

function profileRecord(row: {
  readonly profileId: string;
  readonly kind: "ambient" | "managed";
  readonly label: string;
  readonly email: string;
}): object {
  return {
    profileId: row.profileId,
    kind: row.kind,
    authType: "oauth",
    label: row.label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email: row.email, tier: null, accountUuid: null },
    usageUpdatedAt: null,
    rateLimitStatus: "ok",
    enabled: true,
  };
}

function claudeProvider(profiles: readonly object[]): object {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    profiles,
  };
}

function publishList(
  profiles: readonly ListedRowSpec[],
  removedProfiles: readonly RemovedSpec[],
): void {
  listed = providersListResponseSchema.parse({
    providers: [
      claudeProvider(
        profiles.map((row) => ({
          ...profileRecord({
            profileId: row.profileId,
            kind: "managed",
            label: "Work",
            email: "work@example.test",
          }),
          aliases: [...row.aliases],
          personNotice: null,
          terminalOnThisComputer: false,
          ...(row.otherNames === null
            ? {}
            : { otherNames: [...row.otherNames] }),
        })),
      ),
    ],
    native: null,
    removedProfiles: removedProfiles.map((entry) => ({
      providerId: entry.providerId,
      profileId: entry.profileId,
      aliases: [...entry.aliases],
    })),
  });
}

const ALIAS_ROW: ListedRowSpec = {
  profileId: "row-own",
  aliases: ["old-id"],
  otherNames: null,
};

describe("alias look-up", () => {
  it("rename addressed to an alias sends the row's own profile id", async () => {
    publishList([ALIAS_ROW], []);

    const result = await buildProfileRenameCommand({
      provider: "claude",
      profile: "old-id",
      label: "Renamed",
    })(makeCtx(false, false));

    expect(onlyCallTo("providers.setEnabled")[1]).toEqual({
      providerId: "claude-code",
      enabled: true,
      profileAction: {
        type: "rename",
        profileId: "row-own",
        label: "Renamed",
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.human).toBe(
      'Renamed claude (Claude Code) profile row-own to "Renamed".',
    );
    expect(result.data).toEqual({
      providerId: "claude-code",
      profileId: "row-own",
      label: "Renamed",
    });
  });

  it("remove --yes addressed to an alias sends the row's own profile id", async () => {
    publishList([ALIAS_ROW], []);

    const result = await buildProfileRemoveCommand({
      provider: "claude",
      profile: "old-id",
      yes: true,
    })(makeCtx(true, true));

    expect(onlyCallTo("providers.setEnabled")[1]).toEqual({
      providerId: "claude-code",
      enabled: true,
      profileAction: { type: "remove", profileId: "row-own" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.human).toBe("Removed claude (Claude Code) profile row-own.");
    expect(result.data).toEqual({
      providerId: "claude-code",
      profileId: "row-own",
      removed: true,
    });
  });

  it("enable addressed to an alias sends the row's own profile id", async () => {
    publishList([ALIAS_ROW], []);
    mutationAnswer = { profileId: "echo-id", enabled: true };

    const result = await buildProfileSetEnabledCommand({
      provider: "claude",
      profile: "old-id",
      enabled: true,
    })(makeCtx(false, false));

    expect(onlyCallTo("providers.setProfileEnabled")[1]).toEqual({
      providerId: "claude-code",
      profileId: "row-own",
      enabled: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.human).toBe("Enabled claude (Claude Code) profile row-own.");
    expect(result.data).toEqual({
      providerId: "claude-code",
      profileId: "row-own",
      enabled: true,
    });
  });

  it("disable addressed to an alias sends the row's own profile id", async () => {
    publishList([ALIAS_ROW], []);
    mutationAnswer = { profileId: "echo-id", enabled: false };

    const result = await buildProfileSetEnabledCommand({
      provider: "claude",
      profile: "old-id",
      enabled: false,
    })(makeCtx(false, false));

    expect(onlyCallTo("providers.setProfileEnabled")[1]).toEqual({
      providerId: "claude-code",
      profileId: "row-own",
      enabled: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.human).toBe("Disabled claude (Claude Code) profile row-own.");
    expect(result.data).toEqual({
      providerId: "claude-code",
      profileId: "row-own",
      enabled: false,
    });
  });

  it("sends an unknown id as typed from rename, remove, enable and disable", async () => {
    publishList([ALIAS_ROW], []);
    const typed = "missing-id";

    const renamed = await buildProfileRenameCommand({
      provider: "claude",
      profile: typed,
      label: "Renamed",
    })(makeCtx(false, false));
    expect(onlyCallTo("providers.setEnabled")[1]).toEqual(
      expect.objectContaining({
        profileAction: { type: "rename", profileId: typed, label: "Renamed" },
      }),
    );
    expect(renamed.data).toEqual(expect.objectContaining({ profileId: typed }));

    dispatchMock.mockClear();
    const removed = await buildProfileRemoveCommand({
      provider: "claude",
      profile: typed,
      yes: true,
    })(makeCtx(true, true));
    expect(onlyCallTo("providers.setEnabled")[1]).toEqual(
      expect.objectContaining({
        profileAction: { type: "remove", profileId: typed },
      }),
    );
    expect(removed.data).toEqual(expect.objectContaining({ profileId: typed }));

    dispatchMock.mockClear();
    mutationAnswer = { profileId: typed, enabled: true };
    const enabled = await buildProfileSetEnabledCommand({
      provider: "claude",
      profile: typed,
      enabled: true,
    })(makeCtx(false, false));
    expect(onlyCallTo("providers.setProfileEnabled")[1]).toEqual({
      providerId: "claude-code",
      profileId: typed,
      enabled: true,
    });
    expect(enabled.data).toEqual(
      expect.objectContaining({ profileId: typed, enabled: true }),
    );

    dispatchMock.mockClear();
    mutationAnswer = { profileId: typed, enabled: false };
    const disabled = await buildProfileSetEnabledCommand({
      provider: "claude",
      profile: typed,
      enabled: false,
    })(makeCtx(false, false));
    expect(onlyCallTo("providers.setProfileEnabled")[1]).toEqual({
      providerId: "claude-code",
      profileId: typed,
      enabled: false,
    });
    expect(disabled.data).toEqual(
      expect.objectContaining({ profileId: typed, enabled: false }),
    );
  });

  it("sends an id found only in removedProfiles as typed", async () => {
    publishList(
      [ALIAS_ROW],
      [
        {
          providerId: "claude-code",
          profileId: "gone-id",
          aliases: ["gone-alias"],
        },
      ],
    );

    await buildProfileRenameCommand({
      provider: "claude",
      profile: "gone-id",
      label: "Renamed",
    })(makeCtx(false, false));
    expect(onlyCallTo("providers.setEnabled")[1]).toEqual(
      expect.objectContaining({
        profileAction: expect.objectContaining({ profileId: "gone-id" }),
      }),
    );

    dispatchMock.mockClear();
    await buildProfileRenameCommand({
      provider: "claude",
      profile: "gone-alias",
      label: "Renamed",
    })(makeCtx(false, false));
    expect(onlyCallTo("providers.setEnabled")[1]).toEqual(
      expect.objectContaining({
        profileAction: expect.objectContaining({ profileId: "gone-alias" }),
      }),
    );

    dispatchMock.mockClear();
    await buildProfileRemoveCommand({
      provider: "claude",
      profile: "gone-id",
      yes: true,
    })(makeCtx(true, true));
    expect(onlyCallTo("providers.setEnabled")[1]).toEqual(
      expect.objectContaining({
        profileAction: { type: "remove", profileId: "gone-id" },
      }),
    );

    dispatchMock.mockClear();
    mutationAnswer = { profileId: "gone-id", enabled: true };
    await buildProfileSetEnabledCommand({
      provider: "claude",
      profile: "gone-id",
      enabled: true,
    })(makeCtx(false, false));
    expect(onlyCallTo("providers.setProfileEnabled")[1]).toEqual(
      expect.objectContaining({ profileId: "gone-id", enabled: true }),
    );

    dispatchMock.mockClear();
    mutationAnswer = { profileId: "gone-id", enabled: false };
    await buildProfileSetEnabledCommand({
      provider: "claude",
      profile: "gone-id",
      enabled: false,
    })(makeCtx(false, false));
    expect(onlyCallTo("providers.setProfileEnabled")[1]).toEqual(
      expect.objectContaining({ profileId: "gone-id", enabled: false }),
    );
  });

  it("does not guess an id listed in two rows' aliases", async () => {
    publishList(
      [
        { profileId: "row-a", aliases: ["shared-id"], otherNames: null },
        { profileId: "row-b", aliases: ["shared-id"], otherNames: null },
      ],
      [],
    );

    await buildProfileRenameCommand({
      provider: "claude",
      profile: "shared-id",
      label: "Renamed",
    })(makeCtx(false, false));
    expect(onlyCallTo("providers.setEnabled")[1]).toEqual(
      expect.objectContaining({
        profileAction: expect.objectContaining({ profileId: "shared-id" }),
      }),
    );

    dispatchMock.mockClear();
    await buildProfileRemoveCommand({
      provider: "claude",
      profile: "shared-id",
      yes: true,
    })(makeCtx(true, true));
    expect(onlyCallTo("providers.setEnabled")[1]).toEqual(
      expect.objectContaining({
        profileAction: { type: "remove", profileId: "shared-id" },
      }),
    );

    dispatchMock.mockClear();
    mutationAnswer = { profileId: "shared-id", enabled: true };
    await buildProfileSetEnabledCommand({
      provider: "claude",
      profile: "shared-id",
      enabled: true,
    })(makeCtx(false, false));
    expect(onlyCallTo("providers.setProfileEnabled")[1]).toEqual(
      expect.objectContaining({ profileId: "shared-id", enabled: true }),
    );

    dispatchMock.mockClear();
    mutationAnswer = { profileId: "shared-id", enabled: false };
    await buildProfileSetEnabledCommand({
      provider: "claude",
      profile: "shared-id",
      enabled: false,
    })(makeCtx(false, false));
    expect(onlyCallTo("providers.setProfileEnabled")[1]).toEqual(
      expect.objectContaining({ profileId: "shared-id", enabled: false }),
    );
  });

  it("sends an id that one row owns and another row lists as an alias as typed", async () => {
    publishList(
      [
        { profileId: "shared-id", aliases: [], otherNames: null },
        { profileId: "row-b", aliases: ["shared-id"], otherNames: null },
      ],
      [],
    );

    await buildProfileRenameCommand({
      provider: "claude",
      profile: "shared-id",
      label: "Renamed",
    })(makeCtx(false, false));

    expect(onlyCallTo("providers.setEnabled")[1]).toEqual(
      expect.objectContaining({
        profileAction: {
          type: "rename",
          profileId: "shared-id",
          label: "Renamed",
        },
      }),
    );
  });
});

function upgradedV1010List(): ProvidersListResponse {
  const provider = providerCliStateSchema.parse(
    claudeProvider([
      profileRecord({
        profileId: "ambient",
        kind: "ambient",
        label: "Terminal",
        email: "term@example.test",
      }),
      profileRecord({
        profileId: "prof_work",
        kind: "managed",
        label: "Work",
        email: "work@example.test",
      }),
    ]),
  );
  return providersListUpgradeV1010ToV1011.upgradeResponse(
    providersListResponseSchemaV1010Preimage.parse({
      providers: [provider],
      native: null,
    }),
  );
}

describe("a 10.10 answer", () => {
  it("leaves rename, remove, enable and disable output, data and the typed id unchanged", async () => {
    const upgraded = upgradedV1010List();
    const provider = upgraded.providers[0];
    if (provider === undefined) throw new Error("unreachable");
    const ambient = provider.profiles.find(
      (profile) => profile.kind === "ambient",
    );
    const managed = provider.profiles.find(
      (profile) => profile.profileId === "prof_work",
    );
    expect(ambient?.terminalOnThisComputer).toBe(true);
    expect(ambient?.aliases).toEqual([]);
    expect(managed?.terminalOnThisComputer).toBe(false);
    expect(managed?.aliases).toEqual([]);
    expect(managed?.personNotice).toBeNull();
    expect(upgraded.removedProfiles).toEqual([]);

    const compare = async (
      run: () => Promise<CommandResult>,
      method: string,
      payload: object,
    ): Promise<void> => {
      listed = EMPTY_LIST;
      dispatchMock.mockClear();
      const today = await run();
      listed = upgraded;
      dispatchMock.mockClear();
      const fromOlderHost = await run();
      expect(fromOlderHost.exitCode).toBe(today.exitCode);
      expect(fromOlderHost.human).toBe(today.human);
      expect(fromOlderHost.data).toEqual(today.data);
      expect(onlyCallTo(method)[1]).toEqual(payload);
    };

    await compare(
      () =>
        buildProfileRenameCommand({
          provider: "claude",
          profile: "prof_work",
          label: "Work account",
        })(makeCtx(false, false)),
      "providers.setEnabled",
      {
        providerId: "claude-code",
        enabled: true,
        profileAction: {
          type: "rename",
          profileId: "prof_work",
          label: "Work account",
        },
      },
    );

    await compare(
      () =>
        buildProfileRemoveCommand({
          provider: "claude",
          profile: "prof_work",
          yes: true,
        })(makeCtx(true, true)),
      "providers.setEnabled",
      {
        providerId: "claude-code",
        enabled: true,
        profileAction: { type: "remove", profileId: "prof_work" },
      },
    );

    mutationAnswer = { profileId: "prof_work", enabled: true };
    await compare(
      () =>
        buildProfileSetEnabledCommand({
          provider: "claude",
          profile: "prof_work",
          enabled: true,
        })(makeCtx(false, false)),
      "providers.setProfileEnabled",
      { providerId: "claude-code", profileId: "prof_work", enabled: true },
    );

    mutationAnswer = { profileId: "prof_work", enabled: false };
    await compare(
      () =>
        buildProfileSetEnabledCommand({
          provider: "claude",
          profile: "prof_work",
          enabled: false,
        })(makeCtx(false, false)),
      "providers.setProfileEnabled",
      { providerId: "claude-code", profileId: "prof_work", enabled: false },
    );
  });
});

const NAMED_ROW: ListedRowSpec = {
  profileId: "row-own",
  aliases: ["old-id"],
  otherNames: ["A", "B"],
};

function answeredName(label: string): ProvidersAnswerProfileNameResponse {
  return providersAnswerProfileNameResponseSchema.parse({ label });
}

function renameProfile(profile: string, label: string): Promise<CommandResult> {
  return buildProfileRenameCommand({
    provider: "claude",
    profile,
    label,
  })(makeCtx(false, false));
}

function expectAnswerProfileName(profileId: string, label: string): void {
  const call = onlyCallTo("providers.answerProfileName");
  const request = providersAnswerProfileNameRequestSchema.parse(call[1]);
  expect(call[1]).toEqual({ providerId: "claude-code", profileId, label });
  expect(request).toEqual(call[1]);
  expect(call[2]).toEqual(PLAIN_DISPATCH);
  expect(dispatchMock.mock.calls.map((entry) => entry[0])).toEqual([
    "providers.list",
    "providers.answerProfileName",
  ]);
}

describe("rename on a row with other names", () => {
  it("sends providers.answerProfileName for the row's own id and does not rename", async () => {
    publishList([NAMED_ROW], []);
    nameAnswer = answeredName("Chosen");

    const result = await renameProfile("row-own", "Chosen");

    expectAnswerProfileName("row-own", "Chosen");
    expect(result.exitCode).toBe(0);
    expect(result.human).toBe(
      'Renamed claude (Claude Code) profile row-own to "Chosen".',
    );
    expect(result.data).toEqual({
      providerId: "claude-code",
      profileId: "row-own",
      label: "Chosen",
    });
  });

  it("addressed to an alias still sends the row's own id", async () => {
    publishList([NAMED_ROW], []);
    nameAnswer = answeredName("Chosen");

    const result = await renameProfile("old-id", "Chosen");

    expectAnswerProfileName("row-own", "Chosen");
    expect(result.exitCode).toBe(0);
    expect(result.human).toBe(
      'Renamed claude (Claude Code) profile row-own to "Chosen".',
    );
    expect(result.data).toEqual({
      providerId: "claude-code",
      profileId: "row-own",
      label: "Chosen",
    });
  });

  it("prints the label the host answered when someone else chose just after", async () => {
    publishList([NAMED_ROW], []);
    nameAnswer = answeredName("Settled");

    const result = await renameProfile("row-own", "Chosen");

    expectAnswerProfileName("row-own", "Chosen");
    expect(result.exitCode).toBe(0);
    expect(result.human).toBe(
      'Renamed claude (Claude Code) profile row-own to "Settled".',
    );
    expect(result.data).toEqual({
      providerId: "claude-code",
      profileId: "row-own",
      label: "Settled",
    });
  });

  it("renames a row with no other names through providers.setEnabled", async () => {
    publishList(
      [
        {
          profileId: "row-plain",
          aliases: [],
          otherNames: [],
        },
      ],
      [],
    );

    const result = await renameProfile("row-plain", "Chosen");

    expect(onlyCallTo("providers.setEnabled")).toEqual([
      "providers.setEnabled",
      {
        providerId: "claude-code",
        enabled: true,
        profileAction: {
          type: "rename",
          profileId: "row-plain",
          label: "Chosen",
        },
      },
      PROFILE_ACTION_DISPATCH,
    ]);
    expect(dispatchMock.mock.calls.map((entry) => entry[0])).toEqual([
      "providers.list",
      "providers.setEnabled",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.human).toBe(
      'Renamed claude (Claude Code) profile row-plain to "Chosen".',
    );
    expect(result.data).toEqual({
      providerId: "claude-code",
      profileId: "row-plain",
      label: "Chosen",
    });
  });

  it("rejects with HOST_UNSUPPORTED when the host refuses the method, and does not rename", async () => {
    publishList([NAMED_ROW], []);
    const message =
      "This host does not support 'providers.answerProfileName'. Upgrade the host to use this feature.";
    nameRefusal = new HostRpcError({
      code: "E_HOST_UNSUPPORTED",
      message,
      requestId: "req-1",
      method: "providers.answerProfileName",
      fatalDetails: null,
    });

    const error = await failureOf(renameProfile("row-own", "Chosen"));

    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNSUPPORTED);
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe(`traycer: ${message}`);
    expect(error.details).toEqual({
      hostShouldUpgrade: true,
      method: "providers.answerProfileName",
    });
    expect(dispatchMock.mock.calls.map((entry) => entry[0])).toEqual([
      "providers.list",
      "providers.answerProfileName",
    ]);
  });
});
