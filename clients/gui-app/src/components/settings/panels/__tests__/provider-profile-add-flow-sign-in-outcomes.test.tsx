// The Add dialog, through the real flow host, over a host client whose
// messenger answers providers.list / startLogin / awaitLogin / setEnabled.
// offersSignIns on the list is the only switch: absent and false keep today's
// dialog, true reads a completed sign-in's profileOutcome.
const clientMock = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);
let authServiceForTest: AuthService | null = null;

function currentAuthService(): AuthService {
  if (authServiceForTest === null) {
    throw new Error("sign-in request AuthService was not set up");
  }
  return authServiceForTest;
}

// The flow host reads `useHostClient` through the barrel, and Vite rewrites
// that re-export onto `@/lib/host/runtime`. Both have to answer the pinned
// client or the session throws before the dialog mounts.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => clientMock.current,
    useAuthService: currentAuthService,
  };
});
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    useHostClient: () => clientMock.current,
    useAuthService: currentAuthService,
  };
});
vi.mock("@/lib/links/open-link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/links/open-link")>();
  return {
    ...actual,
    useOpenLink: () => () => Promise.resolve(),
  };
});

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { AuthService } from "@/lib/auth/auth-service";
import type { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderLoginProfileOutcome,
  ProviderMutationCliStateV21,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  PROVIDER_PROFILE_ACCENT_COLORS,
  providersAwaitLoginResponseSchema,
} from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  profile,
  provider,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { ProviderProfileAddFlowHost } from "@/components/providers/provider-profile-add-flow-host";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { createProfileRecordAuthFixture } from "@/components/providers/__tests__/profile-record-auth-fixture";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useProviderProfileAddFlowStore } from "@/stores/settings/provider-profile-add-flow-store";
import { signInRequestAuthService } from "@/lib/auth/__tests__/provider-sign-in-request-test-support";
import {
  ENVIRONMENT_NOT_FOUND_SIGN_IN_REQUEST_REPLY,
  FORBIDDEN_SIGN_IN_REQUEST_REPLY,
  installSignInRequestFetchHarness,
  MOVE_ACCEPTANCE_CONFLICT_SIGN_IN_REQUEST_REPLY,
  noAnswerReply,
  RECORDED_SIGN_IN_REQUEST_REPLY,
  SIGN_IN_REQUEST_FIXTURE,
  UNAUTHORIZED_SIGN_IN_REQUEST_REPLY,
  type SignInRequestFetchHarness,
  type SignInRequestFetchReply,
} from "@traycer-clients/shared/test-fixtures/provider-sign-in-request-test-support";

const HOST_ID = "host-add-flow";
const PROFILE_ID = "work";
const PROFILE_LABEL = "Work";
const MINTED_PROFILE_ID = "minted-1";
const DID_NOT_FINISH = "Sign-in did not finish. Retry when you are ready.";
const WAITING = "Waiting for Traycer. Your sign-in is complete.";
const UNREADABLE = "Couldn't load provider state.";
const SIGNED_IN = `Signed in as ${PROFILE_LABEL}`;
const ALREADY_SIGNED_IN = `Already signed in as ${PROFILE_LABEL}`;
const PROFILE_RECORD_URL =
  "http://localhost:5005/api/v3/environments/environment-profile-fixture/profile-records/minted-1/name";
const LIST_KEY = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
  HOST_ID,
  "providers.list",
  { native: null },
);

type Offers = true | false | "absent";
type ListResponse = ResponseOfMethod<HostRpcRegistry, "providers.list">;
type StartResponse = ResponseOfMethod<HostRpcRegistry, "providers.startLogin">;
type AwaitResponse = ResponseOfMethod<HostRpcRegistry, "providers.awaitLogin">;
type SetEnabledResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.setEnabled"
>;

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

interface AddFlowHarness {
  readonly created: Mock<(profileId: string) => void>;
  readonly calls: RecordedCall[];
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly listsAfterAwait: () => number;
  readonly listCalls: () => number;
  readonly releaseListRefresh: () => void;
  readonly releaseRecolor: () => void;
  readonly signInFetch: SignInRequestFetchHarness | null;
  readonly updateProfileName: (profileId: string, name: string) => void;
}

let settleHeldRecolor: () => void = () => undefined;
let activeSignInFetch: SignInRequestFetchHarness | null = null;
const profileNameTransport = {
  onAccepted: (_name: string): void => undefined,
};

const ADD_FLOW_DEFAULTS = {
  echoedProfiles: undefined,
  listFailuresAfterAwait: 0,
  ownership: false,
  seedCache: false,
  cacheSeed: undefined,
  holdListRefresh: false,
  unknownProfileOutcome: false,
  failRecolor: false,
  freshlyLinkedProfile: false,
  awaitAnswers: [],
  authService: null,
  recordEnvironment: false,
} satisfies {
  readonly echoedProfiles: readonly ProviderProfile[] | undefined;
  readonly listFailuresAfterAwait: number;
  readonly ownership: boolean;
  readonly seedCache: boolean;
  readonly cacheSeed:
    | (ListResponse & { readonly futureKey: string })
    | undefined;
  readonly holdListRefresh: boolean;
  readonly unknownProfileOutcome: boolean;
  readonly failRecolor: boolean;
  readonly freshlyLinkedProfile: boolean;
  readonly awaitAnswers: readonly AwaitResponse[];
  readonly authService: AuthService | null;
  readonly recordEnvironment: boolean;
};

afterEach(() => {
  settleHeldRecolor();
  settleHeldRecolor = () => undefined;
  cleanup();
  activeSignInFetch?.restore();
  activeSignInFetch = null;
  authServiceForTest?.dispose();
  authServiceForTest = null;
  useAuthStore.getState().setSignedOut();
  vi.unstubAllGlobals();
  useProviderProfileAddFlowStore.getState().close();
  useDesktopDialogStore.setState({ reportIssueAvailable: false });
  clientMock.current = null;
  profileNameTransport.onAccepted = () => undefined;
  resetNegotiatedManifests();
});

function workProfile(): ProviderProfile {
  return {
    ...profile(PROFILE_ID, "managed"),
    label: PROFILE_LABEL,
    accentColor: "#f97316",
  };
}

function sameEmailRenameProfiles(): {
  readonly existing: ProviderProfile;
  readonly created: ProviderProfile;
} {
  return {
    existing: {
      ...workProfile(),
      profileId: "ambient",
      kind: "ambient",
      label: "Terminal account",
      identity: {
        email: "shared@example.test",
        tier: "Pro",
        accountUuid: null,
      },
      accentColor: PROVIDER_PROFILE_ACCENT_COLORS[0],
    },
    created: {
      ...workProfile(),
      profileId: MINTED_PROFILE_ID,
      label: "New profile",
      identity: {
        email: "shared@example.test",
        tier: "Team",
        accountUuid: null,
      },
      accentColor: PROVIDER_PROFILE_ACCENT_COLORS[1],
    },
  };
}

async function createAddProfileNameAuthFixture(denied: boolean) {
  return createProfileRecordAuthFixture((request) => {
    if (request.url !== PROFILE_RECORD_URL) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (denied) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            statusCode: 403,
            error: "private response detail",
            code: "environment_action_forbidden",
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }
    profileNameTransport.onAccepted("Personal");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          profileId: MINTED_PROFILE_ID,
          harnessId: "claude",
          recordRevision: "18",
          name: "Personal",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  });
}

function projectedWorkProfile(): ProviderProfile {
  return {
    ...workProfile(),
    aliases: ["legacy-work"],
    otherNames: ["Claude account"],
    personNotice: "waiting",
  };
}

function listBody(
  offers: Offers,
  profiles: readonly ProviderProfile[],
): ListResponse {
  const body: ListResponse = {
    providers: [provider("claude-code", [...profiles])],
    native: null,
  };
  if (offers === "absent") return body;
  return { ...body, offersSignIns: offers };
}

function startedBody(): StartResponse {
  return {
    url: "https://example.test/sign-in",
    started: true,
    profileId: "minted-1",
    userCode: null,
    failure: null,
    pending: null,
    pack: null,
    targetRefusal: null,
  };
}

/** Old keys as they are when the sign-in changed nothing. */
function nothingChanged(
  outcome: ProviderLoginProfileOutcome | null,
): AwaitResponse {
  return {
    state: null,
    existingProfileId: null,
    codeRejected: false,
    refusal: null,
    installation: null,
    profileOutcome: outcome,
  };
}

function asksToRecordSignIn(): AwaitResponse {
  return {
    ...nothingChanged(null),
    signInRequest: SIGN_IN_REQUEST_FIXTURE,
  };
}

function setEnabledEcho(): SetEnabledResponse {
  const state: ProviderMutationCliStateV21 = {
    providerId: "claude-code",
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
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
  return { state };
}

/** The answer's own rows, authenticated, so old keys would call this signed in. */
function echoedAwait(
  outcome: ProviderLoginProfileOutcome | null,
  echoed: readonly ProviderProfile[],
): AwaitResponse {
  const base = setEnabledEcho().state;
  const first = echoed.at(0);
  return {
    state: {
      ...base,
      auth: {
        status: "authenticated",
        badgeText: null,
        label: null,
        detail: null,
      },
      profiles: [...echoed],
    },
    existingProfileId: first === undefined ? null : first.profileId,
    codeRejected: false,
    refusal: null,
    installation: null,
    profileOutcome: outcome,
  };
}

function renderAddFlow(input: {
  readonly offers: Offers;
  readonly profilesBefore: readonly ProviderProfile[];
  readonly profilesAfter: readonly ProviderProfile[];
  readonly outcome: ProviderLoginProfileOutcome | null;
  /** When set, the await answer carries these rows. Omitted keeps state null. */
  readonly echoedProfiles: readonly ProviderProfile[] | undefined;
  /** How many providers.list calls after the await reject before one succeeds. */
  readonly listFailuresAfterAwait: number;
  /** Record the login-ownership manifest before the dialog mounts. */
  readonly ownership: boolean;
  /** Seed a fresh providers.list entry so opening the dialog only reads it. */
  readonly seedCache: boolean;
  readonly cacheSeed:
    | (ListResponse & { readonly futureKey: string })
    | undefined;
  /** Leave the first post-await list request pending until the test releases it. */
  readonly holdListRefresh: boolean;
  readonly unknownProfileOutcome: boolean;
  readonly failRecolor: boolean;
  readonly freshlyLinkedProfile: boolean;
  readonly awaitAnswers: readonly AwaitResponse[];
  readonly authService: AuthService | null;
  readonly recordEnvironment: boolean;
}): AddFlowHarness {
  const calls: RecordedCall[] = [];
  const created = vi.fn<(profileId: string) => void>();
  let awaitStarted = false;
  let awaitAnswerIndex = 0;
  let listsAfterAwait = 0;
  let listCalls = 0;
  let release: ((value: SetEnabledResponse) => void) | null = null;
  let releaseList: (() => void) | null = null;
  let profilesAfter = input.profilesAfter;
  let released = false;
  const failuresAfterAwait = input.listFailuresAfterAwait;
  const { client, messenger } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.list": () => {
        listCalls += 1;
        if (awaitStarted) {
          listsAfterAwait += 1;
          if (listsAfterAwait <= failuresAfterAwait) {
            throw new Error("providers.list failed");
          }
          if (input.holdListRefresh && listsAfterAwait === 1) {
            return new Promise<ListResponse>((resolve) => {
              releaseList = () =>
                resolve(listBody(input.offers, input.profilesAfter));
            });
          }
        }
        return listBody(
          input.offers,
          awaitStarted ? profilesAfter : input.profilesBefore,
        );
      },
      "providers.startLogin": (params) => {
        calls.push({ method: "providers.startLogin", params });
        return startedBody();
      },
      "providers.awaitLogin": () => {
        calls.push({ method: "providers.awaitLogin", params: null });
        awaitStarted = true;
        if (awaitAnswerIndex < input.awaitAnswers.length) {
          const scriptedAnswer = input.awaitAnswers[awaitAnswerIndex];
          awaitAnswerIndex += 1;
          return scriptedAnswer;
        }
        awaitAnswerIndex += 1;
        const echoedAnswer =
          input.echoedProfiles === undefined
            ? nothingChanged(input.outcome)
            : echoedAwait(input.outcome, input.echoedProfiles);
        const answer = input.freshlyLinkedProfile
          ? { ...echoedAnswer, existingProfileId: null }
          : echoedAnswer;
        if (input.unknownProfileOutcome) {
          Object.defineProperty(answer, "profileOutcome", {
            value: { kind: "future-kind" },
            enumerable: true,
          });
          return providersAwaitLoginResponseSchema.parse(answer);
        }
        return answer;
      },
      "providers.setEnabled": (params) => {
        calls.push({ method: "providers.setEnabled", params });
        const profileAction = params.profileAction;
        if (profileAction?.type === "rename") {
          profilesAfter = profilesAfter.map((profile) =>
            profile.profileId === profileAction.profileId
              ? { ...profile, label: profileAction.label }
              : profile,
          );
          return setEnabledEcho();
        }
        if (input.failRecolor) {
          throw new Error("providers.setEnabled recolor failed");
        }
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      "providers.cancelLogin": (params) => {
        calls.push({ method: "providers.cancelLogin", params });
        return { cancelled: true };
      },
      "environment.status": () =>
        environmentStatusFixture({ principal: { kind: "personal" } }),
      "environment.host.read": () => ({
        hostId: HOST_ID,
        environment: {
          environmentId: "environment-profile-fixture",
          ownerKind: "user",
          ownerId: "test-owner",
          roomId: "test-room",
          label: "Personal",
        },
        explicit: false,
        enrolledByUserId: null,
        canUnbind: false,
        sharingGeneration: null,
      }),
    },
  });
  clientMock.current = client;
  let signInFetch: SignInRequestFetchHarness | null = null;
  if (input.authService === null) {
    signInFetch = installSignInRequestFetchHarness();
    activeSignInFetch = signInFetch;
    authServiceForTest = signInRequestAuthService(signInFetch.client);
  } else {
    authServiceForTest = input.authService;
  }
  if (input.ownership || input.recordEnvironment) {
    recordNegotiatedHostManifest(HOST_ID, {
      ...(input.ownership
        ? {
            "providers.startLogin": { major: 1, minor: 4 },
            "providers.cancelLogin": { major: 1, minor: 2 },
          }
        : {}),
      ...(input.recordEnvironment
        ? {
            "environment.status": { major: 1, minor: 2 },
            "environment.host.read": { major: 1, minor: 1 },
          }
        : {}),
    });
  }
  settleHeldRecolor = () => {
    if (released) return;
    released = true;
    release?.(setEnabledEcho());
  };
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  if (input.seedCache) {
    queryClient.setQueryData(
      LIST_KEY,
      input.cacheSeed ?? listBody(input.offers, input.profilesBefore),
    );
  }
  useProviderProfileAddFlowStore
    .getState()
    .openForHarness("claude", null, created);
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProviderProfileAddFlowHost />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return {
    created,
    calls,
    messenger,
    queryClient,
    listsAfterAwait: () => listsAfterAwait,
    listCalls: () => listCalls,
    releaseListRefresh: () => {
      if (releaseList === null) {
        throw new Error("providers.list refresh was not held");
      }
      releaseList();
    },
    releaseRecolor: () => {
      if (release === null) {
        throw new Error("providers.setEnabled was not called");
      }
      if (released) return;
      released = true;
      release(setEnabledEcho());
    },
    signInFetch,
    updateProfileName: (profileId, name) => {
      profilesAfter = profilesAfter.map((profile) =>
        profile.profileId === profileId ? { ...profile, label: name } : profile,
      );
    },
  };
}

function signInFetchFor(harness: AddFlowHarness): SignInRequestFetchHarness {
  if (harness.signInFetch === null) {
    throw new Error("sign-in request fetch harness was not installed");
  }
  return harness.signInFetch;
}

function methodCount(
  calls: readonly { readonly method: string }[],
  method: string,
): number {
  return calls.filter((call) => call.method === method).length;
}

function startCreateProfile(
  params: unknown,
): { readonly label: string; readonly shareSkillsAndPlugins: boolean } | null {
  if (
    typeof params !== "object" ||
    params === null ||
    !("createProfile" in params)
  ) {
    return null;
  }
  const createProfile = params.createProfile;
  if (
    typeof createProfile !== "object" ||
    createProfile === null ||
    !("label" in createProfile) ||
    !("shareSkillsAndPlugins" in createProfile) ||
    typeof createProfile.label !== "string" ||
    typeof createProfile.shareSkillsAndPlugins !== "boolean"
  ) {
    return null;
  }
  return {
    label: createProfile.label,
    shareSkillsAndPlugins: createProfile.shareSkillsAndPlugins,
  };
}

async function pressAccount(offers: Offers): Promise<void> {
  const name = offers === true ? "Sign in" : "Link account";
  fireEvent.click(await screen.findByRole("button", { name }));
}

async function expectSignedInDecision(
  harness: AddFlowHarness,
): Promise<number> {
  expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
  const decisionReads = harness.listsAfterAwait();
  expect(harness.created).not.toHaveBeenCalled();
  expect(methodCount(harness.calls, "providers.setEnabled")).toBe(1);
  return decisionReads;
}

async function chooseSignedIn(
  harness: AddFlowHarness,
  decisionReads: number,
): Promise<void> {
  act(() => {
    harness.releaseRecolor();
  });
  await waitFor(() => {
    expect(harness.created).toHaveBeenCalledWith(PROFILE_ID);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  // Today's providers.list read after providers.setEnabled succeeds is the recolor's.
  expect(harness.listsAfterAwait()).toBe(decisionReads + 1);
}

function expectNoSuccessSentence(): void {
  expect(screen.queryByText(SIGNED_IN)).toBeNull();
  expect(screen.queryByText(ALREADY_SIGNED_IN)).toBeNull();
  expect(screen.queryByText(WAITING)).toBeNull();
  expect(screen.queryByText("Account already linked")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
}

/** providers.cancelLogin for this provider, or null when the call is absent. */
function cancelHolderId(params: unknown): string | null {
  if (
    typeof params !== "object" ||
    params === null ||
    !("providerId" in params) ||
    !("holderId" in params) ||
    params.providerId !== "claude-code" ||
    typeof params.holderId !== "string" ||
    params.holderId.length === 0
  ) {
    return null;
  }
  return params.holderId;
}

function renamedLabel(params: unknown): string | null {
  if (
    typeof params !== "object" ||
    params === null ||
    !("profileAction" in params)
  ) {
    return null;
  }
  const action = params.profileAction;
  if (
    typeof action !== "object" ||
    action === null ||
    !("type" in action) ||
    action.type !== "rename" ||
    !("label" in action) ||
    typeof action.label !== "string"
  ) {
    return null;
  }
  return action.label;
}

function setEnabledActionDetails(params: unknown): {
  readonly label: string | null;
  readonly accentColor: string | null;
} | null {
  if (
    typeof params !== "object" ||
    params === null ||
    !("profileAction" in params)
  ) {
    return null;
  }
  const action = params.profileAction;
  if (typeof action !== "object" || action === null) return null;
  let label: string | null = null;
  let accentColor: string | null = null;
  if ("label" in action && typeof action.label === "string") {
    label = action.label;
  }
  if ("accentColor" in action && typeof action.accentColor === "string") {
    accentColor = action.accentColor;
  }
  if (label === null && accentColor === null) return null;
  return { label, accentColor };
}

async function expectAddDidNotFinish(harness: AddFlowHarness): Promise<void> {
  useDesktopDialogStore.setState({ reportIssueAvailable: true });
  expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(
    await screen.findByRole("button", { name: "Report issue" }),
  ).toBeTruthy();
  expectNoSuccessSentence();
  expect(harness.created).not.toHaveBeenCalled();
  const cancel = harness.calls.find(
    (call) => call.method === "providers.cancelLogin",
  );
  expect(cancelHolderId(cancel?.params)).toEqual(expect.any(String));
}

function mintedSignedInRow(): ProviderProfile {
  return { ...workProfile(), profileId: MINTED_PROFILE_ID };
}

const ADD_MISFITS = [
  { label: "account-mismatch", outcome: { kind: "account-mismatch" } },
  { label: "account-unproven", outcome: { kind: "account-unproven" } },
  {
    label: "target-refused",
    outcome: { kind: "target-refused", reason: "not-authorized" },
  },
  {
    label: "staged-for-leave",
    outcome: { kind: "staged-for-leave", profileId: MINTED_PROFILE_ID },
  },
] as const satisfies ReadonlyArray<{
  readonly label: string;
  readonly outcome: ProviderLoginProfileOutcome;
}>;

describe("Add a profile around one sign-in", () => {
  it("titles the dialog Add a profile and offers Sign in when the list offers sign-ins", async () => {
    renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: null,
    });
    expect(
      await screen.findByRole("heading", { name: "Add a profile" }),
    ).toBeTruthy();
    const signIn = screen.getByRole("button", { name: "Sign in" });
    expect(signIn.textContent).toContain("Sign in");
    expect(
      screen.queryByRole("heading", { name: "Add new Claude Code profile" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Link account" })).toBeNull();
  });

  it("keeps today's title and Link account when offersSignIns is false", async () => {
    renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: false,
      profilesBefore: [],
      profilesAfter: [],
      outcome: null,
    });
    expect(
      await screen.findByRole("heading", {
        name: "Add new Claude Code profile",
      }),
    ).toBeTruthy();
    const link = screen.getByRole("button", { name: "Link account" });
    expect(link.textContent).toContain("Link account");
    expect(screen.queryByRole("heading", { name: "Add a profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("keeps today's title and Link account when offersSignIns is absent", async () => {
    renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: "absent",
      profilesBefore: [],
      profilesAfter: [],
      outcome: null,
    });
    expect(
      await screen.findByRole("heading", {
        name: "Add new Claude Code profile",
      }),
    ).toBeTruthy();
    const link = screen.getByRole("button", { name: "Link account" });
    expect(link.textContent).toContain("Link account");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("names the signed-in profile that the list already has, then chooses it", async () => {
    const row = workProfile();
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [row],
      profilesAfter: [row],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
    });
    await pressAccount(true);
    const decisionReads = await expectSignedInDecision(harness);
    await chooseSignedIn(harness, decisionReads);
  });

  it("names a signed-in profile that arrives on the re-read", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [workProfile()],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      seedCache: true,
    });
    await pressAccount(true);
    const decisionReads = await expectSignedInDecision(harness);
    expect(decisionReads).toBe(1);
    await chooseSignedIn(harness, decisionReads);
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(2);
  });

  it("reads providers.list once when the signed-in profile already has the chosen accent", async () => {
    const row: ProviderProfile = {
      ...workProfile(),
      accentColor: "#ef4444",
    };
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [row],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      seedCache: true,
    });
    await pressAccount(true);
    await waitFor(() => {
      expect(harness.created).toHaveBeenCalledWith(PROFILE_ID);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
    expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
      1,
    );
    expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
      1,
    );
    expect(methodCount(harness.messenger.calls, "providers.cancelLogin")).toBe(
      0,
    );
    expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
  });

  it("says signed in when the profile color save fails after sign-in", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [workProfile()],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      seedCache: true,
      failRecolor: true,
    });
    await pressAccount(true);

    expect(
      await screen.findByText(
        "The account was signed in, but the profile color could not be saved.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "The account was linked, but the profile color could not be saved.",
      ),
    ).toBeNull();
    expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
      1,
    );
    expect(harness.created).not.toHaveBeenCalled();
  });

  it("says signed in when the profile color save fails after naming", async () => {
    const { existing, created } = sameEmailRenameProfiles();
    const auth = await createAddProfileNameAuthFixture(false);
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [existing],
      profilesAfter: [existing, created],
      outcome: { kind: "signed-in", profileId: MINTED_PROFILE_ID },
      echoedProfiles: [existing, created],
      seedCache: true,
      failRecolor: true,
      authService: auth.service,
      recordEnvironment: true,
    });
    profileNameTransport.onAccepted = (name) =>
      harness.updateProfileName(MINTED_PROFILE_ID, name);
    await pressAccount(true);
    expect(
      await screen.findByText(
        "Terminal account already uses this email. Name this profile so you can tell them apart.",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Personal" },
    });
    const pickedColor = PROVIDER_PROFILE_ACCENT_COLORS[2];
    expect(pickedColor).not.toBe(created.accentColor);
    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${pickedColor}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(
      await screen.findByText(
        "The account was signed in, but the profile color could not be saved.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "The account was linked, but the profile color could not be saved.",
      ),
    ).toBeNull();
    expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
      1,
    );
    expect(
      harness.calls
        .filter((call) => call.method === "providers.setEnabled")
        .map((call) => setEnabledActionDetails(call.params)),
    ).toEqual([{ label: null, accentColor: pickedColor }]);
    expect(auth.requests).toEqual([
      {
        url: PROFILE_RECORD_URL,
        method: "POST",
        body: JSON.stringify({ harnessId: "claude", name: "Personal" }),
      },
    ]);
    expect(harness.created).not.toHaveBeenCalled();
  });

  it("keeps linked copy when the profile color save fails without sign-in offers", async () => {
    const linked = mintedSignedInRow();
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: false,
      profilesBefore: [],
      profilesAfter: [linked],
      outcome: null,
      echoedProfiles: [linked],
      failRecolor: true,
      freshlyLinkedProfile: true,
    });
    await pressAccount(false);
    await waitFor(() => {
      expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
        1,
      );
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
      expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
        1,
      );
    });

    expect(
      await screen.findByText(
        "The account was linked, but the profile color could not be saved.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "The account was signed in, but the profile color could not be saved.",
      ),
    ).toBeNull();
    expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
      1,
    );
    expect(harness.created).not.toHaveBeenCalled();
  });

  it("names a same-email signed-in profile through the app with exactly two providers.list reads", async () => {
    const { existing, created } = sameEmailRenameProfiles();
    const auth = await createAddProfileNameAuthFixture(false);
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [existing],
      profilesAfter: [existing, created],
      outcome: { kind: "signed-in", profileId: MINTED_PROFILE_ID },
      echoedProfiles: [existing, created],
      seedCache: true,
      authService: auth.service,
      recordEnvironment: true,
    });
    profileNameTransport.onAccepted = (name) =>
      harness.updateProfileName(MINTED_PROFILE_ID, name);
    await pressAccount(true);
    expect(
      await screen.findByText(
        "Terminal account already uses this email. Name this profile so you can tell them apart.",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Personal" },
    });
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => {
      expect(harness.created).toHaveBeenCalledWith(MINTED_PROFILE_ID);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(methodCount(harness.messenger.calls, "providers.list")).toBe(2);
    });
    expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
      1,
    );
    expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
      1,
    );
    expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
      0,
    );
    expect(auth.requests).toEqual([
      {
        url: PROFILE_RECORD_URL,
        method: "POST",
        body: JSON.stringify({ harnessId: "claude", name: "Personal" }),
      },
    ]);
    expect(harness.queryClient.getQueryData(LIST_KEY)).toEqual(
      listBody(true, [existing, { ...created, label: "Personal" }]),
    );
    expect(
      methodCount(harness.messenger.calls, "environment.status"),
    ).toBeGreaterThan(0);
    expect(
      methodCount(harness.messenger.calls, "environment.host.read"),
    ).toBeGreaterThan(0);
    expect(methodCount(harness.messenger.calls, "providers.cancelLogin")).toBe(
      0,
    );
  });

  it("names and recolors a same-email signed-in profile with exactly three providers.list reads", async () => {
    const { existing, created } = sameEmailRenameProfiles();
    const auth = await createAddProfileNameAuthFixture(false);
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [existing],
      profilesAfter: [existing, created],
      outcome: { kind: "signed-in", profileId: MINTED_PROFILE_ID },
      echoedProfiles: [existing, created],
      seedCache: true,
      authService: auth.service,
      recordEnvironment: true,
    });
    profileNameTransport.onAccepted = (name) =>
      harness.updateProfileName(MINTED_PROFILE_ID, name);
    await pressAccount(true);
    expect(
      await screen.findByText(
        "Terminal account already uses this email. Name this profile so you can tell them apart.",
      ),
    ).toBeTruthy();
    expect(harness.listsAfterAwait()).toBe(1);
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);

    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Personal" },
    });
    const pickedColor = PROVIDER_PROFILE_ACCENT_COLORS[2];
    expect(pickedColor).not.toBe(existing.accentColor);
    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${pickedColor}` }),
    );
    expect(harness.listsAfterAwait()).toBe(1);
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => {
      expect(methodCount(harness.calls, "providers.setEnabled")).toBe(1);
      expect(methodCount(harness.messenger.calls, "providers.list")).toBe(2);
    });
    expect(harness.listsAfterAwait()).toBe(2);
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(2);
    const setEnabledCalls = harness.calls.filter(
      (call) => call.method === "providers.setEnabled",
    );
    expect(
      setEnabledCalls.map((call) => setEnabledActionDetails(call.params)),
    ).toEqual([{ label: null, accentColor: pickedColor }]);
    expect(auth.requests).toEqual([
      {
        url: PROFILE_RECORD_URL,
        method: "POST",
        body: JSON.stringify({ harnessId: "claude", name: "Personal" }),
      },
    ]);

    harness.releaseRecolor();
    await waitFor(() => {
      expect(harness.created).toHaveBeenCalledWith(MINTED_PROFILE_ID);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(methodCount(harness.messenger.calls, "providers.list")).toBe(3);
    });
    expect(harness.listsAfterAwait()).toBe(3);
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(3);
    expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
      1,
    );
    expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
      1,
    );
    expect(methodCount(harness.messenger.calls, "providers.cancelLogin")).toBe(
      0,
    );
  });

  it("keeps a legacy authenticated profile name on the computer rename path", async () => {
    const { existing, created } = sameEmailRenameProfiles();
    const auth = await createAddProfileNameAuthFixture(true);
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [existing],
      profilesAfter: [existing, created],
      outcome: null,
      echoedProfiles: [existing, created],
      freshlyLinkedProfile: true,
      seedCache: true,
      authService: auth.service,
    });
    await pressAccount(true);
    expect(
      await screen.findByText(
        "Terminal account already uses this email. Name this profile so you can tell them apart.",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Personal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => {
      expect(harness.created).toHaveBeenCalledWith(MINTED_PROFILE_ID);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
        1,
      );
    });
    expect(
      harness.calls
        .filter((call) => call.method === "providers.setEnabled")
        .map((call) => renamedLabel(call.params)),
    ).toEqual(["Personal"]);
    expect(auth.requests).toEqual([]);
    expect(methodCount(harness.messenger.calls, "environment.status")).toBe(0);
    expect(methodCount(harness.messenger.calls, "environment.host.read")).toBe(
      0,
    );
  });

  it("shows the existing name refusal without exposing the response detail", async () => {
    const { existing, created } = sameEmailRenameProfiles();
    const auth = await createAddProfileNameAuthFixture(true);
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [existing],
      profilesAfter: [existing, created],
      outcome: { kind: "signed-in", profileId: MINTED_PROFILE_ID },
      echoedProfiles: [existing, created],
      seedCache: true,
      authService: auth.service,
      recordEnvironment: true,
    });
    await pressAccount(true);
    expect(
      await screen.findByText(
        "Terminal account already uses this email. Name this profile so you can tell them apart.",
      ),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Personal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(
      await screen.findByText("Couldn't save the name. Try again."),
    ).toBeTruthy();
    expect(screen.queryByText("private response detail")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Profile name" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeTruthy();
    expect(harness.created).not.toHaveBeenCalled();
    expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
      0,
    );
    expect(auth.requests).toEqual([
      {
        url: PROFILE_RECORD_URL,
        method: "POST",
        body: JSON.stringify({ harnessId: "claude", name: "Personal" }),
      },
    ]);
    await waitFor(() => {
      expect(methodCount(harness.messenger.calls, "providers.list")).toBe(2);
    });
  });

  it("waits, with Done, when the signed-in id is still absent after one re-read", async () => {
    const auth = await createAddProfileNameAuthFixture(true);
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      authService: auth.service,
    });
    await pressAccount(true);
    expect(await screen.findByText(WAITING)).toBeTruthy();
    expect(harness.listsAfterAwait()).toBe(1);
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
    expect(harness.created).not.toHaveBeenCalled();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    expect(methodCount(harness.messenger.calls, "providers.setEnabled")).toBe(
      0,
    );
    expect(auth.requests).toEqual([]);
  });

  it("offers Use for an account that already has a profile, without recoloring it", async () => {
    const row = workProfile();
    const auth = await createAddProfileNameAuthFixture(true);
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [row],
      profilesAfter: [row],
      outcome: { kind: "already-signed-in", profileId: PROFILE_ID },
      authService: auth.service,
    });
    await pressAccount(true);
    expect(await screen.findByText(ALREADY_SIGNED_IN)).toBeTruthy();
    expect(harness.listsAfterAwait()).toBe(1);
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(2);
    expect(screen.queryByText("Account already linked")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
    expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    await waitFor(() => {
      expect(harness.created).toHaveBeenCalledWith(PROFILE_ID);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(harness.listsAfterAwait()).toBe(1);
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(2);
    expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
    expect(auth.requests).toEqual([]);
  });

  it("starts another sign-in at once from an account that already has a profile", async () => {
    const row = workProfile();
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [row],
      profilesAfter: [row],
      outcome: { kind: "already-signed-in", profileId: PROFILE_ID },
    });
    await pressAccount(true);
    expect(await screen.findByText(ALREADY_SIGNED_IN)).toBeTruthy();
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with another" }),
    );
    await waitFor(() => {
      expect(methodCount(harness.calls, "providers.startLogin")).toBe(2);
    });
    const second = harness.calls.filter(
      (call) => call.method === "providers.startLogin",
    )[1];
    expect(startCreateProfile(second.params)).toEqual({
      label: "New profile",
      shareSkillsAndPlugins: true,
    });
    expect(harness.created).not.toHaveBeenCalled();
    expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
  });

  it("waits when an already-signed-in id is absent after the re-read", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: { kind: "already-signed-in", profileId: PROFILE_ID },
    });
    await pressAccount(true);
    expect(await screen.findByText(WAITING)).toBeTruthy();
    expect(screen.queryByText(ALREADY_SIGNED_IN)).toBeNull();
    expect(screen.queryByRole("button", { name: "Use" })).toBeNull();
    expect(harness.created).not.toHaveBeenCalled();
  });

  it.each(["Done", "Close", "Escape"] as const)(
    "closing a waiting-for-profile footer by %s sends no cancelLogin",
    async (how) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [],
        profilesAfter: [],
        outcome: { kind: "waiting-for-profile" },
      });
      await pressAccount(true);
      expect(await screen.findByText(WAITING)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
      if (how === "Escape") {
        fireEvent.keyDown(document, { key: "Escape" });
      } else {
        fireEvent.click(screen.getByRole("button", { name: how }));
      }
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(methodCount(harness.calls, "providers.cancelLogin")).toBe(0);
      expect(harness.created).not.toHaveBeenCalled();
    },
  );

  it.each(ADD_MISFITS)(
    "ends $label on today's unfinished sign-in when the old keys are empty",
    async ({ outcome }) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [],
        profilesAfter: [],
        outcome,
        ownership: true,
      });
      await pressAccount(true);
      await expectAddDidNotFinish(harness);
    },
  );

  it.each(ADD_MISFITS)(
    "ends $label on today's unfinished sign-in when the old keys say signed in",
    async ({ outcome }) => {
      const signedIn = mintedSignedInRow();
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [],
        profilesAfter: [],
        outcome,
        echoedProfiles: [signedIn],
        ownership: true,
      });
      await pressAccount(true);
      await expectAddDidNotFinish(harness);
    },
  );

  it("names a signed-in profile from the answer's own rows when the re-read does not", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      echoedProfiles: [workProfile()],
    });
    await pressAccount(true);
    const decisionReads = await expectSignedInDecision(harness);
    expect(decisionReads).toBe(1);
    expect(harness.queryClient.getQueryData(LIST_KEY)).toEqual(
      listBody(true, []),
    );
    await chooseSignedIn(harness, decisionReads);
    expect(harness.queryClient.getQueryData(LIST_KEY)).toEqual(
      listBody(true, []),
    );
  });

  it("does not offer naming for an already-signed-in profile from the answer's own rows", async () => {
    const auth = await createAddProfileNameAuthFixture(true);
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: { kind: "already-signed-in", profileId: PROFILE_ID },
      echoedProfiles: [workProfile()],
      authService: auth.service,
    });
    await pressAccount(true);
    expect(await screen.findByText(ALREADY_SIGNED_IN)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
    expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
    expect(harness.listsAfterAwait()).toBe(1);
    expect(harness.created).not.toHaveBeenCalled();
    expect(auth.requests).toEqual([]);
    expect(harness.queryClient.getQueryData(LIST_KEY)).toEqual(
      listBody(true, []),
    );
  });

  it("names the profile after Retry when the re-read failed and then lists it", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [workProfile()],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      listFailuresAfterAwait: 1,
    });
    await pressAccount(true);
    expect(await screen.findByText(UNREADABLE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.queryByText(DID_NOT_FINISH)).toBeNull();
    expect(screen.queryByText(WAITING)).toBeNull();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    expect(harness.listsAfterAwait()).toBe(1);
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const decisionReads = await expectSignedInDecision(harness);
    expect(decisionReads).toBe(2);
    await chooseSignedIn(harness, decisionReads);
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    expect(harness.listsAfterAwait()).toBe(3);
  });

  it("waits after Retry when the re-read failed and then still lacks the profile", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      listFailuresAfterAwait: 1,
    });
    await pressAccount(true);
    expect(await screen.findByText(UNREADABLE)).toBeTruthy();
    expect(harness.listsAfterAwait()).toBe(1);
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(WAITING)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByText(UNREADABLE)).toBeNull();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    expect(harness.listsAfterAwait()).toBe(2);
    expect(harness.created).not.toHaveBeenCalled();
  });

  it("keeps the unreadable footer when Retry cannot read the list", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [workProfile()],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      listFailuresAfterAwait: 3,
    });
    await pressAccount(true);
    expect(await screen.findByText(UNREADABLE)).toBeTruthy();
    expect(harness.listsAfterAwait()).toBe(1);
    const startsBeforeRetry = methodCount(
      harness.calls,
      "providers.startLogin",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(harness.listsAfterAwait()).toBe(2);
    });
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(
      startsBeforeRetry,
    );
    expect(screen.getByText(UNREADABLE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(harness.listsAfterAwait()).toBe(3);
    });
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(
      startsBeforeRetry,
    );
    expect(screen.getByText(UNREADABLE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(DID_NOT_FINISH)).toBeNull();
    expect(screen.queryByText(WAITING)).toBeNull();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    expect(harness.created).not.toHaveBeenCalled();
  });

  it.each(["Close", "Escape"] as const)(
    "closing a list-unread footer by %s sends no cancelLogin",
    async (how) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [],
        profilesAfter: [],
        outcome: { kind: "signed-in", profileId: PROFILE_ID },
        listFailuresAfterAwait: 2,
      });
      await pressAccount(true);
      expect(await screen.findByText(UNREADABLE)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
      expect(screen.queryByText(DID_NOT_FINISH)).toBeNull();
      expect(screen.queryByText(WAITING)).toBeNull();
      expect(screen.queryByText(SIGNED_IN)).toBeNull();
      if (how === "Escape") {
        fireEvent.keyDown(document, { key: "Escape" });
      } else {
        fireEvent.click(screen.getByRole("button", { name: how }));
      }
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(methodCount(harness.calls, "providers.cancelLogin")).toBe(0);
      expect(harness.created).not.toHaveBeenCalled();
    },
  );

  it("reads no providers.list when Add a profile opens over a fresh cache", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: null,
      seedCache: true,
    });
    expect(
      await screen.findByRole("heading", { name: "Add a profile" }),
    ).toBeTruthy();
    expect(harness.listCalls()).toBe(0);
  });

  it("reads no providers.list when today's Add dialog opens over a fresh cache", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: false,
      profilesBefore: [],
      profilesAfter: [],
      outcome: null,
      seedCache: true,
    });
    expect(
      await screen.findByRole("heading", {
        name: "Add new Claude Code profile",
      }),
    ).toBeTruthy();
    expect(harness.listCalls()).toBe(0);
  });

  it("refetches providers.list once when a sign-in answer carries state", async () => {
    const row = workProfile();
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [row],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
      echoedProfiles: [row],
    });
    await pressAccount(true);
    const decisionReads = await expectSignedInDecision(harness);
    expect(decisionReads).toBe(1);
    expect(harness.queryClient.getQueryData(LIST_KEY)).toEqual(
      listBody(true, [row]),
    );
    await chooseSignedIn(harness, decisionReads);
  });

  it("keeps offersSignIns after a signed-in echo misses the row and its refresh fails", async () => {
    const projected = projectedWorkProfile();
    const removedProfiles = [
      {
        providerId: "claude-code",
        profileId: "removed-work",
        aliases: ["old-work"],
      },
    ];
    const cacheSeed = {
      ...listBody(true, [projected]),
      removedProfiles,
      futureKey: "kept",
    };
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [projected],
      profilesAfter: [],
      outcome: { kind: "signed-in", profileId: MINTED_PROFILE_ID },
      echoedProfiles: [],
      listFailuresAfterAwait: 1,
      seedCache: true,
      cacheSeed,
    });
    await pressAccount(true);
    expect(await screen.findByText(UNREADABLE)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Add a profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
    expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
      1,
    );
    expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
      1,
    );
    expect(methodCount(harness.messenger.calls, "providers.cancelLogin")).toBe(
      0,
    );
    const cached = harness.queryClient.getQueryData<
      ListResponse & { readonly futureKey: string }
    >(LIST_KEY);
    if (cached === undefined)
      throw new Error("The provider list cache is missing");
    expect(cached.offersSignIns).toBe(true);
    expect(cached.removedProfiles).toEqual(removedProfiles);
    expect(cached.futureKey).toBe("kept");
  });

  it("keeps unknown envelope and projection fields through the await overlay before its refresh settles", async () => {
    const projected = projectedWorkProfile();
    const auth = await createAddProfileNameAuthFixture(true);
    const removedProfiles = [
      {
        providerId: "claude-code",
        profileId: "removed-work",
        aliases: ["old-work"],
      },
    ];
    const cacheSeed = {
      ...listBody(true, [projected]),
      removedProfiles,
      futureKey: "kept",
    };
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [projected],
      profilesAfter: [projected],
      outcome: { kind: "waiting-for-profile" },
      echoedProfiles: [workProfile()],
      seedCache: true,
      cacheSeed,
      holdListRefresh: true,
      authService: auth.service,
    });
    await pressAccount(true);
    await waitFor(() => expect(harness.listsAfterAwait()).toBe(1));
    expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
    expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
    expect(auth.requests).toEqual([]);
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
    expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
      1,
    );
    expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
      1,
    );
    expect(methodCount(harness.messenger.calls, "providers.cancelLogin")).toBe(
      0,
    );
    const cached = harness.queryClient.getQueryData<
      ListResponse & { readonly futureKey: string }
    >(LIST_KEY);
    if (cached === undefined)
      throw new Error("The provider list cache is missing");
    expect(cached.offersSignIns).toBe(true);
    expect(cached.removedProfiles).toEqual(removedProfiles);
    expect(cached.futureKey).toBe("kept");
    expect(cached.providers[0]?.profiles[0]).toMatchObject({
      profileId: PROFILE_ID,
      aliases: ["legacy-work"],
      otherNames: ["Claude account"],
      personNotice: "waiting",
    });
    act(() => harness.releaseListRefresh());
    await waitFor(() => {
      expect(harness.queryClient.getQueryState(LIST_KEY)?.fetchStatus).toBe(
        "idle",
      );
    });
    expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
  });

  it("keeps today's result for an older computer without a sign-in request", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [workProfile()],
      profilesAfter: [workProfile()],
      outcome: null,
    });
    await pressAccount(true);
    expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
    expectNoSuccessSentence();
    expect(harness.created).not.toHaveBeenCalled();
    expect(signInFetchFor(harness).fetchMock).not.toHaveBeenCalled();
    const awaitRequests = harness.messenger.calls
      .filter((call) => call.method === "providers.awaitLogin")
      .map((call) => call.params);
    expect(awaitRequests).toHaveLength(1);
    expect(awaitRequests[0]).not.toHaveProperty("recordedOperationId");
  });

  it("records the request and asks again with its id before showing the signed-in profile", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [workProfile()],
      outcome: null,
      awaitAnswers: [
        asksToRecordSignIn(),
        nothingChanged({ kind: "signed-in", profileId: PROFILE_ID }),
      ],
    });
    signInFetchFor(harness).enqueue(RECORDED_SIGN_IN_REQUEST_REPLY);
    await pressAccount(true);

    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
    const awaitRequests = harness.messenger.calls
      .filter((call) => call.method === "providers.awaitLogin")
      .map((call) => call.params);
    expect(awaitRequests).toHaveLength(2);
    expect(awaitRequests[1]).toMatchObject({
      recordedOperationId: SIGN_IN_REQUEST_FIXTURE.operationId,
    });
    expect(signInFetchFor(harness).fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "a 403", reply: FORBIDDEN_SIGN_IN_REQUEST_REPLY },
    { name: "a 404", reply: ENVIRONMENT_NOT_FOUND_SIGN_IN_REQUEST_REPLY },
    { name: "no answer", reply: noAnswerReply() },
    { name: "a 401", reply: UNAUTHORIZED_SIGN_IN_REQUEST_REPLY },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly reply: SignInRequestFetchReply;
  }>)(
    "shows the existing did-not-finish result after recording ends on $name",
    async ({ reply }) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [],
        profilesAfter: [],
        outcome: null,
        awaitAnswers: [asksToRecordSignIn()],
      });
      signInFetchFor(harness).enqueue(reply);
      await pressAccount(true);

      expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
      expect(
        harness.messenger.calls.filter(
          (call) => call.method === "providers.awaitLogin",
        ),
      ).toHaveLength(1);
      expect(signInFetchFor(harness).fetchMock).toHaveBeenCalledTimes(1);
      expect(harness.created).not.toHaveBeenCalled();
    },
  );

  it("shows the did-not-finish result after a duplicate record answer", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [workProfile()],
      outcome: null,
      awaitAnswers: [
        asksToRecordSignIn(),
        nothingChanged({ kind: "signed-in", profileId: PROFILE_ID }),
      ],
    });
    signInFetchFor(harness).enqueue(
      MOVE_ACCEPTANCE_CONFLICT_SIGN_IN_REQUEST_REPLY,
    );
    await pressAccount(true);

    expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
    expectNoSuccessSentence();
    expect(harness.created).not.toHaveBeenCalled();
    expect(
      harness.messenger.calls.filter(
        (call) => call.method === "providers.awaitLogin",
      ),
    ).toHaveLength(1);
    expect(signInFetchFor(harness).fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not record twice when the computer asks again for the recorded id", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: null,
      awaitAnswers: [asksToRecordSignIn(), asksToRecordSignIn()],
    });
    signInFetchFor(harness).enqueue(RECORDED_SIGN_IN_REQUEST_REPLY);
    await pressAccount(true);

    expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
    expect(
      harness.messenger.calls.filter(
        (call) => call.method === "providers.awaitLogin",
      ),
    ).toHaveLength(2);
    expect(signInFetchFor(harness).fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, "absent"] as const)(
    "ignores a signed-in outcome when offersSignIns is %s",
    async (offers) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [workProfile()],
        profilesAfter: [workProfile()],
        outcome: { kind: "signed-in", profileId: PROFILE_ID },
      });
      await pressAccount(offers);
      expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
      expect(screen.queryByText(SIGNED_IN)).toBeNull();
      expect(harness.created).not.toHaveBeenCalled();
      expect(harness.listCalls()).toBe(1);
      expect(harness.listsAfterAwait()).toBe(0);
      expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
    },
  );

  it.each([true, false, "absent"] as const)(
    "renders the Add description according to offersSignIns (%s)",
    async (offers) => {
      renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [],
        profilesAfter: [],
        outcome: null,
      });
      await screen.findByRole("dialog");
      const description =
        "Name this Claude Code profile, choose its color, then link the account it should use.";
      if (offers === true) {
        expect(screen.queryByText(description)).toBeNull();
        return;
      }
      expect(screen.getByText(description)).toBeTruthy();
    },
  );

  it.each([
    { label: "null", unknown: false },
    { label: "unknown", unknown: true },
  ] as const)(
    "keeps DuplicateAccountNotice and its Sign in again footer for an unreadable $label outcome",
    async ({ unknown }) => {
      const row = workProfile();
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [row],
        profilesAfter: [row],
        outcome: null,
        echoedProfiles: [row],
        seedCache: true,
        unknownProfileOutcome: unknown,
      });
      await pressAccount(true);
      expect(await screen.findByText("Account already linked")).toBeTruthy();
      expect(
        screen.getByText(
          "Work already uses this account and organization. Sign in again and choose a different organization.",
        ),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Sign in again" }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
      expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
    },
  );

  it.each([
    { label: "waiting-for-profile", outcome: { kind: "waiting-for-profile" } },
    { label: "account-mismatch", outcome: { kind: "account-mismatch" } },
    { label: "account-unproven", outcome: { kind: "account-unproven" } },
    {
      label: "target-refused",
      outcome: { kind: "target-refused", reason: "not-authorized" },
    },
    {
      label: "staged-for-leave",
      outcome: { kind: "staged-for-leave", profileId: PROFILE_ID },
    },
    {
      label: "signed-in",
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
    },
    {
      label: "already-signed-in",
      outcome: { kind: "already-signed-in", profileId: PROFILE_ID },
    },
  ] as const satisfies ReadonlyArray<{
    readonly label: string;
    readonly outcome: ProviderLoginProfileOutcome;
  }>)(
    "does not show DuplicateAccountNotice for readable $label",
    async ({ outcome }) => {
      const row = workProfile();
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers: true,
        profilesBefore: [row],
        profilesAfter: [row],
        outcome,
        echoedProfiles: [row],
        seedCache: true,
      });
      await pressAccount(true);
      if (outcome.kind === "waiting-for-profile") {
        expect(await screen.findByText(WAITING)).toBeTruthy();
      } else if (outcome.kind === "signed-in") {
        expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
      } else if (outcome.kind === "already-signed-in") {
        expect(await screen.findByText(ALREADY_SIGNED_IN)).toBeTruthy();
      } else {
        expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
      }
      expect(screen.queryByText("Account already linked")).toBeNull();
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
    },
  );
});
