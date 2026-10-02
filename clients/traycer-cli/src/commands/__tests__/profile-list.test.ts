import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  providerCliStateSchema,
  providerProfileSchema,
  type ProviderCliState,
  type ProviderId,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { callHostRpc } from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";
import { buildProfileListCommand } from "../profile-list";

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

function makeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
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

interface ProfileSpec {
  readonly profileId: string;
  readonly kind: "ambient" | "managed";
  readonly label: string;
  readonly email: string | null;
  readonly authStatus: "authenticated" | "unauthenticated";
  readonly enabled: boolean;
}

function profileFixture(spec: ProfileSpec): ProviderProfile {
  return providerProfileSchema.parse({
    profileId: spec.profileId,
    kind: spec.kind,
    authType: "oauth",
    label: spec.label,
    auth: {
      status: spec.authStatus,
      badgeText: null,
      label: null,
      detail: null,
    },
    identity:
      spec.email === null
        ? null
        : { email: spec.email, tier: null, accountUuid: null },
    usageUpdatedAt: null,
    rateLimitStatus: "ok",
    enabled: spec.enabled,
  });
}

function stateFixture(
  providerId: ProviderId,
  profiles: readonly ProfileSpec[],
): ProviderCliState {
  return providerCliStateSchema.parse({
    providerId,
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
    profiles: profiles.map(profileFixture),
  });
}

const CLAUDE_PROFILES: readonly ProfileSpec[] = [
  {
    profileId: "ambient",
    kind: "ambient",
    label: "Terminal login",
    email: "me@example.com",
    authStatus: "authenticated",
    enabled: true,
  },
  {
    profileId: "prof_work",
    kind: "managed",
    label: "Work",
    email: null,
    authStatus: "unauthenticated",
    enabled: false,
  },
];

const CODEX_PROFILES: readonly ProfileSpec[] = [
  {
    profileId: "prof_codex",
    kind: "managed",
    label: "Codex main",
    email: "codex@example.com",
    authStatus: "authenticated",
    enabled: true,
  },
];

function respondWith(states: readonly ProviderCliState[]): void {
  rpcMock.mockResolvedValue({ providers: [...states], native: null });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("traycer profile list", () => {
  it("lists only the providers that have profile rows when no provider is given", async () => {
    respondWith([
      stateFixture("claude-code", CLAUDE_PROFILES),
      stateFixture("opencode", []),
      stateFixture("codex", CODEX_PROFILES),
    ]);

    const result = await buildProfileListCommand({ provider: null })(makeCtx());

    expect(rpcMock).toHaveBeenCalledWith("providers.list", { native: null });
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      providers: [
        {
          providerId: "claude-code",
          harnessId: "claude",
          profiles: [
            {
              profileId: "ambient",
              label: "Terminal login",
              kind: "ambient",
              email: "me@example.com",
              enabled: true,
              authStatus: "authenticated",
              rateLimitStatus: "ok",
            },
            {
              profileId: "prof_work",
              label: "Work",
              kind: "managed",
              email: null,
              enabled: false,
              authStatus: "unauthenticated",
              rateLimitStatus: "ok",
            },
          ],
        },
        {
          providerId: "codex",
          harnessId: "codex",
          profiles: [
            {
              profileId: "prof_codex",
              label: "Codex main",
              kind: "managed",
              email: "codex@example.com",
              enabled: true,
              authStatus: "authenticated",
              rateLimitStatus: "ok",
            },
          ],
        },
      ],
    });
    expect(result.human).toContain("claude (Claude Code)");
    expect(result.human).toContain("codex (Codex)");
    expect(result.human).not.toContain("opencode");
  });

  it("renders the human table with the account, state and sign-in columns", async () => {
    respondWith([stateFixture("claude-code", CLAUDE_PROFILES)]);

    const result = await buildProfileListCommand({ provider: null })(makeCtx());

    expect(result.human).toMatch(
      /PROFILE\s+LABEL\s+ACCOUNT\s+STATE\s+SIGN-IN\s+LIMIT/,
    );
    expect(result.human).toMatch(
      /ambient\s+Terminal login\s+me@example\.com\s+enabled\s+authenticated\s+ok/,
    );
    expect(result.human).toMatch(
      /prof_work\s+Work\s+-\s+disabled\s+unauthenticated\s+ok/,
    );
  });

  it("says so when no provider has a profile", async () => {
    respondWith([stateFixture("claude-code", []), stateFixture("codex", [])]);

    const result = await buildProfileListCommand({ provider: null })(makeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ providers: [] });
    expect(result.human).toBe("No profiles on this host.");
  });

  it("filters to one provider", async () => {
    respondWith([
      stateFixture("claude-code", CLAUDE_PROFILES),
      stateFixture("codex", CODEX_PROFILES),
    ]);

    const result = await buildProfileListCommand({ provider: "codex" })(
      makeCtx(),
    );

    expect(result.data).toEqual({
      providers: [
        expect.objectContaining({
          providerId: "codex",
          profiles: [expect.objectContaining({ profileId: "prof_codex" })],
        }),
      ],
    });
    expect(result.human).toContain("codex (Codex)");
    expect(result.human).not.toContain("claude");
  });

  it("reports no profiles for a named provider that has none", async () => {
    respondWith([
      stateFixture("claude-code", CLAUDE_PROFILES),
      stateFixture("opencode", []),
    ]);

    const result = await buildProfileListCommand({ provider: "opencode" })(
      makeCtx(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      providers: [
        { providerId: "opencode", harnessId: "opencode", profiles: [] },
      ],
    });
    expect(result.human).toBe(
      "No profiles for opencode (OpenCode) on this host.",
    );
  });

  it("reports no profiles for a named provider the host did not list", async () => {
    respondWith([stateFixture("claude-code", CLAUDE_PROFILES)]);

    const result = await buildProfileListCommand({ provider: "codex" })(
      makeCtx(),
    );

    expect(result.data).toEqual({ providers: [] });
    expect(result.human).toBe("No profiles for codex (Codex) on this host.");
  });

  it("accepts both the harness id and the provider id", async () => {
    respondWith([
      stateFixture("claude-code", CLAUDE_PROFILES),
      stateFixture("codex", CODEX_PROFILES),
    ]);

    const byHarness = await buildProfileListCommand({ provider: "claude" })(
      makeCtx(),
    );
    const byProvider = await buildProfileListCommand({
      provider: "claude-code",
    })(makeCtx());

    expect(byHarness.data).toEqual(byProvider.data);
    expect(byHarness.data).toEqual({
      providers: [
        expect.objectContaining({
          providerId: "claude-code",
          harnessId: "claude",
        }),
      ],
    });
  });

  it("rejects an unknown provider before reaching the host", async () => {
    const error = await buildProfileListCommand({ provider: "not-a-provider" })(
      makeCtx(),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("unreachable");
    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(error.message).toContain("not-a-provider");
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
