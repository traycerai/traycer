// The Add dialog, through the real flow host, over a host client whose
// messenger answers providers.list / startLogin / awaitLogin / setEnabled.
// offersSignIns on the list is the only switch: absent and false keep today's
// dialog, true reads a completed sign-in's profileOutcome.
const clientMock = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);
const openLinkMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
export { openLinkMock };
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
    useOpenLink: () => openLinkMock,
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
import { createElement } from "react";
import { afterEach, expect, vi, type Mock } from "vitest";
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
  installSignInRequestFetchHarness,
  SIGN_IN_REQUEST_FIXTURE,
  type SignInRequestFetchHarness,
} from "@traycer-clients/shared/test-fixtures/provider-sign-in-request-test-support";

const HOST_ID = "host-add-flow";
export const PROFILE_ID = "work";
const PROFILE_LABEL = "Work";
export const MINTED_PROFILE_ID = "minted-1";
export const DID_NOT_FINISH =
  "Sign-in did not finish. Retry when you are ready.";
export const WAITING = "Waiting for Traycer. Your sign-in is complete.";
export const UNREADABLE = "Couldn't load provider state.";
export const SIGNED_IN = `Signed in as ${PROFILE_LABEL}`;
export const ALREADY_SIGNED_IN = `Already signed in as ${PROFILE_LABEL}`;
export const PROFILE_RECORD_URL =
  "http://localhost:5005/api/v3/environments/environment-profile-fixture/profile-records/minted-1/name";
export const LIST_KEY = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
  HOST_ID,
  "providers.list",
  { native: null },
);

type Offers = true | false | "absent" | "10.11";
type ProfileNameReply =
  | "accepted"
  | "unauthorized"
  | "forbidden"
  | "untyped-failure"
  | "retry-once";
export type ListResponse = ResponseOfMethod<HostRpcRegistry, "providers.list">;
type StartResponse = ResponseOfMethod<HostRpcRegistry, "providers.startLogin">;
type AwaitResponse = ResponseOfMethod<HostRpcRegistry, "providers.awaitLogin">;
type SubmitLoginCodeResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.submitLoginCode"
>;
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
  readonly releaseStart: () => void;
  readonly releaseRecolor: () => void;
  readonly signInFetch: SignInRequestFetchHarness | null;
  readonly updateProfileName: (profileId: string, name: string) => void;
}

let settleHeldRecolor: () => void = () => undefined;
let settleHeldStart: () => void = () => undefined;
let settleHeldAwait: () => void = () => undefined;
let activeSignInFetch: SignInRequestFetchHarness | null = null;
export const profileNameTransport = {
  onAccepted: (_name: string): void => undefined,
};

export const ADD_FLOW_DEFAULTS = {
  echoedProfiles: undefined,
  echoedExistingProfileId: undefined,
  renameFailures: 0,
  submitOutcome: "accepted",
  listFailuresAfterAwait: 0,
  ownership: false,
  seedCache: false,
  cacheSeed: undefined,
  holdListRefresh: false,
  unknownProfileOutcome: false,
  codePaste: false,
  holdStart: false,
  holdAwait: false,
  failRecolor: false,
  failRename: false,
  freshlyLinkedProfile: false,
  awaitAnswers: [],
  authService: null,
  recordEnvironment: false,
} satisfies {
  readonly echoedProfiles: readonly ProviderProfile[] | undefined;
  readonly echoedExistingProfileId: string | null | undefined;
  readonly renameFailures: number;
  readonly submitOutcome: SubmitLoginCodeResponse["outcome"];
  readonly listFailuresAfterAwait: number;
  readonly ownership: boolean;
  readonly seedCache: boolean;
  readonly cacheSeed:
    | (ListResponse & { readonly futureKey: string })
    | undefined;
  readonly holdListRefresh: boolean;
  readonly unknownProfileOutcome: boolean;
  readonly codePaste: boolean;
  readonly holdStart: boolean;
  readonly holdAwait: boolean;
  readonly failRecolor: boolean;
  readonly failRename: boolean;
  readonly freshlyLinkedProfile: boolean;
  readonly awaitAnswers: readonly AwaitResponse[];
  readonly authService: AuthService | null;
  readonly recordEnvironment: boolean;
};

afterEach(() => {
  settleHeldStart();
  settleHeldStart = () => undefined;
  settleHeldAwait();
  settleHeldAwait = () => undefined;
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
  openLinkMock.mockClear();
});

export function workProfile(): ProviderProfile {
  return {
    ...profile(PROFILE_ID, "managed"),
    label: PROFILE_LABEL,
    accentColor: "#f97316",
  };
}

export function sameEmailRenameProfiles(): {
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

export async function createAddProfileNameAuthFixture(reply: ProfileNameReply) {
  let nameRequests = 0;
  return createProfileRecordAuthFixture((request) => {
    if (request.url !== PROFILE_RECORD_URL) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    nameRequests += 1;
    const accepted =
      reply === "accepted" || (reply === "retry-once" && nameRequests > 1);
    if (accepted) profileNameTransport.onAccepted("Personal");
    const statusByReply: Record<ProfileNameReply, number> = {
      accepted: 200,
      unauthorized: 401,
      forbidden: 403,
      "untyped-failure": 500,
      "retry-once": 500,
    };
    const status = accepted ? statusByReply.accepted : statusByReply[reply];
    let body: Record<string, number | string>;
    if (accepted) {
      body = {
        profileId: MINTED_PROFILE_ID,
        harnessId: "claude",
        recordRevision: "18",
        name: "Personal",
      };
    } else if (reply === "forbidden") {
      body = {
        statusCode: 403,
        error: "private response detail",
        code: "environment_action_forbidden",
      };
    } else {
      body = { error: "private response detail" };
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
}

export function projectedWorkProfile(): ProviderProfile {
  return {
    ...workProfile(),
    aliases: ["legacy-work"],
    otherNames: ["Claude account"],
    personNotice: "waiting",
  };
}

export function listBody(
  offers: Offers,
  profiles: readonly ProviderProfile[],
  codePaste: boolean,
): ListResponse {
  const body: ListResponse = {
    providers: [
      {
        ...provider("claude-code", [...profiles]),
        loginCapability: codePaste
          ? {
              oauthArgs: ["auth", "login"],
              token: null,
              codePaste: {},
              terminalLogin: null,
              remoteSafe: null,
              selfOpensBrowser: null,
            }
          : null,
      },
    ],
    native: null,
  };
  if (offers === "absent" || offers === "10.11") return body;
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
export function nothingChanged(
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

export function asksToRecordSignIn(): AwaitResponse {
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
  existingProfileId: string | null,
): AwaitResponse {
  const base = setEnabledEcho().state;
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
    existingProfileId,
    codeRejected: false,
    refusal: null,
    installation: null,
    profileOutcome: outcome,
  };
}

export function renderAddFlow(input: {
  readonly offers: Offers;
  readonly profilesBefore: readonly ProviderProfile[];
  readonly profilesAfter: readonly ProviderProfile[];
  readonly outcome: ProviderLoginProfileOutcome | null;
  /** When set, the await answer carries these rows. Omitted keeps state null. */
  readonly echoedProfiles: readonly ProviderProfile[] | undefined;
  /** Overrides the old answer's existing-profile verdict when rows are echoed. */
  readonly echoedExistingProfileId: string | null | undefined;
  /** Number of local rename requests that fail before one succeeds. */
  readonly renameFailures: number;
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
  readonly codePaste: boolean;
  readonly holdStart: boolean;
  readonly holdAwait: boolean;
  readonly submitOutcome: SubmitLoginCodeResponse["outcome"];
  readonly failRecolor: boolean;
  readonly failRename: boolean;
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
  let releaseStart: (() => void) | null = null;
  let profilesAfter = input.profilesAfter;
  let renameFailures = input.renameFailures;
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
                resolve(
                  listBody(input.offers, input.profilesAfter, input.codePaste),
                );
            });
          }
        }
        return listBody(
          input.offers,
          awaitStarted ? profilesAfter : input.profilesBefore,
          input.codePaste,
        );
      },
      "providers.startLogin": (params) => {
        calls.push({ method: "providers.startLogin", params });
        if (input.holdStart) {
          return new Promise<StartResponse>((resolve) => {
            releaseStart = () => resolve(startedBody());
            settleHeldStart = () => releaseStart?.();
          });
        }
        return startedBody();
      },
      "providers.awaitLogin": (params) => {
        calls.push({ method: "providers.awaitLogin", params });
        awaitStarted = true;
        if (input.holdAwait) {
          return new Promise<AwaitResponse>((resolve) => {
            settleHeldAwait = () => resolve(nothingChanged(input.outcome));
          });
        }
        if (awaitAnswerIndex < input.awaitAnswers.length) {
          const scriptedAnswer = input.awaitAnswers[awaitAnswerIndex];
          awaitAnswerIndex += 1;
          return scriptedAnswer;
        }
        awaitAnswerIndex += 1;
        const echoedAnswer =
          input.echoedProfiles === undefined
            ? nothingChanged(input.outcome)
            : echoedAwait(
                input.outcome,
                input.echoedProfiles,
                input.echoedExistingProfileId === undefined
                  ? (input.echoedProfiles.at(0)?.profileId ?? null)
                  : input.echoedExistingProfileId,
              );
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
          if (input.failRename) throw new Error("synthetic rename failure");
          if (renameFailures > 0) {
            renameFailures -= 1;
            throw new Error("rename unavailable");
          }
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
      "providers.submitLoginCode": (params) => {
        calls.push({ method: "providers.submitLoginCode", params });
        return { outcome: input.submitOutcome };
      },
      "providers.touchLogin": (params) => {
        calls.push({ method: "providers.touchLogin", params });
        return { extended: true };
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
  recordNegotiatedHostManifest(HOST_ID, {
    "providers.list": {
      major: 10,
      minor: input.offers === "10.11" || input.offers === "absent" ? 11 : 12,
    },
    "providers.startLogin": {
      major: 1,
      minor: input.offers === "10.11" || input.offers === "absent" ? 4 : 5,
    },
    "providers.awaitLogin": {
      major: 2,
      minor: input.offers === "10.11" || input.offers === "absent" ? 2 : 5,
    },
    "providers.cancelLogin": { major: 1, minor: 2 },
    "providers.submitLoginCode": { major: 1, minor: 0 },
    "providers.touchLogin": { major: 1, minor: 0 },
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
      input.cacheSeed ??
        listBody(input.offers, input.profilesBefore, input.codePaste),
    );
  }
  useProviderProfileAddFlowStore
    .getState()
    .openForHarness("claude", null, created);
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        TooltipProvider,
        null,
        createElement(ProviderProfileAddFlowHost),
      ),
    ),
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
    releaseStart: () => {
      if (releaseStart === null) {
        throw new Error("providers.startLogin was not held");
      }
      releaseStart();
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

export function signInFetchFor(
  harness: AddFlowHarness,
): SignInRequestFetchHarness {
  if (harness.signInFetch === null) {
    throw new Error("sign-in request fetch harness was not installed");
  }
  return harness.signInFetch;
}

export function methodCount(
  calls: readonly { readonly method: string }[],
  method: string,
): number {
  return calls.filter((call) => call.method === method).length;
}

export function startCreateProfile(
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

export async function pressAccount(offers: Offers): Promise<void> {
  const name = offers === true ? "Sign in" : "Link account";
  fireEvent.click(await screen.findByRole("button", { name }));
}

export async function expectSignedInDecision(
  harness: AddFlowHarness,
): Promise<number> {
  expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
  const decisionReads = harness.listsAfterAwait();
  expect(harness.created).not.toHaveBeenCalled();
  expect(methodCount(harness.calls, "providers.setEnabled")).toBe(1);
  return decisionReads;
}

export async function chooseSignedIn(
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

export function expectNoSuccessSentence(): void {
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

export function renamedLabel(params: unknown): string | null {
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

export function setEnabledActionDetails(params: unknown): {
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

export async function expectAddDidNotFinish(
  harness: AddFlowHarness,
): Promise<void> {
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

export function mintedSignedInRow(): ProviderProfile {
  return { ...workProfile(), profileId: MINTED_PROFILE_ID };
}

export const ADD_MISFITS = [
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
