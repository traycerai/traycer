import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
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
  PROCESS_PROFILE_LOGIN_IO,
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
  readonly kind: "ambient" | "managed";
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
    kind: spec.kind,
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
    readonly retryAtMs: number | null;
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
  kind: "managed",
  label: "Work",
  email: "jane.doe@example.com",
  authStatus: "authenticated",
};

const WORK_PROFILE: ProfileSpec = {
  profileId: "prof_work",
  kind: "managed",
  label: "Work",
  email: "work@example.com",
  authStatus: "authenticated",
};

const AMBIENT_PROFILE: ProfileSpec = {
  profileId: "ambient",
  kind: "ambient",
  label: "Terminal login",
  email: "me@example.com",
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
  /** What the first `providers.list` read answers (the command's own pre-flight). */
  listState: ProviderCliState;
  /**
   * What every later `providers.list` read answers: the command's re-read when
   * the sign-in's echo lacks the profile it needs. Null keeps `listState`; an
   * Error makes that read fail.
   */
  laterListReads: ProviderCliState | Error | null;
  /** When set, `providers.startLogin` rejects with it instead of answering. */
  startFailure: Error | null;
  startAnswers: readonly ProvidersStartLoginResponseV13[];
  awaitLogin: (
    dispatch: HostRpcDispatch,
  ) => Promise<ProvidersAwaitLoginResponse>;
  /** When set, `providers.ensurePack` rejects with it instead of answering. */
  ensurePackFailure: Error | null;
  /** What `providers.touchLogin` (the paste-code keepalive) answers. */
  touchLogin: (dispatch: HostRpcDispatch) => Promise<{ extended: boolean }>;
  /** What `providers.submitLoginCode` answers; the pasted-code path rides the dispatch seam. */
  submitLoginCode: (
    dispatch: HostRpcDispatch,
  ) => Promise<{ outcome: "accepted" | "noActiveLogin" }>;
}

const NO_PROFILES: ListSpec = {
  profiles: [],
  codePaste: false,
  selfOpensBrowser: false,
};

let scenario: Scenario;
let startIndex = 0;
let listReads = 0;

function defaultScenario(): Scenario {
  return {
    listState: listState(NO_PROFILES),
    laterListReads: null,
    startFailure: null,
    startAnswers: [startAnswer({ profileId: "prof_new" })],
    awaitLogin: () =>
      Promise.resolve(awaitResult({ state: signedInState([NEW_PROFILE]) })),
    ensurePackFailure: null,
    touchLogin: () => Promise.resolve({ extended: true }),
    submitLoginCode: () => Promise.resolve({ outcome: "accepted" }),
  };
}

function nextStartAnswer(): ProvidersStartLoginResponseV13 {
  const index = Math.min(startIndex, scenario.startAnswers.length - 1);
  startIndex += 1;
  const answer = scenario.startAnswers[index];
  if (answer === undefined) throw new Error("scenario has no start answer");
  return answer;
}

function nextListAnswer(): Promise<{
  providers: ProviderCliState[];
  native: null;
}> {
  listReads += 1;
  const later = scenario.laterListReads;
  if (listReads === 1 || later === null) {
    return Promise.resolve({ providers: [scenario.listState], native: null });
  }
  if (later instanceof Error) return Promise.reject(later);
  return Promise.resolve({ providers: [later], native: null });
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

function listCalls(): DispatchCall[] {
  return callsTo("providers.list");
}

function submitCalls(): DispatchCall[] {
  return callsTo("providers.submitLoginCode");
}

const START_DISPATCH_FLOOR: HostRpcDispatch["requiredHostMethodVersion"] = {
  method: "providers.startLogin",
  version: { major: 1, minor: 4 },
};

const START_RESPONSE_TIMEOUT_MS = 30_000;

/**
 * The start ask carries the command's abort signal so Ctrl+C can cut it
 * short, so the signal is checked as an `AbortSignal`, not by value.
 */
function expectStartDispatch(dispatch: HostRpcDispatch): void {
  expect(dispatch.requiredHostMethodVersion).toEqual(START_DISPATCH_FLOOR);
  expect(dispatch.responseTimeoutMs).toBe(START_RESPONSE_TIMEOUT_MS);
  expect(dispatch.signal).toBeInstanceOf(AbortSignal);
}

function ensurePackCalls(): DispatchCall[] {
  return callsTo("providers.ensurePack");
}

function touchCalls(): DispatchCall[] {
  return callsTo("providers.touchLogin");
}

const LIST_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: null,
  requiredHostMethodVersion: null,
  signal: null,
  failFast: false,
};

const AWAIT_DISPATCH_FLOOR: HostRpcDispatch["requiredHostMethodVersion"] = {
  method: "providers.awaitLogin",
  version: { major: 2, minor: 1 },
};

/** The release after Ctrl+C is best effort and the user is waiting: one attempt, no redial. */
const CANCEL_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: null,
  requiredHostMethodVersion: {
    method: "providers.cancelLogin",
    version: { major: 1, minor: 2 },
  },
  signal: null,
  failFast: true,
};

/** How long a release may hold the command once the sign-in has ended. */
const RELEASE_WAIT_MS = 3_000;

/**
 * The release carries its own abort signal, so it can abandon a cancel the
 * host never answers: everything but the signal is the fixed floor, and the
 * signal is checked as an `AbortSignal`, not by value.
 */
function expectCancelDispatch(dispatch: HostRpcDispatch): void {
  expect(dispatch).toEqual({
    ...CANCEL_DISPATCH,
    signal: expect.any(AbortSignal),
  });
}

const RENAME_DISPATCH: HostRpcDispatch = {
  responseTimeoutMs: null,
  requiredHostMethodVersion: {
    method: "providers.setEnabled",
    version: { major: 2, minor: 1 },
  },
  signal: null,
  failFast: false,
};

// ---------------------------------------------------------------------------
// Fake process edges.
// ---------------------------------------------------------------------------

interface FakeIo {
  readonly io: ProfileLoginIo;
  readonly stdinIsTerminal: Mock<ProfileLoginIo["stdinIsTerminal"]>;
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
  const stdinIsTerminal = vi.fn<ProfileLoginIo["stdinIsTerminal"]>(() => true);
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
      stdinIsTerminal,
      openUrl,
      wait,
      onInterrupt,
      readLines,
    },
    stdinIsTerminal,
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
  listReads = 0;
  // Every host call rides the dispatch seam; the plain RPC helper is never used.
  rpcMock.mockImplementation((method) =>
    Promise.reject(new Error(`unexpected rpc ${method}`)),
  );
  dispatchMock.mockImplementation((method, _params, dispatch) => {
    switch (method) {
      case "providers.list":
        return nextListAnswer();
      case "providers.startLogin":
        return scenario.startFailure === null
          ? Promise.resolve(nextStartAnswer())
          : Promise.reject(scenario.startFailure);
      case "providers.awaitLogin":
        return scenario.awaitLogin(dispatch);
      case "providers.cancelLogin":
        return Promise.resolve({ cancelled: true });
      case "providers.submitLoginCode":
        return scenario.submitLoginCode(dispatch);
      case "providers.setEnabled":
        return Promise.resolve({ state: mutationState(signedInState([])) });
      case "providers.ensurePack":
        return scenario.ensurePackFailure === null
          ? Promise.resolve({ managedInstallState: null })
          : Promise.reject(scenario.ensurePackFailure);
      case "providers.touchLogin":
        return scenario.touchLogin(dispatch);
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
    expectStartDispatch(startDispatch);

    const [, awaitParams, awaitDispatch] = onlyCallTo("providers.awaitLogin");
    expect(awaitParams).toEqual({
      providerId: "claude-code",
      profileId: "prof_new",
    });
    expect(awaitDispatch.responseTimeoutMs).toBe(
      PROVIDERS_AWAIT_LOGIN_RESPONSE_BUDGET_MS,
    );
    expect(awaitDispatch.signal).toBeInstanceOf(AbortSignal);
    expect(awaitDispatch.requiredHostMethodVersion).toEqual(
      AWAIT_DISPATCH_FLOOR,
    );

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

  it("reads providers.list with no version floor", async () => {
    await runLogin(create("Work"), makeIo(false), makeCtx(false, false));

    const [, listParams, listDispatch] = onlyCallTo("providers.list");
    expect(listParams).toEqual({ native: null });
    expect(listDispatch).toEqual(LIST_DISPATCH);
    expect(rpcMock).not.toHaveBeenCalledWith("providers.list", {
      native: null,
    });
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

  it("reports an existing profile the echo leaves out, read from providers.list", async () => {
    // `prof_work` is a disabled profile: the host omits it from the echo, so
    // only the second providers.list read can name it.
    scenario.laterListReads = listState({
      ...NO_PROFILES,
      profiles: [WORK_PROFILE],
    });
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          state: signedInState([]),
          existingProfileId: "prof_work",
        }),
      );

    const result = await runLogin(
      create("Dup"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(listCalls()).toHaveLength(2);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "already-exists",
      profile: rowOf(WORK_PROFILE, "Work"),
    });
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

  it("reads a null state as not-completed without consulting providers.list", async () => {
    // The profile was already signed in before this attempt, so its listed
    // row says authenticated. A null state means this sign-in did not
    // complete, and that stale row must not be read as its success.
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
    expect(listCalls()).toHaveLength(1);
  });

  it("reads the row from providers.list when the await echo leaves it out and it is authenticated", async () => {
    scenario.listState = listState({
      ...NO_PROFILES,
      profiles: [{ ...WORK_PROFILE, authStatus: "unauthenticated" }],
    });
    scenario.laterListReads = listState({
      ...NO_PROFILES,
      profiles: [WORK_PROFILE],
    });
    scenario.startAnswers = [startAnswer({ profileId: "prof_work" })];
    // The host leaves a disabled profile out of the echo.
    scenario.awaitLogin = () =>
      Promise.resolve(awaitResult({ state: signedInState([]) }));

    const result = await runLogin(
      existing("prof_work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(listCalls()).toHaveLength(2);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "signed-in",
      profile: rowOf(WORK_PROFILE, "Work"),
      created: false,
    });
    expect(callsTo("providers.cancelLogin")).toHaveLength(0);
  });

  it("is not completed when the echo leaves the row out and providers.list shows it unauthenticated", async () => {
    scenario.listState = listState({
      ...NO_PROFILES,
      profiles: [WORK_PROFILE],
    });
    scenario.laterListReads = listState({
      ...NO_PROFILES,
      profiles: [{ ...WORK_PROFILE, authStatus: "unauthenticated" }],
    });
    scenario.startAnswers = [startAnswer({ profileId: "prof_work" })];
    scenario.awaitLogin = () =>
      Promise.resolve(awaitResult({ state: signedInState([]) }));

    const result = await runLogin(
      existing("prof_work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(listCalls()).toHaveLength(2);
    expect(result.exitCode).toBe(1);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "not-completed",
    });
  });

  it("is not completed, and does not throw, when the fallback providers.list read fails", async () => {
    scenario.listState = listState({
      ...NO_PROFILES,
      profiles: [WORK_PROFILE],
    });
    scenario.laterListReads = new Error("host went away");
    scenario.startAnswers = [startAnswer({ profileId: "prof_work" })];
    scenario.awaitLogin = () =>
      Promise.resolve(awaitResult({ state: signedInState([]) }));

    const result = await runLogin(
      existing("prof_work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(listCalls()).toHaveLength(2);
    expect(result.exitCode).toBe(1);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "not-completed",
    });
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

  it("escapes control characters in a refusal reason for the terminal and keeps data unchanged", async () => {
    scenario.listState = listState({
      ...NO_PROFILES,
      profiles: [WORK_PROFILE],
    });
    scenario.startAnswers = [startAnswer({ profileId: "prof_work" })];
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          refusal: {
            reason: "Blocked.\r\nforged line",
            actionUrl: null,
          },
        }),
      );

    const result = await runLogin(
      existing("prof_work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(result.exitCode).toBe(1);
    expect(result.human).toBe(
      "claude (Claude Code) refused the sign-in: Blocked.\\x0d\\x0aforged line",
    );
    expect(result.human).not.toMatch(/[\r\n]/);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "refused",
      refusal: { reason: "Blocked.\r\nforged line", actionUrl: null },
    });
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

  it("is signed in when the summary is unknown but the ambient row is authenticated", async () => {
    scenario.startAnswers = [startAnswer({ profileId: null })];
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          state: {
            auth: "unknown",
            authPending: false,
            profiles: [AMBIENT_PROFILE],
          },
        }),
      );

    const result = await runLogin(
      existing("ambient"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "signed-in",
      profile: null,
      created: false,
    });
  });

  it("is not signed in when the summary is authenticated but the ambient row is unauthenticated", async () => {
    scenario.startAnswers = [startAnswer({ profileId: null })];
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          state: {
            auth: "authenticated",
            authPending: false,
            profiles: [{ ...AMBIENT_PROFILE, authStatus: "unauthenticated" }],
          },
        }),
      );

    const result = await runLogin(
      existing("ambient"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(result.exitCode).toBe(1);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "not-completed",
    });
  });

  it("does not ask again when the ambient row has answered although the summary is still pending", async () => {
    scenario.startAnswers = [startAnswer({ profileId: null })];
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          state: {
            auth: "unknown",
            authPending: true,
            profiles: [AMBIENT_PROFILE],
          },
        }),
      );
    const fake = makeIo(false);

    const result = await runLogin(
      existing("ambient"),
      fake,
      makeCtx(false, false),
    );

    expect(callsTo("providers.awaitLogin")).toHaveLength(1);
    expect(fake.wait).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual(
      expect.objectContaining({ status: "signed-in" }),
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
    expect(fake.wait).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual(
      expect.objectContaining({ status: "signed-in" }),
    );
  });
});

describe("profile login (ambient) code rejection", () => {
  it("returns a rejected code at once, without asking again for a pending verdict", async () => {
    scenario.startAnswers = [startAnswer({ profileId: null })];
    scenario.awaitLogin = () =>
      Promise.resolve(
        awaitResult({
          state: { auth: "unknown", authPending: true, profiles: [] },
          codeRejected: true,
        }),
      );
    const fake = makeIo(false);

    const result = await runLogin(
      existing("ambient"),
      fake,
      makeCtx(false, false),
    );

    expect(callsTo("providers.awaitLogin")).toHaveLength(1);
    expect(fake.wait).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "code-rejected",
    });
  });
});

describe("start answers", () => {
  it("asks the same request again while the pack downloads and the child starts", async () => {
    scenario.startAnswers = [
      startAnswer({
        started: false,
        url: null,
        pending: "pack_preparing",
        pack: { percent: 40, reason: null, retryAtMs: null },
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
      expectStartDispatch(start[2]);
    }
    expect(fake.wait).toHaveBeenCalledTimes(1);
    expect(fake.wait).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));
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
        pack: { percent: null, reason: "network", retryAtMs: 1_000 },
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

  it("asks for a pack retry once and starts again when the setup failed earlier", async () => {
    scenario.startAnswers = [
      startAnswer({
        started: false,
        url: null,
        pack: { percent: null, reason: "network", retryAtMs: 1_000 },
      }),
      startAnswer({ profileId: "prof_new" }),
    ];

    const result = await runLogin(
      create("Work"),
      makeIo(false),
      makeCtx(false, false),
    );

    const [, ensureParams, ensureDispatch] = onlyCallTo("providers.ensurePack");
    expect(ensureParams).toEqual({ providerId: "claude-code" });
    // The retry rides the run's abort signal, so Ctrl+C cuts it short.
    expect(ensureDispatch.signal).toBeInstanceOf(AbortSignal);
    expect(ensureDispatch.failFast).toBe(false);
    expect(callsTo("providers.startLogin")).toHaveLength(2);
    expect(callsTo("providers.awaitLogin")).toHaveLength(1);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual(
      expect.objectContaining({ status: "signed-in" }),
    );
  });

  it("does not ask for a second pack retry when the setup fails again", async () => {
    scenario.startAnswers = [
      startAnswer({
        started: false,
        url: null,
        pack: { percent: null, reason: "network", retryAtMs: 1_000 },
      }),
    ];

    const result = await runLogin(
      create("Work"),
      makeIo(false),
      makeCtx(false, false),
    );

    const [, , ensureDispatch] = onlyCallTo("providers.ensurePack");
    expect(ensureDispatch.signal).toBeInstanceOf(AbortSignal);
    expect(callsTo("providers.startLogin")).toHaveLength(2);
    expect(callsTo("providers.awaitLogin")).toHaveLength(0);
    expect(result.exitCode).toBe(1);
    expect(result.data).toEqual(
      expect.objectContaining({ status: "not-started" }),
    );
    expect(result.human).toContain("did not install (network)");
    expect(result.human).toMatch(/Try again\.$/);
    expect(result.human).not.toContain("Settings");
  });

  async function runUnretryablePackFailure(
    reason: string,
  ): Promise<CommandResult> {
    scenario.startAnswers = [
      startAnswer({
        started: false,
        url: null,
        pack: { percent: null, reason, retryAtMs: null },
      }),
    ];

    const result = await runLogin(
      create("Work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(ensurePackCalls()).toHaveLength(0);
    expect(callsTo("providers.startLogin")).toHaveLength(1);
    expect(callsTo("providers.awaitLogin")).toHaveLength(0);
    expect(result.exitCode).toBe(1);
    return result;
  }

  it.each(["unrepairable", "local-storage-mismatch"])(
    "does not ask for a pack retry, and says running the command again will not fix it, when the setup failed with %s",
    async (reason) => {
      const message = `The provider's first-time setup did not install (${reason}), and running this command again will not fix it. Install the provider's CLI yourself and select it in Settings > Providers in the Traycer app.`;

      const result = await runUnretryablePackFailure(reason);

      expect(result.data).toEqual(
        expect.objectContaining({ status: "not-started", message }),
      );
      expect(result.human).toBe(message);
      expect(result.human).not.toMatch(/Try again\.$/);
    },
  );

  it("does not ask for a pack retry, and names the host restart, when the registry's signing keys could not be verified", async () => {
    const message =
      "The provider's first-time setup is unavailable: this host could not verify the provider registry's signing keys. The host re-checks periodically; 'traycer host restart' checks straight away.";

    const result = await runUnretryablePackFailure("trust-unavailable");

    expect(result.data).toEqual(
      expect.objectContaining({ status: "not-started", message }),
    );
    expect(result.human).toBe(message);
    expect(result.human).not.toContain("did not install");
    expect(result.human).not.toMatch(/Try again\.$/);
  });

  it("starts again even when the pack retry request itself fails", async () => {
    scenario.startAnswers = [
      startAnswer({
        started: false,
        url: null,
        pack: { percent: null, reason: "network", retryAtMs: 1_000 },
      }),
      startAnswer({ profileId: "prof_new" }),
    ];
    scenario.ensurePackFailure = new Error("host refused the retry");

    const result = await runLogin(
      create("Work"),
      makeIo(false),
      makeCtx(false, false),
    );

    expect(ensurePackCalls()).toHaveLength(1);
    expect(callsTo("providers.startLogin")).toHaveLength(2);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual(
      expect.objectContaining({ status: "signed-in" }),
    );
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

describe("the release's bounded wait", () => {
  it("aborts the signal it gave io.wait once a prompt cancel has ended the release", async () => {
    scenario.startAnswers = [startAnswer({ profileId: null })];
    const fake = makeIo(false);
    // The wait never ends on its own, so only the abort can free its timer.
    fake.wait.mockImplementation(() => new Promise<void>(() => undefined));

    const result = await runLogin(create("Work"), fake, makeCtx(false, false));

    expect(result.data).toEqual(
      expect.objectContaining({ status: "not-started" }),
    );
    expect(callsTo("providers.cancelLogin")).toHaveLength(1);
    expect(fake.wait).toHaveBeenCalledTimes(1);
    const [waitMs, waitSignal] = fake.wait.mock.calls[0] ?? [];
    expect(waitMs).toBe(RELEASE_WAIT_MS);
    expect(waitSignal).toBeInstanceOf(AbortSignal);
    expect(waitSignal?.aborted).toBe(true);
  });
});

describe("a call that fails partway", () => {
  it("releases its claim with the holder id and floor when the start itself rejects, then rethrows", async () => {
    const failure = new Error("start timed out");
    scenario.startFailure = failure;
    const fake = makeIo(false);

    await expect(
      runLogin(create("Work"), fake, makeCtx(false, false)),
    ).rejects.toBe(failure);

    expect(callsTo("providers.awaitLogin")).toHaveLength(0);
    const [, cancelParams, cancelDispatch] = onlyCallTo(
      "providers.cancelLogin",
    );
    expect(cancelParams).toEqual({
      providerId: "claude-code",
      profileId: null,
      holderId: HOLDER_ID,
    });
    expectCancelDispatch(cancelDispatch);
    expect(fake.stopInterrupt).toHaveBeenCalledTimes(1);
  });
});

describe("a create's profile id from a still-starting answer", () => {
  it("is released by name when the next start ask rejects", async () => {
    const failure = new Error("second start timed out");
    let starts = 0;
    dispatchMock.mockImplementation((method) => {
      switch (method) {
        case "providers.list":
          return nextListAnswer();
        case "providers.startLogin":
          starts += 1;
          return starts === 1
            ? Promise.resolve(
                startAnswer({
                  started: false,
                  url: null,
                  pending: "starting",
                  profileId: "prof_new",
                }),
              )
            : Promise.reject(failure);
        case "providers.cancelLogin":
          return Promise.resolve({ cancelled: true });
        default:
          return Promise.reject(new Error(`unexpected dispatch ${method}`));
      }
    });
    const fake = makeIo(false);

    await expect(
      runLogin(create("Work"), fake, makeCtx(false, false)),
    ).rejects.toBe(failure);

    expect(callsTo("providers.startLogin")).toHaveLength(2);
    expect(callsTo("providers.awaitLogin")).toHaveLength(0);
    const [, cancelParams, cancelDispatch] = onlyCallTo(
      "providers.cancelLogin",
    );
    expect(cancelParams).toEqual({
      providerId: "claude-code",
      profileId: "prof_new",
      holderId: HOLDER_ID,
    });
    expectCancelDispatch(cancelDispatch);
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
    expectCancelDispatch(cancelDispatch);
    // The release after Ctrl+C is fail-fast; every other dispatch is not.
    expect(cancelDispatch.failFast).toBe(true);
    expect(awaitDispatch.failFast).toBe(false);
    expect(fake.stopInterrupt).toHaveBeenCalled();
  });

  it("cancels, rather than throws, when Ctrl+C aborts a start that is still in flight", async () => {
    dispatchMock.mockImplementation((method, _params, dispatch) => {
      switch (method) {
        case "providers.list":
          return nextListAnswer();
        case "providers.startLogin":
          return new Promise((_resolve, reject) => {
            const signal = dispatch.signal;
            if (signal === null) return;
            signal.addEventListener("abort", () => {
              reject(new Error("the start was aborted"));
            });
          });
        case "providers.cancelLogin":
          return Promise.resolve({ cancelled: true });
        default:
          return Promise.reject(new Error(`unexpected dispatch ${method}`));
      }
    });
    const fake = makeIo(false);

    const run = runLogin(create("Work"), fake, makeCtx(false, false));
    await vi.waitFor(() => {
      expect(callsTo("providers.startLogin")).toHaveLength(1);
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
    expect(callsTo("providers.awaitLogin")).toHaveLength(0);
    const [, , startDispatch] = onlyCallTo("providers.startLogin");
    expect(startDispatch.signal?.aborted).toBe(true);
    const [, cancelParams, cancelDispatch] = onlyCallTo(
      "providers.cancelLogin",
    );
    expect(cancelParams).toEqual({
      providerId: "claude-code",
      profileId: null,
      holderId: HOLDER_ID,
    });
    expectCancelDispatch(cancelDispatch);
    expect(fake.stopInterrupt).toHaveBeenCalled();
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
        case "providers.list":
          return nextListAnswer();
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

  /**
   * The wait on the host rejects once Ctrl+C aborts it, and the release's
   * `providers.cancelLogin` answers only when the returned deferred does.
   */
  function holdCancelLogin(): Deferred<{ cancelled: boolean }> {
    const release = deferred<{ cancelled: boolean }>();
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
        case "providers.list":
          return nextListAnswer();
        case "providers.startLogin":
          return Promise.resolve(nextStartAnswer());
        case "providers.awaitLogin":
          return scenario.awaitLogin(dispatch);
        case "providers.cancelLogin":
          return release.promise;
        default:
          return Promise.reject(new Error(`unexpected dispatch ${method}`));
      }
    });
    return release;
  }

  it("stops listening for Ctrl+C at the first interrupt, while the release is still pending", async () => {
    const cancel = holdCancelLogin();
    const fake = makeIo(false);
    // The release is bounded by io.wait; keep that bound open so only the
    // cancel's own answer can end it.
    const bound = deferred<void>();
    fake.wait.mockImplementation(() => bound.promise);

    const run = runLogin(create("Work"), fake, makeCtx(false, false));
    await vi.waitFor(() => {
      expect(callsTo("providers.awaitLogin")).toHaveLength(1);
    });
    expect(fake.stopInterrupt).not.toHaveBeenCalled();
    const handler = fake.interruptHandlers[0];
    if (handler === undefined)
      throw new Error("no interrupt handler registered");
    handler();
    await vi.waitFor(() => {
      expect(callsTo("providers.cancelLogin")).toHaveLength(1);
    });

    // The cancel has been sent and nothing has answered it: the listener is
    // already gone, so a second Ctrl+C reaches the default handler.
    expect(fake.stopInterrupt).toHaveBeenCalled();

    cancel.resolve({ cancelled: true });
    const result = await run;
    expect(result.exitCode).toBe(130);
  });

  it("abandons a release the host never answers once the release wait is up", async () => {
    holdCancelLogin();
    const fake = makeIo(false);
    const bound = deferred<void>();
    fake.wait.mockImplementation(() => bound.promise);

    let settled = false;
    const run = runLogin(create("Work"), fake, makeCtx(false, false)).then(
      (value) => {
        settled = true;
        return value;
      },
    );
    await vi.waitFor(() => {
      expect(callsTo("providers.awaitLogin")).toHaveLength(1);
    });
    fake.interruptHandlers[0]?.();
    await vi.waitFor(() => {
      expect(callsTo("providers.cancelLogin")).toHaveLength(1);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    // Neither the cancel nor the wait has ended, so the command is still
    // holding on the release, with its cancel not yet abandoned.
    expect(fake.wait).toHaveBeenCalledWith(
      RELEASE_WAIT_MS,
      expect.any(AbortSignal),
    );
    expect(settled).toBe(false);
    const [, , cancelDispatch] = onlyCallTo("providers.cancelLogin");
    expectCancelDispatch(cancelDispatch);
    expect(cancelDispatch.signal?.aborted).toBe(false);

    bound.resolve();
    const result = await run;

    expect(result.exitCode).toBe(130);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "cancelled",
    });
    expect(cancelDispatch.signal?.aborted).toBe(true);
  });
});

describe("a sign-in needs a person", () => {
  it("refuses --json before starting anything", async () => {
    const error = await failureOf(
      runLogin(create("Work"), makeIo(false), makeCtx(true, false)),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(listCalls()).toHaveLength(0);
    expect(callsTo("providers.startLogin")).toHaveLength(0);
  });

  it("refuses a non-interactive run before starting anything", async () => {
    const error = await failureOf(
      runLogin(create("Work"), makeIo(false), makeCtx(false, true)),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(listCalls()).toHaveLength(0);
    expect(callsTo("providers.startLogin")).toHaveLength(0);
  });

  it("refuses a paste-code provider whose stdin is not a terminal before starting anything", async () => {
    scenario.listState = listState({ ...NO_PROFILES, codePaste: true });
    const fake = makeIo(false);
    fake.stdinIsTerminal.mockReturnValue(false);

    const error = await failureOf(
      runLogin(create("Work"), fake, makeCtx(false, false)),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(error.message).toContain("interactive terminal");
    // Unlike --json, this needs the provider's capability, so the host is
    // read first.
    expect(listCalls()).toHaveLength(1);
    expect(callsTo("providers.startLogin")).toHaveLength(0);
    expect(callsTo("providers.cancelLogin")).toHaveLength(0);
  });

  it("starts a provider that takes no pasted code even when stdin is not a terminal", async () => {
    // A device-code sign-in reads nothing from stdin, so a redirected stdin
    // is no reason to refuse it.
    const fake = makeIo(false);
    fake.stdinIsTerminal.mockReturnValue(false);

    const result = await runLogin(create("Work"), fake, makeCtx(false, false));
    expect(callsTo("providers.startLogin").length).toBeGreaterThan(0);
    expect(result.data).not.toMatchObject({ status: "cancelled" });
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
    expect(dispatchMock).not.toHaveBeenCalled();
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
    expect(rpcMock).not.toHaveBeenCalledWith(
      "providers.submitLoginCode",
      expect.anything(),
    );
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
    scenario.submitLoginCode = () =>
      Promise.resolve({ outcome: "noActiveLogin" });
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

  it("sends the code on a dispatch whose signal is aborted once the command has returned", async () => {
    scenario.listState = listState({ ...NO_PROFILES, codePaste: true });
    const settled = deferred<ProvidersAwaitLoginResponse>();
    scenario.awaitLogin = () => settled.promise;
    const fake = makeIo(true);
    const ctx = makeCtx(false, false);

    const run = runLogin(create("Work"), fake, ctx);
    await vi.waitFor(() => {
      expect(fake.lineSinks).toHaveLength(1);
    });
    fake.lineSinks[0]?.("code-123");
    await vi.waitFor(() => {
      expect(submitCalls()).toHaveLength(1);
    });
    const [, , submitDispatch] = onlyCallTo("providers.submitLoginCode");
    const submitSignal = submitDispatch.signal;
    expect(submitSignal).toBeInstanceOf(AbortSignal);
    expect(submitSignal?.aborted).toBe(false);
    expect(submitDispatch.failFast).toBe(false);
    expect(submitDispatch.responseTimeoutMs).toBeNull();
    expect(submitDispatch.requiredHostMethodVersion).toBeNull();

    settled.resolve(awaitResult({ state: signedInState([NEW_PROFILE]) }));
    await run;

    expect(fake.stopReading).toHaveBeenCalledTimes(1);
    expect(submitSignal?.aborted).toBe(true);
  });

  it("prints nothing when a submit resolves only after the sign-in has settled", async () => {
    scenario.listState = listState({ ...NO_PROFILES, codePaste: true });
    const late = deferred<{ outcome: "accepted" | "noActiveLogin" }>();
    scenario.submitLoginCode = () => late.promise;
    const settled = deferred<ProvidersAwaitLoginResponse>();
    scenario.awaitLogin = () => settled.promise;
    const fake = makeIo(true);
    const ctx = makeCtx(false, false);

    const run = runLogin(create("Work"), fake, ctx);
    await vi.waitFor(() => {
      expect(fake.lineSinks).toHaveLength(1);
    });
    fake.lineSinks[0]?.("code-123");
    await vi.waitFor(() => {
      expect(submitCalls()).toHaveLength(1);
    });

    settled.resolve(awaitResult({ state: signedInState([NEW_PROFILE]) }));
    const result = await run;
    expect(result.exitCode).toBe(0);
    const printedBefore = vi.mocked(ctx.output.humanRequired).mock.calls.length;

    late.resolve({ outcome: "accepted" });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const printed = vi
      .mocked(ctx.output.humanRequired)
      .mock.calls.map((call) => call[0]);
    expect(printed).toHaveLength(printedBefore);
    expect(printed.some((line) => line.includes("Code sent"))).toBe(false);
    expect(printed.some((line) => line.includes("Could not send"))).toBe(false);
  });

  it("prints nothing when a submit fails only after the sign-in has settled", async () => {
    scenario.listState = listState({ ...NO_PROFILES, codePaste: true });
    let rejectLate: (reason: Error) => void = () => undefined;
    scenario.submitLoginCode = () =>
      new Promise((_resolve, reject) => {
        rejectLate = reject;
      });
    const settled = deferred<ProvidersAwaitLoginResponse>();
    scenario.awaitLogin = () => settled.promise;
    const fake = makeIo(true);
    const ctx = makeCtx(false, false);

    const run = runLogin(create("Work"), fake, ctx);
    await vi.waitFor(() => {
      expect(fake.lineSinks).toHaveLength(1);
    });
    fake.lineSinks[0]?.("code-123");
    await vi.waitFor(() => {
      expect(submitCalls()).toHaveLength(1);
    });

    settled.resolve(awaitResult({ state: signedInState([NEW_PROFILE]) }));
    await run;
    const printedBefore = vi.mocked(ctx.output.humanRequired).mock.calls.length;

    rejectLate(new Error("aborted"));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const printed = vi
      .mocked(ctx.output.humanRequired)
      .mock.calls.map((call) => call[0]);
    expect(printed).toHaveLength(printedBefore);
    expect(printed.some((line) => line.includes("Could not send"))).toBe(false);
  });

  it("stops reading stdin as soon as the wait settles, before the outcome is worked out", async () => {
    scenario.listState = listState({
      ...NO_PROFILES,
      codePaste: true,
      profiles: [WORK_PROFILE],
    });
    scenario.startAnswers = [startAnswer({ profileId: "prof_work" })];
    // The echo leaves the profile out, so the outcome reads providers.list a
    // second time: the first call the command makes after the wait settles.
    scenario.laterListReads = listState({
      ...NO_PROFILES,
      codePaste: true,
      profiles: [WORK_PROFILE],
    });
    scenario.awaitLogin = () =>
      Promise.resolve(awaitResult({ state: signedInState([]) }));
    const fake = makeIo(true);

    const result = await runLogin(
      existing("prof_work"),
      fake,
      makeCtx(false, false),
    );

    expect(result.exitCode).toBe(0);
    expect(listCalls()).toHaveLength(2);
    expect(fake.stopReading).toHaveBeenCalledTimes(1);
    const stopOrder = fake.stopReading.mock.invocationCallOrder[0];
    const listIndexes = dispatchMock.mock.calls.flatMap((call, index) =>
      call[0] === "providers.list" ? [index] : [],
    );
    const fallbackOrder =
      dispatchMock.mock.invocationCallOrder[listIndexes[1] ?? -1];
    if (stopOrder === undefined || fallbackOrder === undefined) {
      throw new Error("unreachable: the stop and the fallback read both ran");
    }
    expect(stopOrder).toBeLessThan(fallbackOrder);
  });

  it("aborts a keepalive touch still in flight when the wait settles", async () => {
    // Only the interval is faked, so the waits below keep their real timers.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      scenario.listState = listState({ ...NO_PROFILES, codePaste: true });
      const settled = deferred<ProvidersAwaitLoginResponse>();
      scenario.awaitLogin = () => settled.promise;
      const touch = deferred<{ extended: boolean }>();
      scenario.touchLogin = () => touch.promise;
      const fake = makeIo(true);

      const run = runLogin(create("Work"), fake, makeCtx(false, false));
      await vi.waitFor(() => {
        expect(callsTo("providers.awaitLogin")).toHaveLength(1);
      });
      expect(touchCalls()).toHaveLength(0);
      vi.advanceTimersByTime(60_000);

      const [, touchParams, touchDispatch] = onlyCallTo("providers.touchLogin");
      expect(touchParams).toEqual({
        providerId: "claude-code",
        profileId: "prof_new",
      });
      const touchSignal = touchDispatch.signal;
      expect(touchSignal).toBeInstanceOf(AbortSignal);
      expect(touchSignal?.aborted).toBe(false);

      // The touch never answers; the sign-in settling must still end the command.
      settled.resolve(awaitResult({ state: signedInState([NEW_PROFILE]) }));
      const result = await run;

      expect(result.exitCode).toBe(0);
      expect(touchSignal?.aborted).toBe(true);
      vi.advanceTimersByTime(120_000);
      expect(touchCalls()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prints the paste hint only when a reader was returned", async () => {
    scenario.listState = listState({ ...NO_PROFILES, codePaste: true });
    const withoutTerminal = makeCtx(false, false);
    const withTerminal = makeCtx(false, false);

    const noReader = makeIo(false);
    await runLogin(create("Work"), noReader, withoutTerminal);
    startIndex = 0;
    const reader = makeIo(true);
    await runLogin(create("Work"), reader, withTerminal);

    expect(noReader.readLines).toHaveBeenCalledTimes(1);
    expect(reader.readLines).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(withoutTerminal.output.humanRequired).mock.calls[0]?.[0],
    ).not.toContain("paste it here");
    expect(
      vi.mocked(withTerminal.output.humanRequired).mock.calls[0]?.[0],
    ).toContain("paste it here");
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

describe("PROCESS_PROFILE_LOGIN_IO.wait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves once the time is up", async () => {
    const done = vi.fn();
    const waited = PROCESS_PROFILE_LOGIN_IO.wait(
      1_000,
      new AbortController().signal,
    ).then(done);

    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waited;

    expect(done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves at once and leaves no pending timer when the signal aborts", async () => {
    const abort = new AbortController();
    const done = vi.fn();
    const waited = PROCESS_PROFILE_LOGIN_IO.wait(60_000, abort.signal).then(
      done,
    );
    expect(vi.getTimerCount()).toBe(1);

    abort.abort();
    await waited;

    expect(done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves at once for a signal that is already aborted, without starting a timer", async () => {
    const abort = new AbortController();
    abort.abort();

    await PROCESS_PROFILE_LOGIN_IO.wait(60_000, abort.signal);

    expect(vi.getTimerCount()).toBe(0);
  });
});
