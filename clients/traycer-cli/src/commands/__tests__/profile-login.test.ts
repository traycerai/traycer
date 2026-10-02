import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS,
  providerCliStateSchema,
  providerMutationCliStateSchemaV21,
  providersAwaitLoginResponseSchema,
  providersStartLoginResponseSchemaV13,
  type ProviderCliState,
  type ProviderMutationCliStateV21,
  type ProvidersAwaitLoginResponse,
  type ProvidersStartLoginResponseV13,
} from "@traycer/protocol/host/provider-schemas";
import {
  callHostRpc,
  callHostRpcWithDispatch,
  type HostRpcDispatch,
} from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext, CommandResult } from "../../runner/runner";
import {
  buildProfileLoginCommand,
  type ProfileLoginIo,
  type ProfileLoginTarget,
} from "../profile-login";

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
    callHostRpcWithDispatch: vi.fn(),
  };
});

const rpcMock = vi.mocked(callHostRpc);
const dispatchMock = vi.mocked(callHostRpcWithDispatch);

// ---------------------------------------------------------------------------
// Fixtures. Every host payload is parsed through its protocol schema, so a
// fixture that drifts from the wire shape fails here and not silently.
// ---------------------------------------------------------------------------

type AuthStatus = "authenticated" | "unauthenticated" | "unknown";

interface ProfileSpec {
  readonly profileId: string;
  readonly label: string;
  readonly email: string | null;
  readonly authStatus: AuthStatus;
}

interface StateSpec {
  readonly auth: AuthStatus;
  readonly authPending: boolean;
  readonly profiles: readonly ProfileSpec[];
}

function authInput(status: AuthStatus): object {
  return { status, badgeText: null, label: null, detail: null };
}

function profileInput(spec: ProfileSpec): object {
  return {
    profileId: spec.profileId,
    kind: "managed",
    authType: "oauth",
    label: spec.label,
    auth: authInput(spec.authStatus),
    identity:
      spec.email === null
        ? null
        : { email: spec.email, tier: null, accountUuid: null },
    usageUpdatedAt: null,
    rateLimitStatus: "ok",
  };
}

function stateInput(spec: StateSpec): object {
  return {
    providerId: "claude-code",
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: spec.authPending,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    auth: authInput(spec.auth),
    profiles: spec.profiles.map(profileInput),
  };
}

interface ListSpec {
  readonly profiles: readonly ProfileSpec[];
  readonly codePaste: boolean;
  readonly selfOpensBrowser: boolean;
}

/** The `providers.list` row the command reads the login capability from. */
function listState(spec: ListSpec): ProviderCliState {
  return providerCliStateSchema.parse({
    ...stateInput({
      auth: "authenticated",
      authPending: false,
      profiles: spec.profiles,
    }),
    loginCapability: {
      oauthArgs: [],
      token: null,
      codePaste: spec.codePaste ? {} : null,
      terminalLogin: null,
      remoteSafe: null,
      selfOpensBrowser: spec.selfOpensBrowser ? {} : null,
    },
  });
}

function mutationState(spec: StateSpec): ProviderMutationCliStateV21 {
  return providerMutationCliStateSchemaV21.parse(stateInput(spec));
}

interface StartSpec {
  readonly started: boolean;
  readonly url: string | null;
  readonly profileId: string | null;
  readonly userCode: string | null;
  readonly failure: "device_auth_unavailable" | "device_code_missing" | null;
  readonly pending: "pack_preparing" | "starting" | null;
  readonly pack: {
    readonly percent: number | null;
    readonly reason: string | null;
  } | null;
}

const DEFAULT_START: StartSpec = {
  started: true,
  url: "https://claude.ai/oauth/authorize?code=1",
  profileId: null,
  userCode: null,
  failure: null,
  pending: null,
  pack: null,
};

function startAnswer(
  fields: Partial<StartSpec>,
): ProvidersStartLoginResponseV13 {
  return providersStartLoginResponseSchemaV13.parse({
    ...DEFAULT_START,
    ...fields,
  });
}

interface AwaitSpec {
  readonly state: StateSpec | null;
  readonly existingProfileId: string | null;
  readonly codeRejected: boolean;
  readonly refusal: {
    readonly reason: string;
    readonly actionUrl: string | null;
  } | null;
}

const DEFAULT_AWAIT: AwaitSpec = {
  state: null,
  existingProfileId: null,
  codeRejected: false,
  refusal: null,
};

function awaitResult(fields: Partial<AwaitSpec>): ProvidersAwaitLoginResponse {
  const spec = { ...DEFAULT_AWAIT, ...fields };
  return providersAwaitLoginResponseSchema.parse({
    ...spec,
    state: spec.state === null ? null : stateInput(spec.state),
  });
}

function signedInState(profiles: readonly ProfileSpec[]): StateSpec {
  return { auth: "authenticated", authPending: false, profiles };
}

const NEW_PROFILE: ProfileSpec = {
  profileId: "prof_new",
  label: "Work",
  email: "jane.doe@example.com",
  authStatus: "authenticated",
};

const WORK_PROFILE: ProfileSpec = {
  profileId: "prof_work",
  label: "Work",
  email: "work@example.com",
  authStatus: "authenticated",
};

function rowOf(profile: ProfileSpec, label: string): object {
  return {
    profileId: profile.profileId,
    label,
    kind: "managed",
    email: profile.email,
    enabled: true,
    authStatus: profile.authStatus,
    rateLimitStatus: "ok",
  };
}

// ---------------------------------------------------------------------------
// Scenario: what the fake host answers, routed by method name.
// ---------------------------------------------------------------------------

interface Scenario {
  listState: ProviderCliState;
  startAnswers: readonly ProvidersStartLoginResponseV13[];
  awaitLogin: (
    dispatch: HostRpcDispatch,
  ) => Promise<ProvidersAwaitLoginResponse>;
}

const NO_PROFILES: ListSpec = {
  profiles: [],
  codePaste: false,
  selfOpensBrowser: false,
};

let scenario: Scenario;
let startIndex = 0;

function defaultScenario(): Scenario {
  return {
    listState: listState(NO_PROFILES),
    startAnswers: [startAnswer({ profileId: "prof_new" })],
    awaitLogin: () =>
      Promise.resolve(awaitResult({ state: signedInState([NEW_PROFILE]) })),
  };
}

function nextStartAnswer(): ProvidersStartLoginResponseV13 {
  const index = Math.min(startIndex, scenario.startAnswers.length - 1);
  startIndex += 1;
  const answer = scenario.startAnswers[index];
  if (answer === undefined) throw new Error("scenario has no start answer");
  return answer;
}

type DispatchCall = (typeof dispatchMock.mock.calls)[number];

function callsTo(method: string): DispatchCall[] {
  return dispatchMock.mock.calls.filter((call) => call[0] === method);
}

function onlyCallTo(method: string): DispatchCall {
  const calls = callsTo(method);
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (call === undefined) throw new Error(`unreachable: no ${method} call`);
  return call;
}

function submitCalls(): (typeof rpcMock.mock.calls)[number][] {
  return rpcMock.mock.calls.filter(
    (call) => call[0] === "providers.submitLoginCode",
  );
}

const START_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: null,
  requiredHostMethodVersion: {
    method: "providers.startLogin",
    version: { major: 1, minor: 4 },
  },
  signal: null,
};

const CANCEL_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: null,
  requiredHostMethodVersion: {
    method: "providers.cancelLogin",
    version: { major: 1, minor: 2 },
  },
  signal: null,
};

const RENAME_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: null,
  requiredHostMethodVersion: {
    method: "providers.setEnabled",
    version: { major: 2, minor: 1 },
  },
  signal: null,
};

// ---------------------------------------------------------------------------
// Fake process edges.
// ---------------------------------------------------------------------------

interface FakeIo {
  readonly io: ProfileLoginIo;
  readonly openUrl: Mock<ProfileLoginIo["openUrl"]>;
  readonly wait: Mock<ProfileLoginIo["wait"]>;
  readonly onInterrupt: Mock<ProfileLoginIo["onInterrupt"]>;
  readonly readLines: Mock<ProfileLoginIo["readLines"]>;
  readonly interruptHandlers: (() => void)[];
  readonly lineSinks: ((line: string) => void)[];
  readonly stopInterrupt: Mock<() => void>;
  readonly stopReading: Mock<() => void>;
}

const HOLDER_ID = "holder-1";

function makeIo(hasTerminal: boolean): FakeIo {
  const interruptHandlers: (() => void)[] = [];
  const lineSinks: ((line: string) => void)[] = [];
  const stopInterrupt = vi.fn<() => void>();
  const stopReading = vi.fn<() => void>();
  const openUrl = vi.fn<ProfileLoginIo["openUrl"]>();
  const wait = vi.fn<ProfileLoginIo["wait"]>(() => Promise.resolve());
  const onInterrupt = vi.fn<ProfileLoginIo["onInterrupt"]>((handler) => {
    interruptHandlers.push(handler);
    return stopInterrupt;
  });
  const readLines = vi.fn<ProfileLoginIo["readLines"]>((onLine) => {
    if (!hasTerminal) return null;
    lineSinks.push(onLine);
    return stopReading;
  });
  return {
    io: {
      newHolderId: () => HOLDER_ID,
      openUrl,
      wait,
      onInterrupt,
      readLines,
    },
    openUrl,
    wait,
    onInterrupt,
    readLines,
    interruptHandlers,
    lineSinks,
    stopInterrupt,
    stopReading,
  };
}

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

function create(label: string | null): ProfileLoginTarget {
  return { kind: "create", label };
}

function existing(profile: string): ProfileLoginTarget {
  return { kind: "existing", profile };
}

function runLogin(
  target: ProfileLoginTarget,
  fake: FakeIo,
  ctx: CommandContext,
): Promise<CommandResult> {
  return buildProfileLoginCommand({ provider: "claude", target }, fake.io)(ctx);
}

async function failureOf(run: Promise<unknown>): Promise<CliError> {
  const error = await run.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(CliError);
  if (!(error instanceof CliError)) throw new Error("unreachable");
  return error;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  scenario = defaultScenario();
  startIndex = 0;
  rpcMock.mockImplementation((method) => {
    switch (method) {
      case "providers.list":
        return Promise.resolve({
          providers: [scenario.listState],
          native: null,
        });
      case "providers.submitLoginCode":
        return Promise.resolve({ outcome: "accepted" });
      case "providers.touchLogin":
        return Promise.resolve({ extended: true });
      default:
        return Promise.reject(new Error(`unexpected rpc ${method}`));
    }
  });
  dispatchMock.mockImplementation((method, _params, dispatch) => {
    switch (method) {
      case "providers.startLogin":
        return Promise.resolve(nextStartAnswer());
      case "providers.awaitLogin":
        return scenario.awaitLogin(dispatch);
      case "providers.cancelLogin":
        return Promise.resolve({ cancelled: true });
      case "providers.setEnabled":
        return Promise.resolve({ state: mutationState(signedInState([])) });
      default:
        return Promise.reject(new Error(`unexpected dispatch ${method}`));
    }
  });
});

// ---------------------------------------------------------------------------

describe("profile add (create)", () => {
  it("starts a create with the holder id and the dispatch floor, then awaits with the long-poll budget", async () => {
    const fake = makeIo(false);

    const result = await runLogin(create("Work"), fake, makeCtx(false, false));

    const [, startParams, startDispatch] = onlyCallTo("providers.startLogin");
    expect(startParams).toEqual({
      providerId: "claude-code",
      holderId: HOLDER_ID,
      profileId: null,
      createProfile: { label: "Work", shareSkillsAndPlugins: false },
    });
    expect(startDispatch).toEqual(START_DISPATCH);

    const [, awaitParams, awaitDispatch] = onlyCallTo("providers.awaitLogin");
    expect(awaitParams).toEqual({
      providerId: "claude-code",
      profileId: "prof_new",
    });
    expect(awaitDispatch.responseTimeoutMs).toBe(
      PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS,
    );
    expect(awaitDispatch.signal).toBeInstanceOf(AbortSignal);
    expect(awaitDispatch.requiredHostMethodVersion).toBeNull();

    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "signed-in",
      profile: rowOf(NEW_PROFILE, "Work"),
      created: true,
    });
    expect(result.human).toContain(
      "Added claude (Claude Code) profile prof_new",
    );
    expect(fake.stopInterrupt).toHaveBeenCalledTimes(1);
  });

  it("renames a profile created without --label to the email prefix", async () => {
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          state: signedInState([{ ...NEW_PROFILE, label: "Pending" }]),
        }),
      );
    const fake = makeIo(false);

    const result = await runLogin(create(null), fake, makeCtx(false, false));

    const [, startParams] = onlyCallTo("providers.startLogin");
    expect(startParams).toEqual(
      expect.objectContaining({
        createProfile: { label: "", shareSkillsAndPlugins: false },
      }),
    );
    const [, renameParams, renameDispatch] = onlyCallTo("providers.setEnabled");
    expect(renameParams).toEqual({
      providerId: "claude-code",
      enabled: true,
      profileAction: {
        type: "rename",
        profileId: "prof_new",
        label: "jane.doe",
      },
    });
    expect(renameDispatch).toEqual(RENAME_DISPATCH);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual(
      expect.objectContaining({
        status: "signed-in",
        created: true,
        profile: rowOf(NEW_PROFILE, "jane.doe"),
      }),
    );
  });

  it("does not rename when --label was given", async () => {
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          state: signedInState([{ ...NEW_PROFILE, label: "Pending" }]),
        }),
      );

    const result = await runLogin(
      create("My label"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(callsTo("providers.setEnabled")).toHaveLength(0);
    expect(result.data).toEqual(
      expect.objectContaining({
        profile: rowOf(NEW_PROFILE, "Pending"),
      }),
    );
  });

  it("does not rename when the account has no email to take a prefix from", async () => {
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          state: signedInState([
            { ...NEW_PROFILE, label: "Pending", email: null },
          ]),
        }),
      );

    const result = await runLogin(
      create(null),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(callsTo("providers.setEnabled")).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("rejects an over-long --label before asking the host to start anything", async () => {
    const error = await failureOf(
      runLogin(create("x".repeat(65)), makeIo(false), makeCtx(false, false)),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(callsTo("providers.startLogin")).toHaveLength(0);
  });

  it("reports the existing profile when the account is already one", async () => {
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          state: signedInState([WORK_PROFILE]),
          existingProfileId: "prof_work",
        }),
      );

    const result = await runLogin(
      create("Dup"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "already-exists",
      profile: rowOf(WORK_PROFILE, "Work"),
    });
    expect(result.human).toContain("already");
    expect(callsTo("providers.setEnabled")).toHaveLength(0);
  });

  it("is not signed in when the new profile's row is not authenticated", async () => {
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          state: signedInState([
            { ...NEW_PROFILE, authStatus: "unauthenticated" },
          ]),
        }),
      );

    const result = await runLogin(
      create("Work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data).toEqual(
      expect.objectContaining({ status: "not-completed" }),
    );
  });
});

describe("profile login (existing)", () => {
  it("passes a managed profile id through to start and await", async () => {
    scenario.listState = listState({
      ...NO_PROFILES,
      profiles: [WORK_PROFILE],
    });
    scenario.startAnswers = [startAnswer({ profileId: "prof_work" })];
    scenario.awaitLogin = () =>
      Promise.resolve(awaitResult({ state: signedInState([WORK_PROFILE]) }));

    const result = await runLogin(
      existing("prof_work"),
      makeIo(false),
      makeCtx(false, false),
    );

    const [, startParams] = onlyCallTo("providers.startLogin");
    expect(startParams).toEqual({
      providerId: "claude-code",
      holderId: HOLDER_ID,
      profileId: "prof_work",
      createProfile: null,
    });
    const [, awaitParams] = onlyCallTo("providers.awaitLogin");
    expect(awaitParams).toEqual({
      providerId: "claude-code",
      profileId: "prof_work",
    });
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "signed-in",
      profile: rowOf(WORK_PROFILE, "Work"),
      created: false,
    });
    expect(callsTo("providers.setEnabled")).toHaveLength(0);
  });

  it("refuses an unknown profile id before asking the host to start", async () => {
    scenario.listState = listState({
      ...NO_PROFILES,
      profiles: [WORK_PROFILE],
    });

    const error = await failureOf(
      runLogin(existing("prof_missing"), makeIo(false), makeCtx(false, false)),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.NOT_FOUND);
    expect(error.message).toContain("prof_missing");
    expect(callsTo("providers.startLogin")).toHaveLength(0);
  });

  it("reads an unauthenticated row with a rejected code as code-rejected", async () => {
    scenario.listState = listState({
      ...NO_PROFILES,
      profiles: [WORK_PROFILE],
    });
    scenario.startAnswers = [startAnswer({ profileId: "prof_work" })];
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          state: signedInState([
            { ...WORK_PROFILE, authStatus: "unauthenticated" },
          ]),
          codeRejected: true,
        }),
      );

    const result = await runLogin(
      existing("prof_work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data).toEqual(
      expect.objectContaining({ status: "code-rejected" }),
    );
  });

  it("reads an unauthenticated row without a rejected code as not-completed", async () => {
    scenario.listState = listState({
      ...NO_PROFILES,
      profiles: [WORK_PROFILE],
    });
    scenario.startAnswers = [startAnswer({ profileId: "prof_work" })];
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          state: signedInState([
            { ...WORK_PROFILE, authStatus: "unauthenticated" },
          ]),
        }),
      );

    const result = await runLogin(
      existing("prof_work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data).toEqual(
      expect.objectContaining({ status: "not-completed" }),
    );
  });

  it("reads a null state as not-completed", async () => {
    scenario.listState = listState({
      ...NO_PROFILES,
      profiles: [WORK_PROFILE],
    });
    scenario.startAnswers = [startAnswer({ profileId: "prof_work" })];
    scenario.awaitLogin = () => Promise.resolve(awaitResult({ state: null }));

    const result = await runLogin(
      existing("prof_work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "not-completed",
    });
    expect(result.human).toBe("The sign-in did not complete.");
  });

  it("reports a provider refusal with its reason and link", async () => {
    scenario.listState = listState({
      ...NO_PROFILES,
      profiles: [WORK_PROFILE],
    });
    scenario.startAnswers = [startAnswer({ profileId: "prof_work" })];
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          refusal: {
            reason: "Verify your account first.",
            actionUrl: "https://example.com/verify",
          },
        }),
      );

    const result = await runLogin(
      existing("prof_work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "refused",
      refusal: {
        reason: "Verify your account first.",
        actionUrl: "https://example.com/verify",
      },
    });
    expect(result.human).toContain("Verify your account first.");
    expect(result.human).toContain("https://example.com/verify");
  });
});

describe("profile login (ambient)", () => {
  it("addresses ambient as no profile override and judges success by the provider's own verdict", async () => {
    scenario.startAnswers = [startAnswer({ profileId: null })];
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          state: { auth: "authenticated", authPending: false, profiles: [] },
        }),
      );

    const result = await runLogin(
      existing("ambient"),
      makeIo(false),
      makeCtx(false, false),
    );

    const [, startParams] = onlyCallTo("providers.startLogin");
    expect(startParams).toEqual({
      providerId: "claude-code",
      holderId: HOLDER_ID,
      profileId: null,
      createProfile: null,
    });
    const [, awaitParams] = onlyCallTo("providers.awaitLogin");
    expect(awaitParams).toEqual({ providerId: "claude-code", profileId: null });
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "signed-in",
      profile: null,
      created: false,
    });
    expect(result.human).toBe("Signed in to claude (Claude Code).");
  });

  it("is not signed in when the provider's own verdict is unauthenticated", async () => {
    scenario.startAnswers = [startAnswer({ profileId: null })];
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          state: { auth: "unauthenticated", authPending: false, profiles: [] },
        }),
      );

    const result = await runLogin(
      existing("ambient"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data).toEqual(
      expect.objectContaining({ status: "not-completed" }),
    );
  });

  it("asks again while the ambient verdict is still in flight", async () => {
    scenario.startAnswers = [startAnswer({ profileId: null })];
    const verdicts = [
      awaitResult({
        state: { auth: "unknown", authPending: true, profiles: [] },
      }),
      awaitResult({
        state: { auth: "authenticated", authPending: false, profiles: [] },
      }),
    ];
    let asked = 0;
    scenario.awaitLogin = () => {
      const verdict = verdicts[Math.min(asked, verdicts.length - 1)];
      asked += 1;
      if (verdict === undefined) throw new Error("unreachable");
      return Promise.resolve(verdict);
    };
    const fake = makeIo(false);

    const result = await runLogin(
      existing("ambient"),
      fake,
      makeCtx(false, false),
    );

    expect(callsTo("providers.awaitLogin")).toHaveLength(2);
    expect(fake.wait).toHaveBeenCalledWith(2_000);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual(
      expect.objectContaining({ status: "signed-in" }),
    );
  });
});

describe("start answers", () => {
  it("asks the same request again while the pack downloads and the child starts", async () => {
    scenario.startAnswers = [
      startAnswer({
        started: false,
        url: null,
        pending: "pack_preparing",
        pack: { percent: 40, reason: null },
      }),
      startAnswer({ started: false, url: null, pending: "starting" }),
      startAnswer({ profileId: "prof_new" }),
    ];
    const fake = makeIo(false);
    const ctx = makeCtx(false, false);

    const result = await runLogin(create("Work"), fake, ctx);

    const starts = callsTo("providers.startLogin");
    expect(starts).toHaveLength(3);
    const first = starts[0];
    if (first === undefined) throw new Error("unreachable");
    for (const start of starts) {
      expect(start[1]).toEqual(first[1]);
      expect(start[2]).toEqual(START_DISPATCH);
    }
    expect(fake.wait).toHaveBeenCalledTimes(1);
    expect(fake.wait).toHaveBeenCalledWith(2_000);
    expect(ctx.progress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "provider-setup", percent: 40 }),
    );
    expect(result.exitCode).toBe(0);
    expect(callsTo("providers.cancelLogin")).toHaveLength(0);
  });

  it("gives up after the host keeps answering still-starting, and releases its claim", async () => {
    scenario.listState = listState({
      ...NO_PROFILES,
      profiles: [WORK_PROFILE],
    });
    scenario.startAnswers = [
      startAnswer({ started: false, url: null, pending: "starting" }),
    ];

    const result = await runLogin(
      existing("prof_work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(callsTo("providers.startLogin")).toHaveLength(12);
    expect(callsTo("providers.awaitLogin")).toHaveLength(0);
    expect(result.exitCode).toBe(1);
    expect(result.data).toEqual(
      expect.objectContaining({ status: "not-started" }),
    );
    expect(result.human).toContain("took too long");
    const [, cancelParams] = onlyCallTo("providers.cancelLogin");
    expect(cancelParams).toEqual({
      providerId: "claude-code",
      profileId: "prof_work",
      holderId: HOLDER_ID,
    });
  });

  it("is not started when the device-code flow is unavailable, and never awaits", async () => {
    scenario.startAnswers = [
      startAnswer({
        started: false,
        url: null,
        failure: "device_auth_unavailable",
      }),
    ];

    const result = await runLogin(
      create("Work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "not-started",
      message: expect.stringContaining("Device-code login is not enabled"),
    });
    expect(callsTo("providers.awaitLogin")).toHaveLength(0);
    expect(callsTo("providers.cancelLogin")).toHaveLength(0);
  });

  it("is not started when the provider's setup failed to install", async () => {
    scenario.startAnswers = [
      startAnswer({
        started: false,
        url: null,
        pack: { percent: null, reason: "network" },
      }),
    ];

    const result = await runLogin(
      create("Work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(result.exitCode).toBe(1);
    expect(result.human).toContain("did not install (network)");
    expect(callsTo("providers.awaitLogin")).toHaveLength(0);
  });

  it("releases a started create the host gave no profile id for", async () => {
    scenario.startAnswers = [startAnswer({ profileId: null })];

    const result = await runLogin(
      create("Work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data).toEqual(
      expect.objectContaining({ status: "not-started" }),
    );
    expect(callsTo("providers.awaitLogin")).toHaveLength(0);
    const [, cancelParams] = onlyCallTo("providers.cancelLogin");
    expect(cancelParams).toEqual({
      providerId: "claude-code",
      profileId: null,
      holderId: HOLDER_ID,
    });
  });
});

describe("interrupt", () => {
  it("cancels with this command's holder id and the host-minted profile id", async () => {
    scenario.awaitLogin = (dispatch) =>
      new Promise((_resolve, reject) => {
        const signal = dispatch.signal;
        if (signal === null) return;
        signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    const fake = makeIo(false);

    const run = runLogin(create("Work"), fake, makeCtx(false, false));
    await vi.waitFor(() => {
      expect(callsTo("providers.awaitLogin")).toHaveLength(1);
    });
    const handler = fake.interruptHandlers[0];
    if (handler === undefined)
      throw new Error("no interrupt handler registered");
    handler();
    const result = await run;

    expect(result.exitCode).toBe(130);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "cancelled",
    });
    expect(result.human).toBe("Sign-in cancelled.");
    const [, awaitParams, awaitDispatch] = onlyCallTo("providers.awaitLogin");
    expect(awaitParams).toEqual({
      providerId: "claude-code",
      profileId: "prof_new",
    });
    expect(awaitDispatch.signal?.aborted).toBe(true);
    const [, cancelParams, cancelDispatch] = onlyCallTo(
      "providers.cancelLogin",
    );
    expect(cancelParams).toEqual({
      providerId: "claude-code",
      profileId: "prof_new",
      holderId: HOLDER_ID,
    });
    expect(cancelDispatch).toEqual(CANCEL_DISPATCH);
    expect(fake.stopInterrupt).toHaveBeenCalledTimes(1);
  });

  it("swallows a failing cancel", async () => {
    scenario.awaitLogin = (dispatch) =>
      new Promise((_resolve, reject) => {
        const signal = dispatch.signal;
        if (signal === null) return;
        signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    dispatchMock.mockImplementation((method, _params, dispatch) => {
      switch (method) {
        case "providers.startLogin":
          return Promise.resolve(nextStartAnswer());
        case "providers.awaitLogin":
          return scenario.awaitLogin(dispatch);
        default:
          return Promise.reject(new Error(`host went away during ${method}`));
      }
    });
    const fake = makeIo(false);

    const run = runLogin(create("Work"), fake, makeCtx(false, false));
    await vi.waitFor(() => {
      expect(callsTo("providers.awaitLogin")).toHaveLength(1);
    });
    fake.interruptHandlers[0]?.();
    const result = await run;

    expect(result.exitCode).toBe(130);
  });
});

describe("a sign-in needs a person", () => {
  it("refuses --json before starting anything", async () => {
    const error = await failureOf(
      runLogin(create("Work"), makeIo(false), makeCtx(true, false)),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(callsTo("providers.startLogin")).toHaveLength(0);
  });

  it("refuses a non-interactive run before starting anything", async () => {
    const error = await failureOf(
      runLogin(create("Work"), makeIo(false), makeCtx(false, true)),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(callsTo("providers.startLogin")).toHaveLength(0);
  });

  it("refuses an unknown provider before reading host state", async () => {
    const error = await failureOf(
      buildProfileLoginCommand(
        { provider: "nope", target: create("Work") },
        makeIo(false).io,
      )(makeCtx(false, false)),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("browser", () => {
  it("opens the link when the provider does not open its own browser", async () => {
    const fake = makeIo(false);
    const ctx = makeCtx(false, false);

    await runLogin(create("Work"), fake, ctx);

    expect(fake.openUrl).toHaveBeenCalledTimes(1);
    expect(fake.openUrl).toHaveBeenCalledWith(DEFAULT_START.url);
    expect(ctx.output.humanRequired).toHaveBeenCalledWith(
      expect.stringContaining(DEFAULT_START.url ?? ""),
    );
  });

  it("does not open a second tab over a provider that opens its own", async () => {
    scenario.listState = listState({ ...NO_PROFILES, selfOpensBrowser: true });
    const fake = makeIo(false);

    await runLogin(create("Work"), fake, makeCtx(false, false));

    expect(fake.openUrl).not.toHaveBeenCalled();
  });

  it("does not open or print a link that is not http(s)", async () => {
    scenario.startAnswers = [
      startAnswer({ profileId: "prof_new", url: "file:///x" }),
    ];
    const fake = makeIo(false);
    const ctx = makeCtx(false, false);

    await runLogin(create("Work"), fake, ctx);

    expect(fake.openUrl).not.toHaveBeenCalled();
    const printed = vi.mocked(ctx.output.humanRequired).mock.calls[0]?.[0];
    expect(printed).toContain("Finish the sign-in in the browser window");
    expect(printed).not.toContain("file:///x");
  });

  it("prints the device code beside the link", async () => {
    scenario.startAnswers = [
      startAnswer({
        profileId: "prof_new",
        url: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      }),
    ];
    const ctx = makeCtx(false, false);

    await runLogin(create("Work"), makeIo(false), ctx);

    const printed = vi.mocked(ctx.output.humanRequired).mock.calls[0]?.[0];
    expect(printed).toContain("https://auth.openai.com/codex/device");
    expect(printed).toContain("ABCD-1234");
  });
});

describe("code paste", () => {
  it("submits a typed line, trimmed, and ignores a blank one", async () => {
    scenario.listState = listState({ ...NO_PROFILES, codePaste: true });
    const settled = deferred<ProvidersAwaitLoginResponse>();
    scenario.awaitLogin = () => settled.promise;
    const fake = makeIo(true);
    const ctx = makeCtx(false, false);

    const run = runLogin(create("Work"), fake, ctx);
    await vi.waitFor(() => {
      expect(fake.lineSinks).toHaveLength(1);
    });
    const sink = fake.lineSinks[0];
    if (sink === undefined) throw new Error("unreachable");
    sink("   ");
    sink("  code-123  ");
    await vi.waitFor(() => {
      expect(ctx.output.humanRequired).toHaveBeenCalledWith(
        "Code sent. Checking it...",
      );
    });

    expect(submitCalls()).toHaveLength(1);
    expect(submitCalls()[0]?.[1]).toEqual({
      providerId: "claude-code",
      profileId: "prof_new",
      code: "code-123",
    });
    expect(vi.mocked(ctx.output.humanRequired).mock.calls[0]?.[0]).toContain(
      "paste it here",
    );

    settled.resolve(awaitResult({ state: signedInState([NEW_PROFILE]) }));
    const result = await run;

    expect(result.exitCode).toBe(0);
    expect(fake.stopReading).toHaveBeenCalledTimes(1);
  });

  it("tells the user when the sign-in is no longer running", async () => {
    scenario.listState = listState({ ...NO_PROFILES, codePaste: true });
    rpcMock.mockImplementation((method) => {
      switch (method) {
        case "providers.list":
          return Promise.resolve({
            providers: [scenario.listState],
            native: null,
          });
        case "providers.submitLoginCode":
          return Promise.resolve({ outcome: "noActiveLogin" });
        default:
          return Promise.reject(new Error(`unexpected rpc ${method}`));
      }
    });
    const settled = deferred<ProvidersAwaitLoginResponse>();
    scenario.awaitLogin = () => settled.promise;
    const fake = makeIo(true);
    const ctx = makeCtx(false, false);

    const run = runLogin(create("Work"), fake, ctx);
    await vi.waitFor(() => {
      expect(fake.lineSinks).toHaveLength(1);
    });
    fake.lineSinks[0]?.("abc");
    await vi.waitFor(() => {
      expect(ctx.output.humanRequired).toHaveBeenCalledWith(
        "That sign-in is no longer running. Run the command again.",
      );
    });

    settled.resolve(awaitResult({ state: signedInState([NEW_PROFILE]) }));
    await run;
  });

  it("does not read stdin when the provider takes no pasted code", async () => {
    const fake = makeIo(true);
    const ctx = makeCtx(false, false);

    await runLogin(create("Work"), fake, ctx);

    expect(fake.readLines).not.toHaveBeenCalled();
    expect(submitCalls()).toHaveLength(0);
    expect(
      vi.mocked(ctx.output.humanRequired).mock.calls[0]?.[0],
    ).not.toContain("paste it here");
  });
});
