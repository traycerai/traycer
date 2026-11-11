import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AMBIENT_PROFILE_ID_SENTINEL } from "@traycer/protocol/host/agent/shared";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import {
  providersListResponseSchema,
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
  ACCOUNT_MISMATCH_SIGN_IN_LINE,
  REPLACE_PROFILE_ACCOUNT_LINE,
} from "../../../../shared/providers/environment-profile-sign-in";
import {
  callHostRpcWithDispatch,
  readLocalHostMethodVersion,
} from "../../internal/host-rpc";
import { noopLogger } from "../../logger";
import type { CommandContext, CommandResult } from "../../runner/runner";
import {
  buildProfileLoginCommand,
  type ProfileLoginIo,
  type ProfileLoginTarget,
} from "../profile-login";

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
  readonly laterProfiles?: (listCall: number) => readonly ProviderProfile[];
  readonly methodVersion?: (method: string) => SchemaVersion | null;
  readonly link?: ProvidersLinkResponseV12;
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
        return Promise.resolve({
          providers: [providerState(options.providerId, profiles)],
          native: null,
        });
      }
      case "environment.host.read":
        return Promise.resolve(ENVIRONMENT_BINDING);
      case "environment.status": {
        statusCalls += 1;
        return Promise.resolve(
          options.environmentStatus?.(statusCalls) ?? ENVIRONMENT_STATUS,
        );
      }
      case "providers.link":
        return Promise.resolve(options.link ?? linkAnswer(SIGN_IN_URL_PROMPT));
      case "providers.linkComplete":
        completeCalls += 1;
        return Promise.resolve(
          options.complete?.(completeCalls) ??
            completeAnswer("linked", null, null),
        );
      case "providers.linkCancel":
        return Promise.resolve({});
      case "providers.startLogin":
        return Promise.resolve(options.start ?? startAnswer());
      case "providers.awaitLogin":
        return Promise.resolve(options.await ?? awaitAnswer(initialState));
      case "providers.cancelLogin":
        return Promise.resolve({ cancelled: true });
      default:
        return Promise.reject(new Error(`Unexpected RPC ${method}`));
    }
  });
}

interface FakeIo {
  readonly io: ProfileLoginIo;
  readonly interrupt: () => void;
}

function makeIo(options: {
  readonly terminal: boolean;
  readonly lines?: readonly string[];
  readonly interruptOnWait?: boolean;
  readonly onWait?: (waitCalls: number) => void;
}): FakeIo {
  const interruptHandlers: (() => void)[] = [];
  const lines = [...(options.lines ?? [])];
  let interruptedDuringWait = false;
  let waitCalls = 0;
  const io: ProfileLoginIo = {
    newHolderId: () => "holder-environment-login",
    stdinIsTerminal: () => options.terminal,
    openUrl: () => undefined,
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
        interruptHandlers[0]?.();
      }
      return Promise.resolve();
    },
    onInterrupt: (handler) => {
      interruptHandlers.push(handler);
      return () => undefined;
    },
    readLines: (onLine) => {
      const line = lines.shift();
      if (line === undefined) return null;
      onLine(line);
      return () => undefined;
    },
  };
  return {
    io,
    interrupt: () => interruptHandlers[0]?.(),
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

  it("creates a Claude profile with its label, sharing disabled, and the pasted code", async () => {
    const admitted = profile(
      MANAGED_PROFILE_ID,
      "managed",
      "Claude local profile",
      ENVIRONMENT_PROFILE_ID,
    );
    makeHost({
      providerId: "claude-code",
      profiles: [],
      laterProfiles: () => [admitted],
      link: linkAnswer(SIGN_IN_URL_PROMPT),
      complete: () => completeAnswer("linked", null, null),
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
      profile: { profileId: MANAGED_PROFILE_ID },
    });
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

  it("keeps a connected existing profile pending through poll and inventory failures", async () => {
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
    let inventoryFailureObserved = false;
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
        if (callsTo("providers.list").length === 2) {
          expect(callsTo("providers.link")).toHaveLength(1);
          expect(humanRequired).not.toHaveBeenCalledWith(
            expect.stringContaining("Retry"),
          );
          inventoryFailureObserved = true;
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
    expect(callsTo("providers.list")).toHaveLength(3);
    expect(completionWaitsAfterErrors).toEqual([2, 3]);
    expect(inventoryFailureObserved).toBe(true);
    expect(result.data).toEqual({
      providerId: "claude-code",
      status: "signed-in",
      profile: {
        profileId: MANAGED_PROFILE_ID,
        label: "Selected profile",
        kind: "managed",
        email: null,
        enabled: true,
        authStatus: "authenticated",
        rateLimitStatus: "unknown",
      },
      created: false,
    });
    expect(humanRequired).not.toHaveBeenCalledWith(
      expect.stringContaining("Retry"),
    );
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

  it("uses the existing local flow for an existing profile on providers.link@1.1", async () => {
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
      methodVersion: (method) =>
        method === "providers.link" ? { major: 1, minor: 1 } : V12,
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
    expect(result.data).toMatchObject({
      status: "signed-in",
      created: false,
      profile: { profileId: MANAGED_PROFILE_ID },
    });
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
    expect(onlyCallTo("providers.linkCancel")[1]).toEqual({
      linkId: "link-attempt",
      environmentId: ENVIRONMENT_ID,
    });
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
      resolveComplete(response);
      const result = await run;

      expect(result.data).toEqual({
        providerId: "claude-code",
        status: "cancelled",
      });
      expect(result.exitCode).toBe(130);
      expect(callsTo("providers.linkComplete")).toHaveLength(1);
      expect(callsTo("providers.linkCancel")).toEqual([]);
    },
  );
});
