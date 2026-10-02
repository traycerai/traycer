import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  providerMutationCliStateSchemaV21,
  type ProviderMutationCliStateV21,
} from "@traycer/protocol/host/provider-schemas";
import {
  callHostRpcWithDispatch,
  type HostRpcDispatch,
} from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
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
};

const PLAIN_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: null,
  requiredHostMethodVersion: null,
  signal: null,
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

beforeEach(() => {
  vi.clearAllMocks();
  dispatchMock.mockResolvedValue({ state: mutationState() });
});

describe("traycer profile rename", () => {
  it("renames through providers.setEnabled with the 2.1 floor", async () => {
    const result = await buildProfileRenameCommand({
      provider: "claude",
      profile: "prof_work",
      label: "Work account",
    })(makeCtx(false, false));

    expect(dispatchMock).toHaveBeenCalledTimes(1);
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

    expect(dispatchMock.mock.calls[0]?.[1]).toEqual(
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

    expect(dispatchMock.mock.calls[0]?.[1]).toEqual(
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

    expect(dispatchMock.mock.calls[0]?.[1]).toEqual(
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
    expect(dispatchMock).toHaveBeenCalledTimes(1);
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
    dispatchMock.mockResolvedValue({ profileId: "prof_work", enabled: true });

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
    dispatchMock.mockResolvedValue({ profileId: "prof_work", enabled: false });

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
    dispatchMock.mockResolvedValue({ profileId: "prof_work", enabled: true });

    const result = await buildProfileSetEnabledCommand({
      provider: "claude",
      profile: "prof_work",
      enabled: false,
    })(makeCtx(false, false));

    expect(result.data).toEqual(expect.objectContaining({ enabled: true }));
    expect(result.human).toContain("Enabled");
  });

  it("can disable the ambient profile", async () => {
    dispatchMock.mockResolvedValue({ profileId: "ambient", enabled: false });

    await buildProfileSetEnabledCommand({
      provider: "claude",
      profile: "ambient",
      enabled: false,
    })(makeCtx(false, false));

    expect(dispatchMock.mock.calls[0]?.[1]).toEqual({
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

    expect(dispatchMock).toHaveBeenCalledTimes(1);
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
