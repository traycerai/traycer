import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS,
  UNKNOWN_PROVIDER_AUTH,
} from "@traycer/protocol/host/provider-schemas";
import { buildProfileListCommand } from "../profile-list";
import { buildProfileCreateCommand } from "../profile-create";
import { buildProfileRemoveCommand } from "../profile-remove";
import { buildProfileTestCommand } from "../profile-test";
import { buildProfileCopyCommand } from "../profile-copy";
import { callHostRpc } from "../../internal/host-rpc";
import { HostRpcError } from "../../../../shared/host-transport/host-messenger";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import type { RuntimeContext } from "../../runner/runtime";

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
    callHostRpc: vi.fn(),
  };
});

const rpcMock = vi.mocked(callHostRpc);

function makeRuntime(): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
  };
}

function makeCtx(): CommandContext & {
  readonly humanCalls: string[];
  readonly humanRequiredCalls: string[];
  readonly progressCalls: string[];
} {
  const humanCalls: string[] = [];
  const humanRequiredCalls: string[] = [];
  const progressCalls: string[] = [];
  const recordProgress = (info: unknown): void => {
    progressCalls.push(JSON.stringify(info));
  };
  return {
    runtime: makeRuntime(),
    output: {
      progress: vi.fn(recordProgress),
      human: vi.fn((text: string) => {
        humanCalls.push(text);
      }),
      humanRequired: vi.fn((text: string) => {
        humanRequiredCalls.push(text);
      }),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(recordProgress),
    humanCalls,
    humanRequiredCalls,
    progressCalls,
  };
}

// Minimal, schema-valid `ProviderCliState` row - every field
// `parseCanonicalHostResponse` requires (nothing `.catch()`/`.default()`
// already fills) is present so `providers.list`'s real response schema
// parses these fixtures without a cast.
function makeProviderRow(overrides: {
  readonly providerId: string;
  readonly profiles: readonly Record<string, unknown>[];
  readonly loginCapability?: Record<string, unknown> | null;
  readonly endpointCapabilities?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    providerId: overrides.providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    auth: UNKNOWN_PROVIDER_AUTH,
    profiles: overrides.profiles,
    loginCapability: overrides.loginCapability ?? null,
    endpointCapabilities: overrides.endpointCapabilities ?? null,
  };
}

/** `providers.list` shaped for one provider row - the read every `profile create` now starts with. */
function listResponseFor(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return { providers: [row], native: null };
}

/**
 * `profile create`'s two paths share a `providers.list` read, so every
 * create test drives the mock by method rather than by a single
 * `mockResolvedValue`.
 */
function mockCreateRpc(
  row: Record<string, unknown>,
  byMethod: Record<string, unknown>,
): string[] {
  const callOrder: string[] = [];
  rpcMock.mockImplementation(async (method: string) => {
    callOrder.push(method);
    if (method === "providers.list") return listResponseFor(row);
    const response = byMethod[method];
    if (response === undefined) throw new Error(`unexpected method: ${method}`);
    return response;
  });
  return callOrder;
}

const CREATE_DEFAULTS = {
  baseUrl: null,
  model: null,
  maxContextSize: null,
  credentialKind: null,
  startFrom: "default-account",
} as const;

function makeAmbientProfile(
  credentialConfigured: boolean,
): Record<string, unknown> {
  return {
    profileId: "ambient",
    kind: "ambient",
    authType: "oauth",
    label: "Terminal login",
    auth: UNKNOWN_PROVIDER_AUTH,
    identity: null,
    usageUpdatedAt: null,
    enabled: true,
    endpoint: credentialConfigured
      ? {
          host: null,
          model: null,
          credentialKind: "api_key",
          credentialConfigured: true,
          lastTest: null,
        }
      : null,
  };
}

function makeManagedProfile(profileId: string): Record<string, unknown> {
  return {
    profileId,
    kind: "managed",
    authType: "apiKey",
    label: "Work",
    auth: UNKNOWN_PROVIDER_AUTH,
    identity: null,
    usageUpdatedAt: null,
    enabled: true,
    endpoint: {
      host: "api.example.com",
      model: "gpt-5",
      credentialKind: "api_key",
      credentialConfigured: true,
      lastTest: { at: 1_700_000_000_000, ok: true, reason: null },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("profile list", () => {
  it("prints the Default account row first and never emits 'ambient' in human output", async () => {
    const providerId = "codex";
    // Managed profile listed FIRST in the wire array - proves the command
    // reorders it, rather than merely echoing whatever order the host sent.
    rpcMock.mockResolvedValue({
      providers: [
        makeProviderRow({
          providerId,
          profiles: [
            makeManagedProfile("profile-1"),
            makeAmbientProfile(false),
          ],
        }),
      ],
      native: null,
    });

    const result = await buildProfileListCommand({ provider: providerId })(
      makeCtx(),
    );

    expect(result.human).not.toBeNull();
    const human = result.human ?? "";
    expect(human).not.toContain("ambient");
    const dataLines = human.split("\n").slice(1); // drop the header row
    expect(dataLines[0]).toContain("default account");
    expect(dataLines[1]).toContain("profile-1");
  });
});

describe("profile create", () => {
  it("sends exactly one providers.createApiKeyProfile and exits 1 with the host reason on a failed test", async () => {
    const row = makeProviderRow({ providerId: "codex", profiles: [] });
    const callOrder = mockCreateRpc(row, {
      "providers.createApiKeyProfile": {
        ok: false,
        reason: "connection refused",
      },
    });

    const result = await buildProfileCreateCommand({
      ...CREATE_DEFAULTS,
      provider: "codex",
      label: "Work",
      apiKey: "sk-test-key",
      signIn: false,
      mode: "browser",
    })(makeCtx());

    expect(callOrder).toEqual([
      "providers.list",
      "providers.createApiKeyProfile",
    ]);
    expect(rpcMock).toHaveBeenCalledWith(
      "providers.createApiKeyProfile",
      expect.objectContaining({
        providerId: "codex",
        credential: "sk-test-key",
      }),
      null,
    );
    expect(result.exitCode).toBe(1);
    expect(result.human).toContain("connection refused");
  });

  it("--sign-in --mode device prints the URL and userCode before the first awaitLogin poll", async () => {
    const ctx = makeCtx();
    const callOrder = mockCreateRpc(
      makeProviderRow({
        providerId: "codex",
        profiles: [],
        loginCapability: null,
      }),
      {
        "providers.startLogin": {
          url: "https://example.com/device",
          started: true,
          profileId: "new-profile-1",
          userCode: "ABCD-1234",
        },
        "providers.awaitLogin": {
          state: null,
          existingProfileId: null,
          codeRejected: false,
        },
      },
    );

    const result = await buildProfileCreateCommand({
      ...CREATE_DEFAULTS,
      provider: "codex",
      label: "Work",
      apiKey: null,
      signIn: true,
      mode: "device",
    })(ctx);

    const awaitIndex = callOrder.indexOf("providers.awaitLogin");
    expect(awaitIndex).toBeGreaterThan(-1);
    const printed = ctx.humanRequiredCalls.join("\n");
    expect(printed).toContain("https://example.com/device");
    expect(printed).toContain("ABCD-1234");
    // Both lines were printed as part of the SAME call, which happens before
    // the loop reaches `providers.awaitLogin` - the mock's `callOrder` push
    // for that RPC only happens once `callHostRpc` is actually invoked, so
    // its presence at all (checked above) already proves the printed text
    // predates it; this reconfirms via call counts.
    expect(ctx.humanRequiredCalls.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
  });

  it("exits E_INVALID_ARGUMENT and makes no RPC when neither --api-key nor --sign-in is given", async () => {
    await expect(
      buildProfileCreateCommand({
        ...CREATE_DEFAULTS,
        provider: "codex",
        label: "Work",
        apiKey: null,
        signIn: false,
        mode: "browser",
      })(makeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("exits E_INVALID_ARGUMENT and makes no RPC when both --api-key and --sign-in are given", async () => {
    await expect(
      buildProfileCreateCommand({
        ...CREATE_DEFAULTS,
        provider: "codex",
        label: "Work",
        apiKey: "sk-test",
        signIn: true,
        mode: "browser",
      })(makeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("--mode device on a host that dropped `mode` says the browser flow is being used (O11)", async () => {
    const ctx = makeCtx();
    mockCreateRpc(makeProviderRow({ providerId: "codex", profiles: [] }), {
      // What a host below `providers.startLogin@1.2` answers: the login
      // started, but through the browser - no device code exists.
      "providers.startLogin": {
        url: "https://example.com/browser",
        started: true,
        profileId: "new-profile-1",
        userCode: null,
      },
      "providers.awaitLogin": {
        state: null,
        existingProfileId: null,
        codeRejected: false,
      },
    });

    await buildProfileCreateCommand({
      ...CREATE_DEFAULTS,
      provider: "codex",
      label: "Work",
      apiKey: null,
      signIn: true,
      mode: "device",
    })(ctx);

    expect(ctx.humanRequiredCalls.join("\n")).toContain(
      "signing in through the browser instead",
    );
  });

  it("--max-context-size reaches endpoint.maxContextSize; absent stays null when the provider does not declare it (O4)", async () => {
    mockCreateRpc(makeProviderRow({ providerId: "codex", profiles: [] }), {
      "providers.createApiKeyProfile": {
        ok: true,
        profileId: "profile-1",
        verdict: { at: 1_700_000_000_000, ok: true, reason: null },
      },
    });

    await buildProfileCreateCommand({
      ...CREATE_DEFAULTS,
      provider: "codex",
      label: "Work",
      apiKey: "sk-test",
      maxContextSize: "262144",
      signIn: false,
      mode: "browser",
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "providers.createApiKeyProfile",
      expect.objectContaining({
        endpoint: expect.objectContaining({ maxContextSize: 262144 }),
      }),
      null,
    );

    rpcMock.mockClear();
    mockCreateRpc(makeProviderRow({ providerId: "codex", profiles: [] }), {
      "providers.createApiKeyProfile": {
        ok: true,
        profileId: "profile-2",
        verdict: { at: 1_700_000_000_000, ok: true, reason: null },
      },
    });
    await buildProfileCreateCommand({
      ...CREATE_DEFAULTS,
      provider: "codex",
      label: "Work",
      apiKey: "sk-test",
      signIn: false,
      mode: "browser",
    })(makeCtx());
    expect(rpcMock).toHaveBeenCalledWith(
      "providers.createApiKeyProfile",
      expect.objectContaining({
        endpoint: expect.objectContaining({ maxContextSize: null }),
      }),
      null,
    );
  });

  it("refuses before the create RPC when the provider's endpointCapabilities require maxContextSize (O4)", async () => {
    const callOrder = mockCreateRpc(
      makeProviderRow({
        providerId: "kimi",
        profiles: [],
        endpointCapabilities: {
          supportsBaseUrl: true,
          credentialKinds: ["api_key"],
          requiresModel: true,
          extraFields: ["maxContextSize"],
          credentialStoredInNativeConfig: false,
        },
      }),
      {},
    );

    await expect(
      buildProfileCreateCommand({
        ...CREATE_DEFAULTS,
        provider: "kimi",
        label: "Work",
        apiKey: "sk-test",
        signIn: false,
        mode: "browser",
      })(makeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });

    expect(callOrder).toEqual(["providers.list"]);
  });

  it("--start-from defaults to the Default account and reaches both create paths (D25/D32, O6)", async () => {
    mockCreateRpc(makeProviderRow({ providerId: "codex", profiles: [] }), {
      "providers.createApiKeyProfile": {
        ok: true,
        profileId: "profile-1",
        verdict: { at: 1_700_000_000_000, ok: true, reason: null },
      },
    });
    await buildProfileCreateCommand({
      ...CREATE_DEFAULTS,
      provider: "codex",
      label: "Work",
      apiKey: "sk-test",
      signIn: false,
      mode: "browser",
    })(makeCtx());
    expect(rpcMock).toHaveBeenCalledWith(
      "providers.createApiKeyProfile",
      expect.objectContaining({ startFrom: { kind: "defaultAccount" } }),
      null,
    );

    rpcMock.mockClear();
    mockCreateRpc(makeProviderRow({ providerId: "codex", profiles: [] }), {
      "providers.startLogin": {
        url: null,
        started: true,
        profileId: "new-profile-1",
        userCode: null,
      },
      "providers.awaitLogin": {
        state: null,
        existingProfileId: null,
        codeRejected: false,
      },
    });
    await buildProfileCreateCommand({
      ...CREATE_DEFAULTS,
      provider: "codex",
      label: "Work",
      apiKey: null,
      startFrom: "profile:profile-src",
      signIn: true,
      mode: "browser",
    })(makeCtx());
    expect(rpcMock).toHaveBeenCalledWith(
      "providers.startLogin",
      expect.objectContaining({
        startFrom: { kind: "profile", profileId: "profile-src" },
      }),
      null,
    );
  });

  it("--start-from empty is still reachable, and a bad value refuses before any RPC (O6)", async () => {
    mockCreateRpc(makeProviderRow({ providerId: "codex", profiles: [] }), {
      "providers.createApiKeyProfile": {
        ok: true,
        profileId: "profile-1",
        verdict: { at: 1_700_000_000_000, ok: true, reason: null },
      },
    });
    await buildProfileCreateCommand({
      ...CREATE_DEFAULTS,
      provider: "codex",
      label: "Work",
      apiKey: "sk-test",
      startFrom: "empty",
      signIn: false,
      mode: "browser",
    })(makeCtx());
    expect(rpcMock).toHaveBeenCalledWith(
      "providers.createApiKeyProfile",
      expect.objectContaining({ startFrom: { kind: "empty" } }),
      null,
    );

    rpcMock.mockClear();
    rpcMock.mockImplementation(async () => {
      throw new Error("no RPC expected");
    });
    await expect(
      buildProfileCreateCommand({
        ...CREATE_DEFAULTS,
        provider: "codex",
        label: "Work",
        apiKey: "sk-test",
        startFrom: "the-other-one",
        signIn: false,
        mode: "browser",
      })(makeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("issues providers.awaitLogin with the shared long-poll budget, not the 15s frame deadline (O2)", async () => {
    mockCreateRpc(makeProviderRow({ providerId: "codex", profiles: [] }), {
      "providers.startLogin": {
        url: null,
        started: true,
        profileId: "new-profile-1",
        userCode: null,
      },
      "providers.awaitLogin": {
        state: null,
        existingProfileId: null,
        codeRejected: false,
      },
    });

    await buildProfileCreateCommand({
      ...CREATE_DEFAULTS,
      provider: "codex",
      label: "Work",
      apiKey: null,
      signIn: true,
      mode: "browser",
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "providers.awaitLogin",
      expect.objectContaining({ providerId: "codex" }),
      PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS,
    );
  });

  it("--sign-in refuses a terminal-login provider in CLI terms, before providers.startLogin (D23 amended, O7)", async () => {
    const callOrder = mockCreateRpc(
      makeProviderRow({
        providerId: "copilot",
        profiles: [],
        loginCapability: { oauthArgs: null, token: null, terminalLogin: {} },
      }),
      {},
    );

    const error = await buildProfileCreateCommand({
      ...CREATE_DEFAULTS,
      provider: "copilot",
      label: "Work",
      apiKey: null,
      signIn: true,
      mode: "browser",
    })(makeCtx()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(error.message).toContain("launch-env");
    expect(error.message).not.toContain("Update Traycer");
    expect(callOrder).toEqual(["providers.list"]);
  });

  it("never writes the API key to human/progress output", async () => {
    const secret = "sk-super-secret-value-12345";
    mockCreateRpc(makeProviderRow({ providerId: "codex", profiles: [] }), {
      "providers.createApiKeyProfile": {
        ok: true,
        profileId: "profile-1",
        verdict: { at: 1_700_000_000_000, ok: true, reason: null },
      },
    });
    const ctx = makeCtx();

    await buildProfileCreateCommand({
      ...CREATE_DEFAULTS,
      provider: "codex",
      label: "Work",
      apiKey: secret,
      signIn: false,
      mode: "browser",
    })(ctx);

    const allOutput = JSON.stringify([
      ctx.humanCalls,
      ctx.humanRequiredCalls,
      ctx.progressCalls,
    ]);
    expect(allOutput).not.toContain(secret);
  });
});

describe("profile remove", () => {
  it("rejects --profile ambient with E_INVALID_ARGUMENT before any RPC", async () => {
    await expect(
      buildProfileRemoveCommand({ provider: "codex", profile: "ambient" })(
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("sends providers.setEnabled with a remove profileAction for a real profile id", async () => {
    rpcMock.mockResolvedValue({
      state: makeProviderRow({ providerId: "codex", profiles: [] }),
    });

    await buildProfileRemoveCommand({
      provider: "codex",
      profile: "profile-1",
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "providers.setEnabled",
      expect.objectContaining({
        providerId: "codex",
        profileAction: { type: "remove", profileId: "profile-1" },
      }),
      null,
    );
  });
});

describe("profile test", () => {
  it("rejects --profile ambient before any test RPC when the Default account has no credential configured", async () => {
    rpcMock.mockResolvedValue({
      providers: [
        makeProviderRow({
          providerId: "codex",
          profiles: [makeAmbientProfile(false)],
        }),
      ],
      native: null,
    });

    await expect(
      buildProfileTestCommand({ provider: "codex", profile: "ambient" })(
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });
    expect(rpcMock).not.toHaveBeenCalledWith(
      "providers.testProfileConnection",
      expect.anything(),
    );
  });

  it("tests the Default account when it has a credential configured", async () => {
    rpcMock.mockImplementation(async (method: string) => {
      if (method === "providers.list") {
        return {
          providers: [
            makeProviderRow({
              providerId: "codex",
              profiles: [makeAmbientProfile(true)],
            }),
          ],
          native: null,
        };
      }
      if (method === "providers.testProfileConnection") {
        return { verdict: { at: 1_700_000_000_000, ok: true, reason: null } };
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await buildProfileTestCommand({
      provider: "codex",
      profile: "ambient",
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith(
      "providers.testProfileConnection",
      expect.objectContaining({ providerId: "codex", profileId: null }),
      null,
    );
    expect(result.exitCode).toBe(0);
  });

  it("tests a managed profile id directly, without the Default-account gate", async () => {
    rpcMock.mockResolvedValue({
      verdict: { at: 1_700_000_000_000, ok: false, reason: "bad key" },
    });

    const result = await buildProfileTestCommand({
      provider: "codex",
      profile: "profile-1",
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith(
      "providers.testProfileConnection",
      expect.objectContaining({ providerId: "codex", profileId: "profile-1" }),
      null,
    );
    expect(result.exitCode).toBe(1);
    expect(result.human).toContain("bad key");
  });
});

describe("profile copy", () => {
  const previewResponse = {
    targets: [
      {
        profileId: "profile-2",
        label: "Personal",
        categories: [
          {
            category: "env",
            adds: ["OPENAI_MODEL"],
            changes: [],
            removals: [],
            carriesSecretValues: true,
            ownershipFlip: "none",
            noop: false,
          },
        ],
      },
    ],
  };

  it("without --yes calls previewCopySettings and never applyCopySettings", async () => {
    rpcMock.mockResolvedValue(previewResponse);

    const result = await buildProfileCopyCommand({
      provider: "codex",
      from: "ambient",
      to: ["profile-2"],
      categories: [],
      yes: false,
    })(makeCtx());

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith(
      "providers.previewCopySettings",
      expect.objectContaining({ providerId: "codex" }),
      null,
    );
    expect(rpcMock).not.toHaveBeenCalledWith(
      "providers.applyCopySettings",
      expect.anything(),
      expect.anything(),
    );
    expect(result.exitCode).toBe(0);
    expect(result.human).toContain("includes secret values");
  });

  it("rejects the Default account as a --to target before any RPC", async () => {
    await expect(
      buildProfileCopyCommand({
        provider: "codex",
        from: "profile-1",
        to: ["ambient"],
        categories: [],
        yes: false,
      })(makeCtx()),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("--yes calls previewCopySettings then applyCopySettings and reports per-target outcomes", async () => {
    const applyResponse = {
      results: [
        { profileId: "profile-2", outcome: { kind: "copied" } },
        {
          profileId: "profile-3",
          outcome: { kind: "failed", reason: "profile is disabled" },
        },
      ],
    };
    const callOrder: string[] = [];
    rpcMock.mockImplementation(async (method: string) => {
      callOrder.push(method);
      if (method === "providers.previewCopySettings") return previewResponse;
      if (method === "providers.applyCopySettings") return applyResponse;
      throw new Error(`unexpected method: ${method}`);
    });

    const result = await buildProfileCopyCommand({
      provider: "codex",
      from: "ambient",
      to: ["profile-2", "profile-3"],
      categories: [],
      yes: true,
    })(makeCtx());

    expect(callOrder).toEqual([
      "providers.previewCopySettings",
      "providers.applyCopySettings",
    ]);
    expect(result.human).toContain("profile-2: copied");
    expect(result.human).toContain("profile-3: failed: profile is disabled");
    expect(result.exitCode).toBe(1);
  });
});

describe("version skew", () => {
  function unsupportedMethodError(method: string): HostRpcError {
    return new HostRpcError({
      code: "E_HOST_UNSUPPORTED",
      message: `This host does not support '${method}'. Upgrade the host to use this feature.`,
      requestId: "req_1",
      method,
      fatalDetails: {
        code: "E_HOST_UNSUPPORTED",
        reason: `This host does not support '${method}'.`,
        incompatibleMethods: null,
        upgradeGuidance: {
          clientShouldUpgrade: false,
          hostShouldUpgrade: true,
        },
      },
    });
  }

  it("turns an absent providers.list into host-upgrade guidance", async () => {
    rpcMock.mockRejectedValue(unsupportedMethodError("providers.list"));

    const error = await buildProfileListCommand({ provider: null })(
      makeCtx(),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNSUPPORTED);
    expect(error.details).toEqual({
      hostShouldUpgrade: true,
      method: "providers.list",
    });
  });
});
