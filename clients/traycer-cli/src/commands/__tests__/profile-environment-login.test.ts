import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AMBIENT_PROFILE_ID_SENTINEL } from "@traycer/protocol/host/agent/shared";
import {
  HostMethodVersionUnsatisfiedError,
  HostRpcError,
  HostTransportFailureError,
  markMayHaveReachedHost,
  transportFailureBeforeSend,
} from "@traycer/protocol/host-transport/remote/rpc-types";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import {
  providersListResponseSchema,
  providersSetEnabledResponseSchema,
  providersAwaitLoginResponseSchema,
  providersStartLoginResponseSchemaV13,
  type ProviderCliState,
  type ProviderProfile,
  type ProvidersAwaitLoginResponse,
  type ProvidersStartLoginResponseV13,
} from "@traycer/protocol/host/provider-schemas";
import type {
  ProvidersLinkCompleteResponseV12,
  ProvidersLinkRequestV12,
  ProvidersLinkResponseV12,
} from "@traycer/protocol/host/environment-schemas";
import { environmentStatusResponseSchemaV12 } from "@traycer/protocol/host/environment-schemas";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { HostRpcRegistry } from "@traycer/protocol/host/registry";
import type { ResponseOfMethod } from "../../../../shared/host-transport/host-messenger";
import {
  ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE,
  ACCOUNT_MISMATCH_SIGN_IN_LINE,
  REPLACE_PROFILE_ACCOUNT_LINE,
  SIGNED_IN_RECEIVING_LINE,
} from "../../../../shared/providers/environment-profile-sign-in";
import {
  callHostRpcWithDispatch,
  readLocalHostMethodVersion,
} from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandContext, CommandResult } from "../../runner/runner";
import {
  buildProfileLoginCommand,
  type ProfileLoginIo,
  type ProfileLoginTarget,
} from "../profile-login";
import { buildProfileListCommand } from "../profile-list";

const mocks = vi.hoisted(() => ({
  callHostRpcWithDispatch: vi.fn(),
  readLocalHostMethodVersion: vi.fn(),
}));

vi.mock("../../internal/host-rpc", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../internal/host-rpc")>();
  return {
    ...actual,
    callHostRpcWithDispatch: mocks.callHostRpcWithDispatch,
    readLocalHostMethodVersion: mocks.readLocalHostMethodVersion,
  };
});

const dispatchMock = vi.mocked(callHostRpcWithDispatch);
const methodVersionMock = vi.mocked(readLocalHostMethodVersion);
type LinkCancelResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.linkCancel"
>;

const HOST_ID = "host-profile-environment-login";
const ENVIRONMENT_ID = "environment-profile-login";
const ENVIRONMENT_PROFILE_ID = "environment-profile-alias";
const MANAGED_PROFILE_ID = "managed-profile-local";
const OLD_PROFILE_ID = "managed-profile-old-admitted";
const CODE = "ONE-TIME-CODE";
const V12 = { major: 1, minor: 2 } as const;
const MAX_FAKE_LIST_READS = 12;
const MAX_FAKE_WAITS = 12;
const SIGN_IN_URL_PROMPT: ProvidersLinkResponseV12["prompt"] = {
  kind: "sign_in_url",
  url: "https://auth.example.test/sign-in",
  codePrompt: "One-time code",
};

const ENVIRONMENT_BINDING: ResponseOfMethod<
  HostRpcRegistry,
  "environment.host.read"
> = {
  hostId: HOST_ID,
  environment: {
    environmentId: ENVIRONMENT_ID,
    ownerKind: "user",
    ownerId: "environment-owner",
    roomId: "environment-room",
    label: "Personal",
  },
  explicit: true,
  enrolledByUserId: null,
  canUnbind: false,
  sharingGeneration: null,
};

const ENVIRONMENT_STATUS = environmentStatusResponseSchemaV12.parse({
  principal: { kind: "personal" },
  reachability: "connected",
  bindingGeneration: 1,
  desiredRevision: 1,
  receivedRevision: 1,
  appliedRevision: 1,
  receiptAgeMs: 0,
  items: [],
  pendingUploads: [],
  setup: null,
  remoteAccess: "off",
});
const NO_ENVIRONMENT_STATUS = { ...ENVIRONMENT_STATUS, principal: null };
const ALL_LOCAL_PLANES = {
  records: "local",
  broker: "local",
  room: "local",
} as const;

function statusWith(
  principal: (typeof ENVIRONMENT_STATUS)["principal"],
  planes: (typeof ENVIRONMENT_STATUS)["planes"],
): typeof ENVIRONMENT_STATUS {
  return environmentStatusResponseSchemaV12.parse({
    ...ENVIRONMENT_STATUS,
    principal,
    planes,
  });
}

function profile(
  profileId: string,
  kind: ProviderProfile["kind"],
  label: string,
  environmentProfileId: string | null,
): ProviderProfile {
  return {
    profileId,
    enabled: true,
    kind,
    authType: "oauth",
    label,
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
    environmentProfileId,
    ...(kind === "managed"
      ? { presence: { kind: "admitted" as const, bindingVersion: 1 } }
      : {}),
  };
}

function profileWithIdentityEmail(
  profileId: string,
  label: string,
  email: string | null,
  environmentProfileId: string | null,
): ProviderProfile {
  const row = profile(profileId, "managed", label, environmentProfileId);
  return {
    ...row,
    identity: email === null ? null : { email, tier: null, accountUuid: null },
  };
}

function providerState(
  providerId: ProviderCliState["providerId"],
  profiles: readonly ProviderProfile[],
): ProviderCliState {
  const response = providersListResponseSchema.parse({
    providers: [
      {
        providerId,
        enabled: true,
        disabledBy: null,
        selected: { kind: "bundled" },
        candidates: [],
        auth: {
          status: "authenticated",
          badgeText: null,
          label: null,
          detail: null,
        },
        authPending: false,
        checkedAt: null,
        apiKey: { supported: false, configured: false, source: null },
        terminalAgentArgs: "",
        envOverrides: [],
        loginCapability: {
          oauthArgs: [],
          token: null,
          codePaste: null,
          terminalLogin: null,
          remoteSafe: null,
          selfOpensBrowser: null,
        },
        nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
        profiles: [...profiles],
      },
    ],
    native: null,
  });
  const state = response.providers.find((row) => row.providerId === providerId);
  if (state === undefined) throw new Error("Expected provider inventory row");
  return state;
}

function completeAnswer(
  state: ProvidersLinkCompleteResponseV12["state"],
  profileId: string | null,
  code: string | null,
): ProvidersLinkCompleteResponseV12 {
  return {
    state,
    code,
    account: null,
    expectedAccount: null,
    environmentProfileId: ENVIRONMENT_PROFILE_ID,
    profileId,
  };
}

function linkAnswer(
  prompt: ProvidersLinkResponseV12["prompt"],
): ProvidersLinkResponseV12 {
  return {
    linkId: "link-attempt",
    environmentProfileId: ENVIRONMENT_PROFILE_ID,
    prompt,
  };
}

function startAnswer(): ProvidersStartLoginResponseV13 {
  return providersStartLoginResponseSchemaV13.parse({
    started: true,
    url: null,
    profileId: null,
    userCode: null,
    failure: null,
    pending: null,
    pack: null,
  });
}

function awaitAnswer(state: ProviderCliState): ProvidersAwaitLoginResponse {
  return providersAwaitLoginResponseSchema.parse({
    state,
    existingProfileId: null,
    codeRejected: false,
    refusal: null,
  });
}

interface HarnessOptions {
  readonly providerId: ProviderCliState["providerId"];
  readonly profiles: readonly ProviderProfile[];
  readonly credentialsManagedInAccount?: boolean;
  readonly laterProfiles?: (
    listCall: number,
  ) => readonly ProviderProfile[] | Promise<readonly ProviderProfile[]>;
  readonly methodVersion?: (method: string) => SchemaVersion | null;
  readonly onLinkRequest?: () => void;
  readonly onLinkCancel?: () => void;
  readonly link?: ProvidersLinkResponseV12 | Promise<ProvidersLinkResponseV12>;
  readonly linkCancel?: Promise<LinkCancelResponse>;
  readonly setEnabledFailure?: Error;
  readonly complete?: (
    callNumber: number,
  ) =>
    | ProvidersLinkCompleteResponseV12
    | Promise<ProvidersLinkCompleteResponseV12>;
  readonly start?: ProvidersStartLoginResponseV13;
  readonly await?: ProvidersAwaitLoginResponse;
  readonly environmentStatus?: (
    callNumber: number,
  ) =>
    | ResponseOfMethod<HostRpcRegistry, "environment.status">
    | Promise<ResponseOfMethod<HostRpcRegistry, "environment.status">>;
  readonly environmentHostRead?: () =>
    | ResponseOfMethod<HostRpcRegistry, "environment.host.read">
    | Promise<ResponseOfMethod<HostRpcRegistry, "environment.host.read">>;
  readonly failingProviderListCalls?: readonly number[];
}

function makeHost(options: HarnessOptions): void {
  let completeCalls = 0;
  let listCalls = 0;
  let statusCalls = 0;
  const initialState = providerState(options.providerId, options.profiles);
  methodVersionMock.mockImplementation(async (method) =>
    options.methodVersion === undefined
      ? method === "providers.linkCancel"
        ? { major: 1, minor: 0 }
        : V12
      : options.methodVersion(method),
  );
  dispatchMock.mockImplementation((method) => {
    switch (method) {
      case "providers.list": {
        listCalls += 1;
        if (listCalls > MAX_FAKE_LIST_READS) {
          return Promise.reject(
            new Error(
              `Fake provider inventory exceeded its ${MAX_FAKE_LIST_READS}-read budget.`,
            ),
          );
        }
        if (options.failingProviderListCalls?.includes(listCalls) === true) {
          return Promise.reject(
            new Error("Fake provider inventory read failed."),
          );
        }
        const profiles =
          listCalls === 1
            ? options.profiles
            : (options.laterProfiles?.(listCalls) ?? options.profiles);
        return Promise.resolve(profiles).then((resolvedProfiles) => ({
          providers: [providerState(options.providerId, resolvedProfiles)],
          native: null,
          ...(options.credentialsManagedInAccount === undefined
            ? {}
            : {
                credentialsManagedInAccount:
                  options.credentialsManagedInAccount,
              }),
        }));
      }
      case "environment.host.read":
        return Promise.resolve(
          options.environmentHostRead?.() ?? ENVIRONMENT_BINDING,
        );
      case "environment.status": {
        statusCalls += 1;
        return Promise.resolve(
          options.environmentStatus?.(statusCalls) ?? ENVIRONMENT_STATUS,
        );
      }
      case "providers.link":
        options.onLinkRequest?.();
        return Promise.resolve(options.link ?? linkAnswer(SIGN_IN_URL_PROMPT));
      case "providers.linkComplete":
        completeCalls += 1;
        return Promise.resolve(
          options.complete?.(completeCalls) ??
            completeAnswer("linked", null, null),
        );
      case "providers.linkCancel":
        options.onLinkCancel?.();
        return options.linkCancel ?? Promise.resolve({});
      case "providers.startLogin":
        return Promise.resolve(options.start ?? startAnswer());
      case "providers.awaitLogin":
        return Promise.resolve(options.await ?? awaitAnswer(initialState));
      case "providers.cancelLogin":
        return Promise.resolve({ cancelled: true });
      case "providers.setEnabled":
        return options.setEnabledFailure === undefined
          ? Promise.resolve(
              providersSetEnabledResponseSchema.parse({ state: initialState }),
            )
          : Promise.reject(options.setEnabledFailure);
      default:
        return Promise.reject(new Error(`Unexpected RPC ${method}`));
    }
  });
}

interface FakeIo {
  readonly io: ProfileLoginIo;
  readonly interrupt: () => void;
  readonly isInterruptListening: () => boolean;
  readonly openedUrls: string[];
  readonly sendLine: (line: string) => void;
  readonly isLineReaderOpen: () => boolean;
}

function makeIo(options: {
  readonly terminal: boolean;
  readonly lines?: readonly string[];
  readonly holdEmptyReader?: boolean;
  readonly onHeldReaderOpen?: () => void;
  readonly onOpenUrl?: (url: string) => void;
  readonly interruptOnWait?: boolean;
  readonly onWait?: (waitCalls: number) => void;
  readonly wait?: (waitCalls: number) => Promise<void>;
}): FakeIo {
  let interruptHandler: (() => void) | null = null;
  let interruptListening = false;
  const lines = [...(options.lines ?? [])];
  let interruptedDuringWait = false;
  let waitCalls = 0;
  let lineSink: ((line: string) => void) | null = null;
  const openedUrls: string[] = [];
  const io: ProfileLoginIo = {
    newHolderId: () => "holder-environment-login",
    stdinIsTerminal: () => options.terminal,
    openUrl: (url) => {
      openedUrls.push(url);
      options.onOpenUrl?.(url);
    },
    wait: (_ms, _signal) => {
      waitCalls += 1;
      if (waitCalls > MAX_FAKE_WAITS) {
        return Promise.reject(
          new Error(
            `Fake sign-in exceeded its ${MAX_FAKE_WAITS}-wait budget without reaching a terminal state.`,
          ),
        );
      }
      options.onWait?.(waitCalls);
      if (options.interruptOnWait === true && !interruptedDuringWait) {
        interruptedDuringWait = true;
        if (interruptListening) interruptHandler?.();
      }
      return options.wait?.(waitCalls) ?? Promise.resolve();
    },
    onInterrupt: (handler) => {
      interruptHandler = handler;
      interruptListening = true;
      return () => {
        if (interruptHandler === handler) interruptListening = false;
      };
    },
    readLines: (onLine) => {
      const line = lines.shift();
      if (line !== undefined) {
        onLine(line);
        return () => undefined;
      }
      if (options.holdEmptyReader !== true) return null;
      lineSink = onLine;
      options.onHeldReaderOpen?.();
      return () => {
        if (lineSink === onLine) lineSink = null;
      };
    },
  };
  return {
    io,
    openedUrls,
    sendLine: (line) => {
      if (lineSink === null)
        throw new Error("No open fake line reader to receive input.");
      lineSink(line);
    },
    isLineReaderOpen: () => lineSink !== null,
    interrupt: () => {
      if (interruptListening) interruptHandler?.();
    },
    isInterruptListening: () => interruptListening,
  };
}

function makeContext(): CommandContext {
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

function callsTo(method: string) {
  return dispatchMock.mock.calls.filter((call) => call[0] === method);
}

function onlyCallTo(method: string) {
  const call = callsTo(method)[0];
  if (call === undefined) throw new Error(`Expected one ${method} call`);
  expect(callsTo(method)).toHaveLength(1);
  return call;
}

async function runLogin(
  provider: string,
  target: ProfileLoginTarget,
  io: ProfileLoginIo,
): Promise<{
  readonly context: CommandContext;
  readonly result: CommandResult;
}> {
  const context = makeContext();
  const result = await buildProfileLoginCommand(
    { provider, target },
    io,
  )(context);
  return { context, result };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("environment profile sign-in through the CLI", () => {
  it("keeps a create local when status has no principal despite a Personal binding", async () => {
    makeHost({
      providerId: "claude-code",
      profiles: [],
      environmentStatus: () => NO_ENVIRONMENT_STATUS,
    });
    const fake = makeIo({ terminal: true });

    await runLogin(
      "claude",
      { kind: "create", label: "Work profile" },
      fake.io,
    );

    expect(onlyCallTo("providers.startLogin")[1]).toMatchObject({
      providerId: "claude-code",
      profileId: null,
      createProfile: {
        label: "Work profile",
        shareSkillsAndPlugins: false,
      },
    });
    expect(callsTo("providers.link")).toEqual([]);
    expect(callsTo("environment.host.read")).toEqual([]);
  });

  const OWN_SETTINGS_PLANES = [
    ["every plane its own", ALL_LOCAL_PLANES],
    [
      "a plane that stopped sharing",
      { records: "moved", broker: "stopped", room: "moved" },
    ],
  ] as const;

  it.each(OWN_SETTINGS_PLANES)(
    "adds a profile on a computer that runs its own settings, with %s",
    async (_case, planes) => {
      makeHost({
        providerId: "claude-code",
        profiles: [],
        environmentStatus: () => statusWith({ kind: "personal" }, planes),
      });

      const { result } = await runLogin(
        "claude",
        { kind: "create", label: "Work profile" },
        makeIo({ terminal: true }).io,
      );

      expect(onlyCallTo("providers.startLogin")[1]).toMatchObject({
        providerId: "claude-code",
        profileId: null,
        createProfile: {
          label: "Work profile",
          shareSkillsAndPlugins: false,
        },
      });
      expect(callsTo("providers.link")).toEqual([]);
      expect(callsTo("environment.host.read")).toEqual([]);
      expect(result.human).not.toBe(SIGNED_IN_RECEIVING_LINE);
    },
  );

  it.each(OWN_SETTINGS_PLANES)(
    "signs an existing profile in on a computer that runs its own settings, with %s",
    async (_case, planes) => {
      const selected = profile(
        MANAGED_PROFILE_ID,
        "managed",
        "Selected profile",
        ENVIRONMENT_PROFILE_ID,
      );
      makeHost({
        providerId: "claude-code",
        profiles: [selected],
        await: awaitAnswer(providerState("claude-code", [selected])),
        environmentStatus: () => statusWith({ kind: "personal" }, planes),
      });

      const { result } = await runLogin(
        "claude",
        { kind: "existing", profile: MANAGED_PROFILE_ID },
        makeIo({ terminal: true }).io,
      );

      expect(onlyCallTo("providers.startLogin")[1]).toMatchObject({
        providerId: "claude-code",
        profileId: MANAGED_PROFILE_ID,
        createProfile: null,
      });
      expect(callsTo("providers.link")).toEqual([]);
      expect(callsTo("environment.host.read")).toEqual([]);
      expect(result.data).toMatchObject({
        status: "signed-in",
        created: false,
        profile: { profileId: MANAGED_PROFILE_ID },
      });
      expect(result.human).not.toBe(SIGNED_IN_RECEIVING_LINE);
    },
  );

  it.each([
    [
      "a team-owned computer whose planes never moved",
      { kind: "team", teamName: "Acme" },
      ALL_LOCAL_PLANES,
    ],
    [
      "a bound Personal computer with no plane of its own",
      { kind: "personal" },
      { records: "moved", broker: "shared_unrecorded", room: "moved" },
    ],
  ] as const)(
    "signs in through the environment on %s",
    async (_case, principal, planes) => {
      const admitted = profile(
        MANAGED_PROFILE_ID,
        "managed",
        "Work profile",
        ENVIRONMENT_PROFILE_ID,
      );
      makeHost({
        providerId: "claude-code",
        profiles: [],
        laterProfiles: () => [admitted],
        environmentStatus: () => statusWith(principal, planes),
      });

      const { result } = await runLogin(
        "claude",
        { kind: "create", label: "Work profile" },
        makeIo({ terminal: true, lines: [CODE] }).io,
      );

      expect(onlyCallTo("providers.link")[1]).toMatchObject({
        providerId: "claude-code",
        profileId: null,
        environmentId: ENVIRONMENT_ID,
      });
      expect(callsTo("providers.startLogin")).toEqual([]);
      expect(result.data).toMatchObject({ status: "signed-in", created: true });
    },
  );

  it("keeps profile inventory readable when credentials are managed in the account", async () => {
    const selected = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Selected profile",
      ENVIRONMENT_PROFILE_ID,
    );
    makeHost({
      providerId: "codex",
      profiles: [selected],
      credentialsManagedInAccount: true,
    });

    const result = await buildProfileListCommand({ provider: "codex" })(
      makeContext(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      providers: [
        {
          providerId: "codex",
          profiles: [{ label: "Selected profile" }],
        },
      ],
    });
    expect(callsTo("providers.list")).toHaveLength(1);
  });

  it.each([
    ["environment-backed", "claude", "claude-code"],
    ["native", "cursor", "cursor"],
  ] as const)(
    "refuses %s sign-in when credentials are managed in the account before sign-in side effects",
    async (_route, provider, providerId) => {
      makeHost({
        providerId,
        profiles: [],
        credentialsManagedInAccount: true,
      });
      let lineReaderStarts = 0;
      const fake = makeIo({
        terminal: true,
        holdEmptyReader: true,
        onHeldReaderOpen: () => {
          lineReaderStarts += 1;
        },
      });

      await expect(
        runLogin(provider, { kind: "create", label: "Work profile" }, fake.io),
      ).rejects.toMatchObject({ code: CLI_ERROR_CODES.FORBIDDEN });

      expect(callsTo("providers.list")).toHaveLength(1);
      expect(methodVersionMock).not.toHaveBeenCalled();
      expect(callsTo("environment.status")).toEqual([]);
      expect(callsTo("environment.host.read")).toEqual([]);
      expect(callsTo("providers.startLogin")).toEqual([]);
      expect(callsTo("providers.link")).toEqual([]);
      expect(fake.openedUrls).toEqual([]);
      expect(lineReaderStarts).toBe(0);
      expect(fake.isLineReaderOpen()).toBe(false);
    },
  );

  it("creates a Claude profile with its label, sharing disabled, and the pasted code", async () => {
    const admitted = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Work profile",
      ENVIRONMENT_PROFILE_ID,
    );
    makeHost({
      providerId: "claude-code",
      profiles: [],
      credentialsManagedInAccount: false,
      laterProfiles: () => [admitted],
      link: linkAnswer(SIGN_IN_URL_PROMPT),
      complete: () => completeAnswer("linked", null, null),
      methodVersion: (method) =>
        method === "providers.link" || method === "providers.linkComplete"
          ? V12
          : { major: 1, minor: 0 },
    });
    const fake = makeIo({ terminal: true, lines: [CODE] });

    const { result } = await runLogin(
      "claude",
      { kind: "create", label: "Work profile" },
      fake.io,
    );

    const linkCall = onlyCallTo("providers.link");
    expect(linkCall[1]).toEqual({
      providerId: "claude-code",
      profileId: null,
      environmentId: ENVIRONMENT_ID,
      createProfile: {
        label: "Work profile",
        shareSkillsAndPlugins: false,
      },
      replaceAccount: false,
    } satisfies ProvidersLinkRequestV12);
    expect(linkCall[2].requiredHostMethodVersion).toEqual({
      method: "providers.link",
      version: V12,
    });
    expect(onlyCallTo("providers.linkComplete")[1]).toEqual({
      linkId: "link-attempt",
      environmentId: ENVIRONMENT_ID,
      code: CODE,
    });
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      providerId: "claude-code",
      status: "signed-in",
      created: true,
      profile: { profileId: MANAGED_PROFILE_ID, label: "Work profile" },
    });
    expect(callsTo("providers.setEnabled")).toEqual([]);
  });

  it("names a newly admitted environment profile from the email prefix", async () => {
    const admitted = profileWithIdentityEmail(
      MANAGED_PROFILE_ID,
      "New profile",
      "profile.name@example.test",
      ENVIRONMENT_PROFILE_ID,
    );
    makeHost({
      providerId: "codex",
      profiles: [],
      laterProfiles: () => [admitted],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: () => completeAnswer("linked", MANAGED_PROFILE_ID, null),
    });

    const { result } = await runLogin(
      "codex",
      { kind: "create", label: null },
      makeIo({ terminal: false }).io,
    );

    expect(onlyCallTo("providers.setEnabled")[1]).toEqual({
      providerId: "codex",
      enabled: true,
      profileAction: {
        type: "rename",
        profileId: MANAGED_PROFILE_ID,
        label: "profile.name",
      },
    });
    expect(
      onlyCallTo("providers.setEnabled")[2].requiredHostMethodVersion,
    ).toEqual({
      method: "providers.setEnabled",
      version: { major: 2, minor: 1 },
    });
    expect(result.data).toMatchObject({
      providerId: "codex",
      status: "signed-in",
      profile: { profileId: MANAGED_PROFILE_ID, label: "profile.name" },
    });
  });

  it.each([
    ["no email", null, "New profile"],
    [
      "already uses the email prefix",
      "profile.name@example.test",
      "profile.name",
    ],
  ] as const)(
    "does not rename a new environment profile when it has %s",
    async (_case, email, label) => {
      const admitted = profileWithIdentityEmail(
        MANAGED_PROFILE_ID,
        label,
        email,
        ENVIRONMENT_PROFILE_ID,
      );
      makeHost({
        providerId: "codex",
        profiles: [],
        laterProfiles: () => [admitted],
        link: linkAnswer({ kind: "local_handoff" }),
        complete: () => completeAnswer("linked", MANAGED_PROFILE_ID, null),
      });

      const { result } = await runLogin(
        "codex",
        { kind: "create", label: null },
        makeIo({ terminal: false }).io,
      );

      expect(callsTo("providers.setEnabled")).toEqual([]);
      expect(result.data).toMatchObject({
        providerId: "codex",
        status: "signed-in",
        profile: { profileId: MANAGED_PROFILE_ID, label },
      });
    },
  );

  it.each([
    "response alias differs",
    "profile was already present",
    "start alias is unknown",
  ] as const)(
    "does not rename an environment profile without new-profile ownership proof: %s",
    async (scenario) => {
      const startAlias =
        scenario === "start alias is unknown" ? null : ENVIRONMENT_PROFILE_ID;
      const responseAlias =
        scenario === "response alias differs"
          ? "environment-profile-after-link"
          : ENVIRONMENT_PROFILE_ID;
      const initialProfiles =
        scenario === "profile was already present"
          ? [
              profileWithIdentityEmail(
                MANAGED_PROFILE_ID,
                "Previous label",
                null,
                ENVIRONMENT_PROFILE_ID,
              ),
            ]
          : [];
      const admitted = profileWithIdentityEmail(
        MANAGED_PROFILE_ID,
        "New profile",
        "profile.name@example.test",
        responseAlias,
      );
      makeHost({
        providerId: "codex",
        profiles: initialProfiles,
        laterProfiles: () => [admitted],
        link: {
          ...linkAnswer({ kind: "local_handoff" }),
          environmentProfileId: startAlias,
        },
        complete: () => ({
          ...completeAnswer("linked", MANAGED_PROFILE_ID, null),
          environmentProfileId: responseAlias,
        }),
      });

      const { result } = await runLogin(
        "codex",
        { kind: "create", label: null },
        makeIo({ terminal: false }).io,
      );

      expect(callsTo("providers.setEnabled")).toEqual([]);
      expect(result.data).toMatchObject({
        providerId: "codex",
        status: "signed-in",
        profile: { profileId: MANAGED_PROFILE_ID, label: "New profile" },
      });
    },
  );

  it("keeps environment sign-in successful when best-effort naming fails", async () => {
    const admitted = profileWithIdentityEmail(
      MANAGED_PROFILE_ID,
      "New profile",
      "profile.name@example.test",
      ENVIRONMENT_PROFILE_ID,
    );
    makeHost({
      providerId: "codex",
      profiles: [],
      laterProfiles: () => [admitted],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: () => completeAnswer("linked", MANAGED_PROFILE_ID, null),
      setEnabledFailure: new Error("Profile rename failed."),
    });

    const { result } = await runLogin(
      "codex",
      { kind: "create", label: null },
      makeIo({ terminal: false }).io,
    );

    expect(callsTo("providers.setEnabled")).toHaveLength(1);
    expect(result.data).toMatchObject({
      providerId: "codex",
      status: "signed-in",
      profile: { profileId: MANAGED_PROFILE_ID, label: "New profile" },
    });
    expect(result.exitCode).toBe(0);
  });

  it.each([
    [
      "sign-in URL prompt",
      {
        kind: "sign_in_url",
        url: "https://[private-invalid-url",
        codePrompt: "One-time code",
      },
      "PRIVATE-PASTE-CODE",
    ],
    [
      "device-code prompt",
      {
        kind: "device_code",
        verificationUrl: "file:///private-auth-secret",
        userCode: "PRIVATE-DEVICE-CODE",
        expiresAt: 1,
      },
      "PRIVATE-DEVICE-CODE",
    ],
  ] as const)(
    "does not expose or open an invalid URL from a %s",
    async (_kind, prompt, secret) => {
      const secretUrl =
        prompt.kind === "sign_in_url" ? prompt.url : prompt.verificationUrl;
      makeHost({
        providerId: "codex",
        profiles: [],
        link: linkAnswer(prompt),
      });
      const fake = makeIo({ terminal: true });

      const { context, result } = await runLogin(
        "codex",
        { kind: "create", label: "Work profile" },
        fake.io,
      );

      expect(result.data).toEqual({
        providerId: "codex",
        status: "not-started",
        message: "The sign-in page could not be opened.",
      });
      expect(result.human).toBe("The sign-in page could not be opened.");
      expect(fake.openedUrls).toEqual([]);
      expect(context.output.humanRequired).not.toHaveBeenCalledWith(
        expect.stringContaining(secret),
      );
      expect(context.output.humanRequired).not.toHaveBeenCalledWith(
        expect.stringContaining(secretUrl),
      );
      expect(result.human).not.toContain(secret);
      expect(result.human).not.toContain(secretUrl);
      expect(context.output.emitError).not.toHaveBeenCalled();
      expect(callsTo("providers.linkComplete")).toEqual([]);
      expect(callsTo("providers.linkCancel")).toHaveLength(1);
    },
  );

  it("keeps an installing profile pending until its admitted profile is authenticated", async () => {
    const admitted = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Claude local profile",
      ENVIRONMENT_PROFILE_ID,
    );
    const unauthenticated: ProviderProfile = {
      ...admitted,
      auth: { ...admitted.auth, status: "unauthenticated" },
    };
    makeHost({
      providerId: "codex",
      profiles: [],
      laterProfiles: () => [unauthenticated],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: (callNumber) =>
        callNumber === 1
          ? completeAnswer("installing", null, null)
          : completeAnswer("expired", null, null),
    });

    const { result } = await runLogin(
      "codex",
      { kind: "create", label: "Work profile" },
      makeIo({ terminal: false }).io,
    );

    expect(result.data).toEqual({
      providerId: "codex",
      status: "signed-in-pending",
    });
    expect(result.human).toBe(SIGNED_IN_RECEIVING_LINE);
    expect(result.exitCode).toBe(0);
    expect(callsTo("providers.linkCancel")).toEqual([]);
    expect(callsTo("providers.setEnabled")).toEqual([]);
  });

  it("keeps the connected deadline from epoch zero across errors and repeated states", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    try {
      const completionTimes: number[] = [];
      const waitTimes: number[] = [];
      const elapsedByWait = [20_000, 20_000, 19_999, 1];
      makeHost({
        providerId: "codex",
        profiles: [],
        laterProfiles: () => [],
        link: linkAnswer({ kind: "local_handoff" }),
        complete: (callNumber) => {
          completionTimes.push(Date.now());
          if (callNumber === 1) return completeAnswer("installing", null, null);
          if (callNumber === 2)
            return Promise.reject(new Error("Temporary completion failure."));
          if (callNumber === 3)
            return completeAnswer("unavailable", null, null);
          return completeAnswer("installing", null, null);
        },
      });
      const fake = makeIo({
        terminal: false,
        onWait: (waitCall) => {
          const elapsed = elapsedByWait[waitCall - 1];
          if (elapsed === undefined)
            throw new Error("Unexpected wait after the receiving deadline.");
          vi.setSystemTime(Date.now() + elapsed);
          waitTimes.push(Date.now());
        },
      });

      const { result } = await runLogin(
        "codex",
        { kind: "create", label: "Work profile" },
        fake.io,
      );

      expect(completionTimes).toEqual([0, 20_000, 40_000, 59_999]);
      expect(waitTimes).toEqual([20_000, 40_000, 59_999, 60_000]);
      expect(callsTo("providers.linkComplete")).toHaveLength(4);
      expect(result.data).toEqual({
        providerId: "codex",
        status: "signed-in-pending",
      });
      expect(result.human).toBe(SIGNED_IN_RECEIVING_LINE);
      expect(result.exitCode).toBe(0);
      expect(callsTo("providers.linkCancel")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the receiving deadline after the browser leg", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    try {
      const completionTimes: number[] = [];
      makeHost({
        providerId: "claude-code",
        profiles: [],
        laterProfiles: () => [],
        link: linkAnswer(SIGN_IN_URL_PROMPT),
        complete: (callNumber) => {
          completionTimes.push(Date.now());
          return callNumber === 1
            ? completeAnswer("installing", null, null)
            : completeAnswer("linked", MANAGED_PROFILE_ID, null);
        },
      });
      const fake = makeIo({
        terminal: true,
        lines: [CODE],
        onOpenUrl: () => vi.setSystemTime(300_000),
        onWait: () => vi.setSystemTime(Date.now() + 59_999),
      });

      const { result } = await runLogin(
        "claude",
        { kind: "create", label: "Work profile" },
        fake.io,
      );

      expect(completionTimes).toEqual([300_000, 359_999]);
      expect(callsTo("providers.linkComplete")).toHaveLength(2);
      expect(result.data).toEqual({
        providerId: "claude-code",
        status: "signed-in-pending",
      });
      expect(result.human).toBe(SIGNED_IN_RECEIVING_LINE);
      expect(result.exitCode).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds existing-profile certification waits by the connected deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    try {
      const selected = profile(
        MANAGED_PROFILE_ID,
        "managed",
        "Selected profile",
        ENVIRONMENT_PROFILE_ID,
      );
      const completionTimes: number[] = [];
      const waitTimes: number[] = [];
      makeHost({
        providerId: "claude-code",
        profiles: [selected],
        link: linkAnswer({ kind: "local_handoff" }),
        complete: (callNumber) => {
          completionTimes.push(Date.now());
          return callNumber === 1
            ? completeAnswer("installing", null, null)
            : completeAnswer("linked", null, null);
        },
      });
      const fake = makeIo({
        terminal: true,
        onWait: () => {
          vi.setSystemTime(Date.now() + 30_000);
          waitTimes.push(Date.now());
        },
      });

      const { result } = await runLogin(
        "claude",
        { kind: "existing", profile: MANAGED_PROFILE_ID },
        fake.io,
      );

      expect(completionTimes).toEqual([0, 30_000]);
      expect(waitTimes).toEqual([30_000, 60_000]);
      expect(callsTo("providers.linkComplete")).toHaveLength(2);
      expect(callsTo("providers.list")).toHaveLength(1);
      expect(result.data).toEqual({
        providerId: "claude-code",
        status: "signed-in-pending",
      });
      expect(result.human).toBe(SIGNED_IN_RECEIVING_LINE);
      expect(result.exitCode).toBe(0);
      expect(callsTo("providers.linkCancel")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers from a transient completion error before the connected deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    try {
      const admitted = profile(
        MANAGED_PROFILE_ID,
        "managed",
        "New profile",
        ENVIRONMENT_PROFILE_ID,
      );
      const completionTimes: number[] = [];
      makeHost({
        providerId: "codex",
        profiles: [],
        laterProfiles: (listCall) => (listCall === 2 ? [] : [admitted]),
        link: linkAnswer({ kind: "local_handoff" }),
        complete: (callNumber) => {
          completionTimes.push(Date.now());
          if (callNumber === 1) return completeAnswer("installing", null, null);
          if (callNumber === 2)
            return Promise.reject(new Error("Temporary completion failure."));
          return completeAnswer("linked", MANAGED_PROFILE_ID, null);
        },
      });
      const fake = makeIo({
        terminal: false,
        onWait: () => vi.setSystemTime(Date.now() + 20_000),
      });

      const { result } = await runLogin(
        "codex",
        { kind: "create", label: "Work profile" },
        fake.io,
      );

      expect(completionTimes).toEqual([0, 20_000, 40_000]);
      expect(callsTo("providers.linkComplete")).toHaveLength(3);
      expect(result.data).toMatchObject({
        providerId: "codex",
        status: "signed-in",
        profile: { profileId: MANAGED_PROFILE_ID },
      });
      expect(result.exitCode).toBe(0);
      expect(callsTo("providers.linkCancel")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an existing linked profile pending when its admitted row is unauthenticated", async () => {
    const selected = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Selected profile",
      ENVIRONMENT_PROFILE_ID,
    );
    const unauthenticated: ProviderProfile = {
      ...selected,
      auth: { ...selected.auth, status: "unauthenticated" },
    };
    makeHost({
      providerId: "claude-code",
      profiles: [selected],
      laterProfiles: () => [unauthenticated],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: () => completeAnswer("linked", MANAGED_PROFILE_ID, null),
    });

    const { result } = await runLogin(
      "claude",
      { kind: "existing", profile: MANAGED_PROFILE_ID },
      makeIo({ terminal: true }).io,
    );

    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "signed-in-pending",
    });
    expect(result.human).toBe(SIGNED_IN_RECEIVING_LINE);
    expect(result.exitCode).toBe(0);
    expect(callsTo("providers.list")).toHaveLength(2);
    expect(callsTo("providers.linkComplete")).toHaveLength(1);
    expect(callsTo("providers.linkCancel")).toEqual([]);
  });

  it("waits through Codex device sign-in and resolves the admitted alias to its local id", async () => {
    const admitted = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Local label does not match the requested label",
      ENVIRONMENT_PROFILE_ID,
    );
    makeHost({
      providerId: "codex",
      profiles: [],
      laterProfiles: () => [admitted],
      link: linkAnswer({
        kind: "device_code",
        verificationUrl: "https://auth.example.test/device",
        userCode: "DEVICE-CODE",
        expiresAt: 1,
      }),
      complete: (callNumber) =>
        callNumber === 1
          ? completeAnswer("pending", null, null)
          : completeAnswer("installing", null, null),
    });
    const fake = makeIo({ terminal: false });

    const { result } = await runLogin(
      "codex",
      { kind: "create", label: "Requested profile" },
      fake.io,
    );

    expect(callsTo("providers.linkComplete").map((call) => call[1])).toEqual([
      {
        linkId: "link-attempt",
        environmentId: ENVIRONMENT_ID,
        code: null,
      },
      {
        linkId: "link-attempt",
        environmentId: ENVIRONMENT_ID,
        code: null,
      },
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      providerId: "codex",
      status: "signed-in",
      created: true,
      profile: { profileId: MANAGED_PROFILE_ID },
    });
  });

  it("does not accept an old admitted alias for an existing profile before linked returns its local id", async () => {
    const selected = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Selected profile",
      ENVIRONMENT_PROFILE_ID,
    );
    const oldAdmitted = profile(
      OLD_PROFILE_ID,
      "managed",
      "Old local profile",
      ENVIRONMENT_PROFILE_ID,
    );
    let linked = false;
    makeHost({
      providerId: "claude-code",
      profiles: [selected],
      laterProfiles: () => (linked ? [selected] : [oldAdmitted]),
      link: linkAnswer(SIGN_IN_URL_PROMPT),
      complete: (callNumber) => {
        if (callNumber === 2) linked = true;
        return callNumber === 1
          ? completeAnswer("installing", null, null)
          : completeAnswer("linked", MANAGED_PROFILE_ID, null);
      },
    });
    const fake = makeIo({ terminal: true, lines: [CODE] });

    const { result } = await runLogin(
      "claude",
      { kind: "existing", profile: MANAGED_PROFILE_ID },
      fake.io,
    );

    expect(onlyCallTo("providers.link")[1]).toMatchObject({
      providerId: "claude-code",
      profileId: ENVIRONMENT_PROFILE_ID,
      createProfile: null,
      replaceAccount: false,
    });
    expect(callsTo("providers.linkComplete").map((call) => call[1])).toEqual([
      {
        linkId: "link-attempt",
        environmentId: ENVIRONMENT_ID,
        code: CODE,
      },
      {
        linkId: "link-attempt",
        environmentId: ENVIRONMENT_ID,
        code: null,
      },
    ]);
    expect(callsTo("providers.list")).toHaveLength(2);
    expect(result.data).toMatchObject({
      status: "signed-in",
      created: false,
      profile: { profileId: MANAGED_PROFILE_ID },
    });
  });

  it("keeps a connected existing profile pending after poll and certified inventory failures", async () => {
    const selected = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Selected profile",
      ENVIRONMENT_PROFILE_ID,
    );
    makeHost({
      providerId: "claude-code",
      profiles: [selected],
      laterProfiles: () => [selected],
      link: linkAnswer(SIGN_IN_URL_PROMPT),
      complete: (callNumber) => {
        if (callNumber === 1) return completeAnswer("installing", null, null);
        if (callNumber === 2)
          return Promise.reject(new Error("Fake completion read failed."));
        if (callNumber === 3) return completeAnswer("unavailable", null, null);
        return completeAnswer("linked", MANAGED_PROFILE_ID, null);
      },
      failingProviderListCalls: [2],
    });
    const context = makeContext();
    const humanRequired = vi.spyOn(context.output, "humanRequired");
    const completionWaitsAfterErrors: number[] = [];
    const fake = makeIo({
      terminal: true,
      lines: [CODE],
      onWait: () => {
        const completedPolls = callsTo("providers.linkComplete").length;
        if (completedPolls === 2 || completedPolls === 3) {
          expect(callsTo("providers.link")).toHaveLength(1);
          expect(humanRequired).not.toHaveBeenCalledWith(
            expect.stringContaining("Retry"),
          );
          completionWaitsAfterErrors.push(completedPolls);
        }
      },
    });
    const result = await buildProfileLoginCommand(
      {
        provider: "claude",
        target: { kind: "existing", profile: MANAGED_PROFILE_ID },
      },
      fake.io,
    )(context);

    expect(callsTo("providers.link")).toHaveLength(1);
    expect(callsTo("providers.startLogin")).toEqual([]);
    expect(callsTo("providers.linkComplete").map((call) => call[1])).toEqual([
      { linkId: "link-attempt", environmentId: ENVIRONMENT_ID, code: CODE },
      { linkId: "link-attempt", environmentId: ENVIRONMENT_ID, code: null },
      { linkId: "link-attempt", environmentId: ENVIRONMENT_ID, code: null },
      { linkId: "link-attempt", environmentId: ENVIRONMENT_ID, code: null },
    ]);
    expect(callsTo("providers.list")).toHaveLength(2);
    expect(completionWaitsAfterErrors).toEqual([2, 3]);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "signed-in-pending",
    });
    expect(humanRequired).not.toHaveBeenCalledWith(
      expect.stringContaining("Retry"),
    );
  });

  it("returns a new profile as pending when installing expires before inventory confirms it", async () => {
    makeHost({
      providerId: "claude-code",
      profiles: [],
      laterProfiles: () => [],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: (callNumber) =>
        callNumber === 1
          ? completeAnswer("installing", null, null)
          : completeAnswer("expired", null, null),
    });
    const fake = makeIo({ terminal: true });

    const { result } = await runLogin(
      "claude",
      { kind: "create", label: "Work profile" },
      fake.io,
    );

    expect(callsTo("providers.linkComplete")).toHaveLength(2);
    expect(callsTo("providers.list")).toHaveLength(2);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "signed-in-pending",
    });
  });

  it("reports the targeted no-sign-in response before generic incomplete failure", async () => {
    makeHost({
      providerId: "codex",
      profiles: [],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: () => completeAnswer("failed", null, "no_sign_in"),
    });

    const { result } = await runLogin(
      "codex",
      { kind: "create", label: "Work profile" },
      makeIo({ terminal: false }).io,
    );

    expect(result.data).toEqual({
      providerId: "codex",
      status: "not-started",
      message: "Sign in on this computer first, then try again.",
    });
    expect(result.human).toBe(
      "Sign in on this computer first, then try again.",
    );
    expect(result.exitCode).toBe(1);
    expect(callsTo("providers.linkCancel")).toHaveLength(1);
    expect(callsTo("providers.setEnabled")).toEqual([]);
  });

  it("refuses a typed existing-profile mismatch without replacing the account", async () => {
    const selected = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Selected profile",
      ENVIRONMENT_PROFILE_ID,
    );
    makeHost({
      providerId: "claude-code",
      profiles: [selected],
      link: linkAnswer(SIGN_IN_URL_PROMPT),
      complete: () =>
        completeAnswer("mismatch", null, "harness_account_mismatch"),
    });
    const fake = makeIo({ terminal: true, lines: [CODE, "n"] });

    const { context, result } = await runLogin(
      "claude",
      { kind: "existing", profile: MANAGED_PROFILE_ID },
      fake.io,
    );

    expect(onlyCallTo("providers.link")[1]).toMatchObject({
      profileId: ENVIRONMENT_PROFILE_ID,
      createProfile: null,
      replaceAccount: false,
    });
    expect(context.output.humanRequired).toHaveBeenCalledWith(
      ACCOUNT_MISMATCH_SIGN_IN_LINE,
    );
    expect(context.output.humanRequired).toHaveBeenCalledWith(
      `${REPLACE_PROFILE_ACCOUNT_LINE}\nSwitch account? [y/N]`,
    );
    expect(result.data).toMatchObject({
      status: "not-started",
      message: ACCOUNT_MISMATCH_SIGN_IN_LINE,
    });
    expect(callsTo("providers.link")).toHaveLength(1);
  });

  it.each(["", " \t "] as const)(
    "defaults a blank mismatch confirmation to no while its reader stays open",
    async (confirmation) => {
      const selected = profile(
        MANAGED_PROFILE_ID,
        "managed",
        "Selected profile",
        ENVIRONMENT_PROFILE_ID,
      );
      let notifyConfirmationReaderOpen: () => void = () => {};
      let confirmationReaderStarts = 0;
      const confirmationReaderOpen = new Promise<void>((resolve) => {
        notifyConfirmationReaderOpen = resolve;
      });
      makeHost({
        providerId: "claude-code",
        profiles: [selected],
        link: linkAnswer(SIGN_IN_URL_PROMPT),
        complete: () =>
          completeAnswer("mismatch", null, "harness_account_mismatch"),
      });
      const fake = makeIo({
        terminal: true,
        lines: [CODE],
        holdEmptyReader: true,
        onHeldReaderOpen: () => {
          confirmationReaderStarts += 1;
          notifyConfirmationReaderOpen();
        },
      });
      const run = runLogin(
        "claude",
        { kind: "existing", profile: MANAGED_PROFILE_ID },
        fake.io,
      );

      await Promise.race([
        confirmationReaderOpen,
        run.then(() => {
          throw new Error(
            "CLI sign-in ended before confirmation input opened.",
          );
        }),
      ]);
      expect(fake.isLineReaderOpen()).toBe(true);
      expect(confirmationReaderStarts).toBe(1);
      expect(callsTo("providers.link")).toHaveLength(1);
      fake.sendLine(confirmation);
      const { result } = await run;

      expect(fake.isLineReaderOpen()).toBe(false);
      expect(result.data).toMatchObject({
        status: "not-started",
        message: ACCOUNT_MISMATCH_SIGN_IN_LINE,
      });
      expect(result.exitCode).toBe(1);
      expect(callsTo("providers.link")).toHaveLength(1);
      expect(callsTo("providers.linkCancel")).toHaveLength(1);
    },
  );

  it("retries an unidentified start only after explicit account-switch confirmation", async () => {
    const selected = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Selected profile",
      ENVIRONMENT_PROFILE_ID,
    );
    let linkRequests = 0;
    makeHost({
      providerId: "claude-code",
      profiles: [selected],
      onLinkRequest: () => {
        linkRequests += 1;
        if (linkRequests === 1)
          throw new HostRpcError({
            code: "harness_account_unidentified",
            message: "The account on this profile could not be confirmed.",
            requestId: "link-request",
            method: "providers.link",
            fatalDetails: null,
          });
      },
      link: linkAnswer({ kind: "local_handoff" }),
      complete: () => completeAnswer("linked", MANAGED_PROFILE_ID, null),
    });

    const { context, result } = await runLogin(
      "claude",
      { kind: "existing", profile: MANAGED_PROFILE_ID },
      makeIo({ terminal: true, lines: ["yes"] }).io,
    );

    expect(callsTo("providers.link")).toHaveLength(2);
    expect(callsTo("providers.link").map((call) => call[1])).toEqual([
      expect.objectContaining({ replaceAccount: false }),
      expect.objectContaining({ replaceAccount: true }),
    ]);
    expect(context.output.humanRequired).toHaveBeenCalledWith(
      ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE,
    );
    expect(context.output.humanRequired).toHaveBeenCalledWith(
      `${REPLACE_PROFILE_ACCOUNT_LINE}\nSwitch account? [y/N]`,
    );
    expect(result.data).toMatchObject({ status: "signed-in", created: false });
    expect(callsTo("providers.linkCancel")).toEqual([]);
  });

  it("refuses a blank unidentified-start confirmation without a replacement or release", async () => {
    const selected = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Selected profile",
      ENVIRONMENT_PROFILE_ID,
    );
    let notifyReaderOpen: () => void = () => {};
    const readerOpen = new Promise<void>((resolve) => {
      notifyReaderOpen = resolve;
    });
    makeHost({
      providerId: "claude-code",
      profiles: [selected],
      onLinkRequest: () => {
        throw new HostRpcError({
          code: "harness_account_unidentified",
          message: "The account on this profile could not be confirmed.",
          requestId: "link-request",
          method: "providers.link",
          fatalDetails: null,
        });
      },
    });
    const fake = makeIo({
      terminal: true,
      holdEmptyReader: true,
      onHeldReaderOpen: notifyReaderOpen,
    });
    const run = runLogin(
      "claude",
      { kind: "existing", profile: MANAGED_PROFILE_ID },
      fake.io,
    );

    await Promise.race([
      readerOpen,
      run.then(() => {
        throw new Error("CLI sign-in ended before confirmation input opened.");
      }),
    ]);
    expect(fake.isLineReaderOpen()).toBe(true);
    fake.sendLine(" \t ");
    const { context, result } = await run;

    expect(result.data).toMatchObject({
      status: "not-started",
      message: ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE,
    });
    expect(callsTo("providers.link")).toHaveLength(1);
    expect(callsTo("providers.linkCancel")).toEqual([]);
    expect(context.output.humanRequired).toHaveBeenCalledWith(
      `${REPLACE_PROFILE_ACCOUNT_LINE}\nSwitch account? [y/N]`,
    );
  });

  it("refuses an unidentified start without a terminal confirmation reader", async () => {
    const selected = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Selected profile",
      ENVIRONMENT_PROFILE_ID,
    );
    makeHost({
      providerId: "codex",
      profiles: [selected],
      onLinkRequest: () => {
        throw new HostRpcError({
          code: "harness_account_unidentified",
          message: "The account on this profile could not be confirmed.",
          requestId: "link-request",
          method: "providers.link",
          fatalDetails: null,
        });
      },
    });
    const fake = makeIo({ terminal: false });

    const { context, result } = await runLogin(
      "codex",
      { kind: "existing", profile: MANAGED_PROFILE_ID },
      fake.io,
    );

    expect(result.data).toMatchObject({
      status: "not-started",
      message: ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE,
    });
    expect(callsTo("providers.link")).toHaveLength(1);
    expect(callsTo("providers.linkCancel")).toEqual([]);
    expect(context.output.humanRequired).not.toHaveBeenCalledWith(
      `${REPLACE_PROFILE_ACCOUNT_LINE}\nSwitch account? [y/N]`,
    );
  });

  it("does not re-prompt when a replacement start is also unidentified", async () => {
    const selected = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Selected profile",
      ENVIRONMENT_PROFILE_ID,
    );
    makeHost({
      providerId: "claude-code",
      profiles: [selected],
      onLinkRequest: () => {
        throw new HostRpcError({
          code: "harness_account_unidentified",
          message: "The account on this profile could not be confirmed.",
          requestId: "link-request",
          method: "providers.link",
          fatalDetails: null,
        });
      },
    });
    const context = makeContext();
    const attempt = buildProfileLoginCommand(
      {
        provider: "claude",
        target: { kind: "existing", profile: MANAGED_PROFILE_ID },
      },
      makeIo({ terminal: true, lines: ["yes"] }).io,
    )(context);

    await expect(attempt).rejects.toMatchObject({
      code: CLI_ERROR_CODES.UNEXPECTED,
    });
    expect(callsTo("providers.link")).toHaveLength(2);
    expect(callsTo("providers.link").map((call) => call[1])).toEqual([
      expect.objectContaining({ replaceAccount: false }),
      expect.objectContaining({ replaceAccount: true }),
    ]);
    expect(context.output.humanRequired).toHaveBeenCalledTimes(2);
    expect(callsTo("providers.linkCancel")).toEqual([]);
  });

  it("does not prompt or replay an unidentified start marked as possibly sent earlier", async () => {
    makeHost({
      providerId: "codex",
      profiles: [],
      onLinkRequest: () => {
        const error = new HostRpcError({
          code: "harness_account_unidentified",
          message: "The account on this profile could not be confirmed.",
          requestId: "link-request",
          method: "providers.link",
          fatalDetails: null,
        });
        markMayHaveReachedHost(error);
        throw error;
      },
    });
    const context = makeContext();
    const attempt = buildProfileLoginCommand(
      {
        provider: "codex",
        target: { kind: "create", label: "Work profile" },
      },
      makeIo({ terminal: true }).io,
    )(context);

    await expect(attempt).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
    });
    expect(callsTo("providers.link")).toHaveLength(1);
    expect(context.output.humanRequired).not.toHaveBeenCalledWith(
      ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE,
    );
    expect(callsTo("providers.linkCancel")).toEqual([]);
  });

  it("ignores blank code input and accepts the next line on the same open reader", async () => {
    const admitted = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Work profile",
      ENVIRONMENT_PROFILE_ID,
    );
    let notifyCodeReaderOpen: () => void = () => {};
    let codeReaderStarts = 0;
    const codeReaderOpen = new Promise<void>((resolve) => {
      notifyCodeReaderOpen = resolve;
    });
    makeHost({
      providerId: "claude-code",
      profiles: [],
      laterProfiles: () => [admitted],
      link: linkAnswer(SIGN_IN_URL_PROMPT),
      complete: () => completeAnswer("linked", null, null),
    });
    const fake = makeIo({
      terminal: true,
      holdEmptyReader: true,
      onHeldReaderOpen: () => {
        codeReaderStarts += 1;
        notifyCodeReaderOpen();
      },
    });
    const run = runLogin(
      "claude",
      { kind: "create", label: "Work profile" },
      fake.io,
    );

    await Promise.race([
      codeReaderOpen,
      run.then(() => {
        throw new Error("CLI sign-in ended before code input opened.");
      }),
    ]);
    expect(fake.isLineReaderOpen()).toBe(true);
    expect(codeReaderStarts).toBe(1);
    fake.sendLine(" \t ");
    expect(fake.isLineReaderOpen()).toBe(true);
    expect(codeReaderStarts).toBe(1);
    fake.sendLine(CODE);
    const { result } = await run;

    expect(fake.isLineReaderOpen()).toBe(false);
    expect(codeReaderStarts).toBe(1);
    expect(onlyCallTo("providers.linkComplete")[1]).toEqual({
      linkId: "link-attempt",
      environmentId: ENVIRONMENT_ID,
      code: CODE,
    });
    expect(result.data).toMatchObject({
      status: "signed-in",
      profile: { profileId: MANAGED_PROFILE_ID },
    });
    expect(result.exitCode).toBe(0);
  });

  it("keeps ambient sign-in on the existing local flow", async () => {
    const ambient = profile(
      AMBIENT_PROFILE_ID_SENTINEL,
      "ambient",
      "Terminal login",
      null,
    );
    makeHost({
      providerId: "claude-code",
      profiles: [ambient],
      await: awaitAnswer(providerState("claude-code", [ambient])),
      methodVersion: () => V12,
    });
    const fake = makeIo({ terminal: false });

    const { result } = await runLogin(
      "claude",
      { kind: "existing", profile: AMBIENT_PROFILE_ID_SENTINEL },
      fake.io,
    );

    expect(callsTo("providers.startLogin")).toHaveLength(1);
    expect(onlyCallTo("providers.startLogin")[1]).toMatchObject({
      providerId: "claude-code",
      profileId: null,
      createProfile: null,
    });
    expect(callsTo("providers.link")).toHaveLength(0);
    expect(result.data).toMatchObject({
      status: "signed-in",
      created: false,
    });
  });

  it.each([
    [
      "old link with new completion",
      (method: string) =>
        method === "providers.link" ? { major: 1, minor: 1 } : V12,
    ],
    [
      "new link with old completion",
      (method: string) =>
        method === "providers.linkComplete" ? { major: 1, minor: 1 } : V12,
    ],
    [
      "missing link",
      (method: string) => (method === "providers.link" ? null : V12),
    ],
    [
      "missing completion",
      (method: string) => (method === "providers.linkComplete" ? null : V12),
    ],
    [
      "missing environment status",
      (method: string) => (method === "environment.status" ? null : V12),
    ],
    [
      "missing environment host read",
      (method: string) => (method === "environment.host.read" ? null : V12),
    ],
  ] as const)(
    "uses the existing local flow for an existing profile with %s",
    async (_case, methodVersion) => {
      const selected = profile(
        MANAGED_PROFILE_ID,
        "managed",
        "Selected profile",
        ENVIRONMENT_PROFILE_ID,
      );
      makeHost({
        providerId: "claude-code",
        profiles: [selected],
        await: awaitAnswer(providerState("claude-code", [selected])),
        methodVersion,
      });
      const fake = makeIo({ terminal: true });

      const { result } = await runLogin(
        "claude",
        { kind: "existing", profile: MANAGED_PROFILE_ID },
        fake.io,
      );

      expect(onlyCallTo("providers.startLogin")[1]).toMatchObject({
        providerId: "claude-code",
        profileId: MANAGED_PROFILE_ID,
        createProfile: null,
      });
      expect(callsTo("providers.link")).toHaveLength(0);
      expect(callsTo("environment.status")).toEqual([]);
      expect(callsTo("environment.host.read")).toEqual([]);
      expect(result.data).toMatchObject({
        status: "signed-in",
        created: false,
        profile: { profileId: MANAGED_PROFILE_ID },
      });
    },
  );

  it("propagates an environment status read failure without falling back locally", async () => {
    makeHost({
      providerId: "claude-code",
      profiles: [],
      environmentStatus: () =>
        Promise.reject(
          new HostRpcError({
            code: "UNAUTHORIZED",
            message: "The status read requires authentication.",
            requestId: "status-request",
            method: "environment.status",
            fatalDetails: null,
          }),
        ),
    });
    const context = makeContext();

    const attempt = buildProfileLoginCommand(
      {
        provider: "claude",
        target: { kind: "create", label: "Work profile" },
      },
      makeIo({ terminal: true }).io,
    )(context);
    await expect(attempt).rejects.toBeInstanceOf(CliError);
    await expect(attempt).rejects.toMatchObject({
      code: CLI_ERROR_CODES.AUTH_REJECTED,
    });

    expect(callsTo("environment.status")).toHaveLength(1);
    expect(callsTo("environment.host.read")).toEqual([]);
    expect(callsTo("providers.startLogin")).toEqual([]);
    expect(callsTo("providers.link")).toEqual([]);
  });

  it("propagates an environment host read failure without falling back locally", async () => {
    makeHost({
      providerId: "claude-code",
      profiles: [],
      environmentHostRead: () =>
        Promise.reject(
          new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            message: "Environment binding reads are unsupported.",
            requestId: "binding-request",
            method: "environment.host.read",
            fatalDetails: null,
          }),
        ),
    });

    const attempt = runLogin(
      "claude",
      { kind: "create", label: "Work profile" },
      makeIo({ terminal: true }).io,
    );
    await expect(attempt).rejects.toBeInstanceOf(CliError);
    await expect(attempt).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_UNSUPPORTED,
    });

    expect(callsTo("environment.status")).toHaveLength(1);
    expect(callsTo("environment.host.read")).toHaveLength(1);
    expect(callsTo("providers.startLogin")).toEqual([]);
    expect(callsTo("providers.link")).toEqual([]);
  });

  it("releases a link once when Ctrl+C interrupts pending completion", async () => {
    makeHost({
      providerId: "codex",
      profiles: [],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: () => completeAnswer("pending", null, null),
    });
    const fake = makeIo({ terminal: false, interruptOnWait: true });

    const { result } = await runLogin(
      "codex",
      { kind: "create", label: "Work profile" },
      fake.io,
    );

    expect(result.data).toEqual({ providerId: "codex", status: "cancelled" });
    expect(callsTo("providers.linkCancel")).toHaveLength(1);
    expect(callsTo("providers.setEnabled")).toEqual([]);
    expect(onlyCallTo("providers.linkCancel")[1]).toEqual({
      linkId: "link-attempt",
      environmentId: ENVIRONMENT_ID,
    });
  });

  it("removes its interrupt listener immediately while providers.link is unresolved", async () => {
    let notifyLinkStarted: () => void = () => {};
    const linkStarted = new Promise<void>((resolve) => {
      notifyLinkStarted = () => resolve();
    });
    let resolveLink: (answer: ProvidersLinkResponseV12) => void = () => {};
    makeHost({
      providerId: "claude-code",
      profiles: [],
      onLinkRequest: notifyLinkStarted,
      link: new Promise<ProvidersLinkResponseV12>((resolve) => {
        resolveLink = resolve;
      }),
    });
    const fake = makeIo({ terminal: true });
    const run = runLogin(
      "claude",
      { kind: "create", label: "Work profile" },
      fake.io,
    );

    await Promise.race([
      linkStarted,
      run.then(() => {
        throw new Error("CLI sign-in ended before providers.link started.");
      }),
    ]);
    expect(fake.isInterruptListening()).toBe(true);

    fake.interrupt();

    expect(fake.isInterruptListening()).toBe(false);
    resolveLink(linkAnswer({ kind: "local_handoff" }));
    const { result } = await run;

    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "cancelled",
    });
    expect(callsTo("providers.linkCancel")).toHaveLength(1);
    expect(onlyCallTo("providers.link")[2]).toMatchObject({
      reauthenticate: "before-request",
      signal: null,
    });
    expect(callsTo("providers.linkComplete")).toEqual([]);
  });

  it.each([
    ["linked", completeAnswer("linked", MANAGED_PROFILE_ID, null)],
    ["installing", completeAnswer("installing", null, null)],
  ] as const)(
    "does not cancel a connection when Ctrl+C races with an in-flight %s reply",
    async (state, response) => {
      expect(response.state).toBe(state);
      const selected = profile(
        MANAGED_PROFILE_ID,
        "managed",
        "Selected profile",
        ENVIRONMENT_PROFILE_ID,
      );
      let notifyCompleteStarted: () => void = () => {};
      const completeStarted = new Promise<void>((resolve) => {
        notifyCompleteStarted = () => resolve();
      });
      let resolveComplete: (
        answer: ProvidersLinkCompleteResponseV12,
      ) => void = () => {};
      makeHost({
        providerId: "claude-code",
        profiles: [selected],
        link: linkAnswer({ kind: "local_handoff" }),
        complete: () =>
          new Promise<ProvidersLinkCompleteResponseV12>((resolve) => {
            resolveComplete = (answer) => resolve(answer);
            notifyCompleteStarted();
          }),
      });
      const fake = makeIo({ terminal: true });
      const context = makeContext();
      const run = buildProfileLoginCommand(
        {
          provider: "claude",
          target: { kind: "existing", profile: MANAGED_PROFILE_ID },
        },
        fake.io,
      )(context);

      await Promise.race([
        completeStarted,
        run.then(() => {
          throw new Error(
            "CLI sign-in ended before its first completion request started.",
          );
        }),
      ]);
      fake.interrupt();
      expect(fake.isInterruptListening()).toBe(false);
      resolveComplete(response);
      const result = await run;

      expect(result.data).toEqual({
        providerId: "claude-code",
        status: "signed-in-pending",
      });
      expect(result.human).toBe(SIGNED_IN_RECEIVING_LINE);
      expect(result.exitCode).toBe(0);
      expect(callsTo("providers.linkComplete")).toHaveLength(1);
      expect(callsTo("providers.linkCancel")).toEqual([]);
      expect(onlyCallTo("providers.link")[2]).toMatchObject({
        reauthenticate: "before-request",
        signal: null,
      });
      expect(onlyCallTo("providers.linkComplete")[2]).toMatchObject({
        reauthenticate: "always",
        signal: null,
      });
    },
  );

  it("keeps a connected sign-in pending when Ctrl+C interrupts the polling wait", async () => {
    makeHost({
      providerId: "codex",
      profiles: [],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: () => completeAnswer("installing", null, null),
    });
    const fake = makeIo({ terminal: false, interruptOnWait: true });

    const { result } = await runLogin(
      "codex",
      { kind: "create", label: "Work profile" },
      fake.io,
    );

    expect(result.data).toEqual({
      providerId: "codex",
      status: "signed-in-pending",
    });
    expect(result.human).toBe(SIGNED_IN_RECEIVING_LINE);
    expect(result.exitCode).toBe(0);
    expect(callsTo("providers.linkComplete")).toHaveLength(1);
    expect(callsTo("providers.linkCancel")).toEqual([]);
    expect(callsTo("providers.setEnabled")).toEqual([]);
  });

  it("returns cancellation when the deferred link rejects after Ctrl+C", async () => {
    let notifyLinkStarted: () => void = () => {};
    const linkStarted = new Promise<void>((resolve) => {
      notifyLinkStarted = resolve;
    });
    let rejectLink: (error: unknown) => void = () => {};
    const link = new Promise<ProvidersLinkResponseV12>((_resolve, reject) => {
      rejectLink = reject;
    });
    makeHost({
      providerId: "codex",
      profiles: [],
      onLinkRequest: notifyLinkStarted,
      link,
    });
    const fake = makeIo({ terminal: false });
    const context = makeContext();
    const run = buildProfileLoginCommand(
      {
        provider: "codex",
        target: { kind: "create", label: "Work profile" },
      },
      fake.io,
    )(context);

    await Promise.race([
      linkStarted,
      run.then(() => {
        throw new Error("CLI sign-in ended before providers.link started.");
      }),
    ]);
    fake.interrupt();
    rejectLink(
      new HostRpcError({
        code: "harness_account_unidentified",
        message: "The account on this profile could not be confirmed.",
        requestId: "link-request",
        method: "providers.link",
        fatalDetails: null,
      }),
    );
    const result = await run;

    expect(result.data).toEqual({ providerId: "codex", status: "cancelled" });
    expect(result.exitCode).toBe(130);
    expect(callsTo("providers.link")).toHaveLength(1);
    expect(callsTo("providers.linkComplete")).toEqual([]);
    expect(callsTo("providers.linkCancel")).toEqual([]);
    expect(context.output.humanRequired).not.toHaveBeenCalledWith(
      ACCOUNT_UNIDENTIFIED_SIGN_IN_LINE,
    );
  });

  it("reports an ambiguous post-send create without repeating the link", async () => {
    let notifyLinkStarted: () => void = () => {};
    const linkStarted = new Promise<void>((resolve) => {
      notifyLinkStarted = resolve;
    });
    let rejectLink: (error: unknown) => void = () => {};
    const link = new Promise<ProvidersLinkResponseV12>((_resolve, reject) => {
      rejectLink = reject;
    });
    makeHost({
      providerId: "codex",
      profiles: [],
      onLinkRequest: notifyLinkStarted,
      link,
    });
    const attempt = runLogin(
      "codex",
      { kind: "create", label: "Work profile" },
      makeIo({ terminal: false }).io,
    );

    await Promise.race([
      linkStarted,
      attempt.then(() => {
        throw new Error("CLI sign-in ended before providers.link started.");
      }),
    ]);
    rejectLink(
      new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "The link transport failed after send.",
        requestId: "link-request",
        method: "providers.link",
        fatalDetails: null,
      }),
    );

    await expect(attempt).rejects.toBeInstanceOf(CliError);
    await expect(attempt).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message:
        "Sign-in may have completed. Check this profile before trying again.",
    });
    expect(callsTo("providers.link")).toHaveLength(1);
    expect(onlyCallTo("providers.link")[1]).toMatchObject({
      createProfile: {
        label: "Work profile",
        shareSkillsAndPlugins: false,
      },
    });
    expect(callsTo("providers.startLogin")).toEqual([]);
    expect(callsTo("providers.linkComplete")).toEqual([]);
  });

  it("keeps a rejected first completion outcome unknown after Ctrl+C", async () => {
    let notifyCompletionStarted: () => void = () => {};
    const completionStarted = new Promise<void>((resolve) => {
      notifyCompletionStarted = resolve;
    });
    let rejectCompletion: (error: unknown) => void = () => {};
    makeHost({
      providerId: "codex",
      profiles: [],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: () =>
        new Promise<ProvidersLinkCompleteResponseV12>((_resolve, reject) => {
          rejectCompletion = reject;
          notifyCompletionStarted();
        }),
    });
    const fake = makeIo({ terminal: false });
    const context = makeContext();
    const run = buildProfileLoginCommand(
      {
        provider: "codex",
        target: { kind: "create", label: "Work profile" },
      },
      fake.io,
    )(context);

    await Promise.race([
      completionStarted,
      run.then(() => {
        throw new Error("CLI sign-in ended before linkComplete started.");
      }),
    ]);
    fake.interrupt();
    rejectCompletion(
      new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "The completion transport failed after send.",
        requestId: "completion-request",
        method: "providers.linkComplete",
        fatalDetails: null,
      }),
    );
    await expect(run).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message:
        "Sign-in may have completed. Check this profile before trying again.",
    });
    expect(callsTo("providers.link")).toHaveLength(1);
    expect(callsTo("providers.linkComplete")).toHaveLength(1);
    expect(onlyCallTo("providers.linkComplete")[1]).toMatchObject({
      code: null,
    });
    expect(callsTo("providers.list")).toHaveLength(2);
    expect(callsTo("providers.startLogin")).toEqual([]);
    expect(callsTo("providers.linkCancel")).toHaveLength(1);
    expect(context.output.humanRequired).toHaveBeenCalledWith(
      "No profiles for codex (Codex) on this host.",
    );
    expect(context.output.humanRequired).not.toHaveBeenCalledWith(
      SIGNED_IN_RECEIVING_LINE,
    );
  });

  it("keeps an established link pending when completion rejects after Ctrl+C", async () => {
    let notifyCompletionStarted: () => void = () => {};
    const completionStarted = new Promise<void>((resolve) => {
      notifyCompletionStarted = resolve;
    });
    let rejectCompletion: (error: unknown) => void = () => {};
    makeHost({
      providerId: "codex",
      profiles: [],
      laterProfiles: () => [],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: (callNumber) => {
        if (callNumber === 1) return completeAnswer("installing", null, null);
        return new Promise<ProvidersLinkCompleteResponseV12>(
          (_resolve, reject) => {
            rejectCompletion = reject;
            notifyCompletionStarted();
          },
        );
      },
    });
    const fake = makeIo({ terminal: false });
    const context = makeContext();
    const run = buildProfileLoginCommand(
      {
        provider: "codex",
        target: { kind: "create", label: "Work profile" },
      },
      fake.io,
    )(context);

    await Promise.race([
      completionStarted,
      run.then(() => {
        throw new Error("CLI sign-in ended before its retry started.");
      }),
    ]);
    fake.interrupt();
    rejectCompletion(
      new HostTransportFailureError({
        code: "RPC_ERROR",
        message: "The completion retry transport failed after send.",
        requestId: "completion-retry",
        method: "providers.linkComplete",
        fatalDetails: null,
      }),
    );
    const result = await run;
    expect(result.data).toEqual({
      providerId: "codex",
      status: "signed-in-pending",
    });
    expect(result.human).toBe(SIGNED_IN_RECEIVING_LINE);
    expect(result.exitCode).toBe(0);
    expect(callsTo("providers.linkComplete")).toHaveLength(2);
    expect(callsTo("providers.list")).toHaveLength(2);
    expect(callsTo("providers.startLogin")).toEqual([]);
    expect(callsTo("providers.linkCancel")).toEqual([]);
    expect(callsTo("providers.linkComplete").map((call) => call[1])).toEqual([
      { linkId: "link-attempt", environmentId: ENVIRONMENT_ID, code: null },
      { linkId: "link-attempt", environmentId: ENVIRONMENT_ID, code: null },
    ]);
  });

  it("keeps an unavailable first completion unknown when Ctrl+C arrives before its answer", async () => {
    let notifyCompletionStarted: () => void = () => {};
    const completionStarted = new Promise<void>((resolve) => {
      notifyCompletionStarted = resolve;
    });
    let resolveCompletion: (
      answer: ProvidersLinkCompleteResponseV12,
    ) => void = () => {};
    makeHost({
      providerId: "codex",
      profiles: [],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: () =>
        new Promise<ProvidersLinkCompleteResponseV12>((resolve) => {
          resolveCompletion = resolve;
          notifyCompletionStarted();
        }),
    });
    const fake = makeIo({ terminal: false });
    const context = makeContext();
    const run = buildProfileLoginCommand(
      {
        provider: "codex",
        target: { kind: "create", label: "Work profile" },
      },
      fake.io,
    )(context);

    await Promise.race([
      completionStarted,
      run.then(() => {
        throw new Error("CLI sign-in ended before linkComplete started.");
      }),
    ]);
    fake.interrupt();
    resolveCompletion(completeAnswer("unavailable", null, null));

    await expect(run).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message:
        "Sign-in may have completed. Check this profile before trying again.",
    });
    expect(callsTo("providers.link")).toHaveLength(1);
    expect(callsTo("providers.linkComplete")).toHaveLength(1);
    expect(onlyCallTo("providers.linkComplete")[1]).toMatchObject({
      code: null,
    });
    expect(callsTo("providers.list")).toHaveLength(2);
    expect(callsTo("providers.startLogin")).toEqual([]);
    expect(callsTo("providers.linkCancel")).toHaveLength(1);
    expect(context.output.humanRequired).toHaveBeenCalledWith(
      "No profiles for codex (Codex) on this host.",
    );
    expect(context.output.humanRequired).not.toHaveBeenCalledWith(
      SIGNED_IN_RECEIVING_LINE,
    );
  });

  it.each([
    "RPC_ERROR",
    "PROVIDER_LINK_UNAVAILABLE",
    "E_IDEMPOTENCY_OUTCOME_UNKNOWN",
    "E_IDEMPOTENCY_REPLAY_TOO_LARGE",
  ] as const)(
    "treats an unconnected %s completion refusal as unknown after one inventory summary",
    async (code) => {
      const selected = profile(
        MANAGED_PROFILE_ID,
        "managed",
        "Selected profile",
        ENVIRONMENT_PROFILE_ID,
      );
      makeHost({
        providerId: "codex",
        profiles: [selected],
        link: linkAnswer({ kind: "local_handoff" }),
        complete: () =>
          Promise.reject(
            new HostRpcError({
              code,
              message: "The completion failed on the host.",
              requestId: "completion-request",
              method: "providers.linkComplete",
              fatalDetails: null,
            }),
          ),
      });
      const context = makeContext();
      const attempt = buildProfileLoginCommand(
        {
          provider: "codex",
          target: { kind: "existing", profile: MANAGED_PROFILE_ID },
        },
        makeIo({ terminal: false }).io,
      )(context);

      await expect(attempt).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
        message:
          "Sign-in may have completed. Check this profile before trying again.",
      });
      expect(callsTo("providers.link")).toHaveLength(1);
      expect(callsTo("providers.linkComplete")).toHaveLength(1);
      expect(callsTo("providers.list")).toHaveLength(2);
      expect(callsTo("providers.startLogin")).toEqual([]);
      expect(callsTo("providers.linkCancel")).toHaveLength(1);
      expect(context.output.humanRequired).toHaveBeenCalledWith(
        expect.stringContaining("Selected profile"),
      );
      expect(context.output.humanRequired).not.toHaveBeenCalledWith(
        SIGNED_IN_RECEIVING_LINE,
      );
    },
  );

  it("keeps a marked earlier completion unknown despite a structured refusal", async () => {
    const refusal = new HostRpcError({
      code: "UNAUTHORIZED",
      message: "The completion was refused.",
      requestId: "completion-request",
      method: "providers.linkComplete",
      fatalDetails: null,
    });
    markMayHaveReachedHost(refusal);
    makeHost({
      providerId: "codex",
      profiles: [],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: () => Promise.reject(refusal),
    });
    const context = makeContext();
    const attempt = buildProfileLoginCommand(
      {
        provider: "codex",
        target: { kind: "create", label: "Work profile" },
      },
      makeIo({ terminal: true }).io,
    )(context);

    await expect(attempt).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message:
        "Sign-in may have completed. Check this profile before trying again.",
    });
    expect(callsTo("providers.linkComplete")).toHaveLength(1);
    expect(callsTo("providers.list")).toHaveLength(2);
    expect(context.output.humanRequired).toHaveBeenCalledWith(
      "No profiles for codex (Codex) on this host.",
    );
    expect(context.output.humanRequired).not.toHaveBeenCalledWith(
      ACCOUNT_MISMATCH_SIGN_IN_LINE,
    );
  });

  it("retries a completion failure the transport proves was before send", async () => {
    makeHost({
      providerId: "codex",
      profiles: [],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: (callNumber) => {
        if (callNumber === 1) return completeAnswer("installing", null, null);
        if (callNumber === 2)
          return Promise.reject(
            transportFailureBeforeSend({
              message: "The completion was refused before dispatch.",
              requestId: "completion-request",
              method: "providers.linkComplete",
            }),
          );
        return completeAnswer("expired", null, null);
      },
    });

    const { result } = await runLogin(
      "codex",
      { kind: "create", label: "Work profile" },
      makeIo({ terminal: false }).io,
    );

    expect(result.data).toEqual({
      providerId: "codex",
      status: "signed-in-pending",
    });
    expect(result.human).toBe(SIGNED_IN_RECEIVING_LINE);
    expect(callsTo("providers.linkComplete")).toHaveLength(3);
    expect(callsTo("providers.list")).toHaveLength(2);
    expect(callsTo("providers.linkCancel")).toEqual([]);
  });

  it.each([
    [
      "authorization",
      new HostRpcError({
        code: "UNAUTHORIZED",
        message: "The completion requires authentication.",
        requestId: "completion-request",
        method: "providers.linkComplete",
        fatalDetails: null,
      }),
      CLI_ERROR_CODES.AUTH_REJECTED,
    ],
    [
      "version",
      new HostMethodVersionUnsatisfiedError({
        requirement: { method: "providers.linkComplete", version: V12 },
        negotiated: { major: 1, minor: 1 },
        requestId: "completion-request",
        method: "providers.linkComplete",
        hostId: HOST_ID,
      }),
      CLI_ERROR_CODES.HOST_INCOMPATIBLE,
    ],
  ] as const)(
    "keeps a definitive %s completion refusal ordinary",
    async (_kind, error, code) => {
      makeHost({
        providerId: "codex",
        profiles: [],
        link: linkAnswer({ kind: "local_handoff" }),
        complete: () => Promise.reject(error),
      });
      const context = makeContext();
      const attempt = buildProfileLoginCommand(
        {
          provider: "codex",
          target: { kind: "create", label: "Work profile" },
        },
        makeIo({ terminal: false }).io,
      )(context);

      await expect(attempt).rejects.toMatchObject({ code });
      expect(callsTo("providers.linkComplete")).toHaveLength(1);
      expect(callsTo("providers.list")).toHaveLength(1);
      expect(callsTo("providers.linkCancel")).toHaveLength(1);
      expect(context.output.humanRequired).not.toHaveBeenCalledWith(
        "No profiles for Codex on this host.",
      );
    },
  );

  it("preserves the unknown completion outcome when its inventory read fails", async () => {
    makeHost({
      providerId: "codex",
      profiles: [],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: () =>
        Promise.reject(
          new HostTransportFailureError({
            code: "RPC_ERROR",
            message: "The completion transport failed after send.",
            requestId: "completion-request",
            method: "providers.linkComplete",
            fatalDetails: null,
          }),
        ),
      failingProviderListCalls: [2],
    });
    const context = makeContext();
    const attempt = buildProfileLoginCommand(
      {
        provider: "codex",
        target: { kind: "create", label: "Work profile" },
      },
      makeIo({ terminal: false }).io,
    )(context);

    await expect(attempt).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message:
        "Sign-in may have completed. Check this profile before trying again.",
    });
    expect(callsTo("providers.linkComplete")).toHaveLength(1);
    expect(callsTo("providers.list")).toHaveLength(2);
    expect(callsTo("providers.linkCancel")).toHaveLength(1);
    expect(context.output.humanRequired).not.toHaveBeenCalledWith(
      SIGNED_IN_RECEIVING_LINE,
    );
  });

  it("preserves a mapped failure after removing its interrupt listener before held release", async () => {
    let notifyReleaseStarted: () => void = () => {};
    const releaseStarted = new Promise<void>((resolve) => {
      notifyReleaseStarted = resolve;
    });
    let resolveCancel: () => void = () => {};
    const linkCancel = new Promise<LinkCancelResponse>((resolve) => {
      resolveCancel = () => resolve({});
    });
    let resolveReleaseWait: () => void = () => {};
    makeHost({
      providerId: "codex",
      profiles: [],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: () =>
        Promise.reject(
          new HostTransportFailureError({
            code: "RPC_ERROR",
            message: "The completion transport failed after send.",
            requestId: "completion-request",
            method: "providers.linkComplete",
            fatalDetails: null,
          }),
        ),
      onLinkCancel: notifyReleaseStarted,
      linkCancel,
    });
    const fake = makeIo({
      terminal: false,
      wait: () =>
        new Promise<void>((resolve) => {
          resolveReleaseWait = resolve;
        }),
    });
    const attempt = runLogin(
      "codex",
      { kind: "create", label: "Work profile" },
      fake.io,
    );

    await Promise.race([
      releaseStarted,
      attempt.then(() => {
        throw new Error("CLI sign-in ended before link release started.");
      }),
    ]);
    expect(fake.isInterruptListening()).toBe(false);
    resolveCancel();
    resolveReleaseWait();

    await expect(attempt).rejects.toBeInstanceOf(CliError);
    await expect(attempt).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_REQUEST_OUTCOME_UNKNOWN,
      message:
        "Sign-in may have completed. Check this profile before trying again.",
    });
    expect(callsTo("providers.link")).toHaveLength(1);
    expect(callsTo("providers.linkComplete")).toHaveLength(1);
    expect(callsTo("providers.list")).toHaveLength(2);
    expect(callsTo("providers.linkCancel")).toHaveLength(1);
  });

  it("keeps a connected sign-in pending when Ctrl+C interrupts inventory", async () => {
    let notifyInventoryStarted: () => void = () => {};
    const inventoryStarted = new Promise<void>((resolve) => {
      notifyInventoryStarted = resolve;
    });
    let resolveInventory: (
      profiles: readonly ProviderProfile[],
    ) => void = () => {};
    const pendingInventory = new Promise<readonly ProviderProfile[]>(
      (resolve) => {
        resolveInventory = resolve;
      },
    );
    makeHost({
      providerId: "codex",
      profiles: [],
      link: linkAnswer({ kind: "local_handoff" }),
      complete: () => completeAnswer("installing", null, null),
      laterProfiles: (listCall) => {
        if (listCall === 2) notifyInventoryStarted();
        return listCall === 2 ? pendingInventory : [];
      },
    });
    const fake = makeIo({ terminal: false });
    const run = runLogin(
      "codex",
      { kind: "create", label: "Work profile" },
      fake.io,
    );

    await Promise.race([
      inventoryStarted,
      run.then(() => {
        throw new Error("CLI sign-in ended before inventory started.");
      }),
    ]);
    expect(callsTo("providers.list")).toHaveLength(2);
    fake.interrupt();
    resolveInventory([]);
    const { result } = await run;

    expect(result.data).toEqual({
      providerId: "codex",
      status: "signed-in-pending",
    });
    expect(result.human).toBe(SIGNED_IN_RECEIVING_LINE);
    expect(result.exitCode).toBe(0);
    expect(callsTo("providers.linkCancel")).toEqual([]);
  });

  it("does not start a replacement link when Ctrl+C interrupts mismatch release", async () => {
    const selected = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Selected profile",
      ENVIRONMENT_PROFILE_ID,
    );
    let notifyCancelStarted: () => void = () => {};
    const cancelStarted = new Promise<void>((resolve) => {
      notifyCancelStarted = resolve;
    });
    let resolveCancel: () => void = () => {};
    const linkCancel = new Promise<LinkCancelResponse>((resolve) => {
      resolveCancel = () => resolve({});
    });
    let resolveReleaseWait: () => void = () => {};
    makeHost({
      providerId: "claude-code",
      profiles: [selected],
      link: linkAnswer(SIGN_IN_URL_PROMPT),
      complete: () =>
        completeAnswer("mismatch", null, "harness_account_mismatch"),
      onLinkCancel: notifyCancelStarted,
      linkCancel,
    });
    const fake = makeIo({
      terminal: true,
      lines: [CODE, "y"],
      wait: () =>
        new Promise<void>((resolve) => {
          resolveReleaseWait = resolve;
        }),
    });
    const run = runLogin(
      "claude",
      { kind: "existing", profile: MANAGED_PROFILE_ID },
      fake.io,
    );

    await Promise.race([
      cancelStarted,
      run.then(() => {
        throw new Error("CLI sign-in ended before link release started.");
      }),
    ]);
    fake.interrupt();
    resolveCancel();
    resolveReleaseWait();
    const { result } = await run;

    expect(result.data).toMatchObject({ status: "cancelled" });
    expect(result.exitCode).toBe(130);
    expect(callsTo("providers.link")).toHaveLength(1);
    expect(callsTo("providers.linkCancel")).toHaveLength(1);
    expect(callsTo("providers.linkComplete")).toHaveLength(1);
  });
});
