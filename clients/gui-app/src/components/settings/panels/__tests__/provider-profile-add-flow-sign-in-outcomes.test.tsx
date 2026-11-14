// The Add dialog, through the real flow host, over a host client whose
// messenger answers providers.list / startLogin / awaitLogin / setEnabled.
// offersSignIns on the list is the only switch: absent and false keep today's
// dialog, true reads a completed sign-in's profileOutcome.
const clientMock = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);

// The flow host reads `useHostClient` through the barrel, and Vite rewrites
// that re-export onto `@/lib/host/runtime`. Both have to answer the pinned
// client or the session throws before the dialog mounts.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => clientMock.current };
});
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return { ...actual, useHostClient: () => clientMock.current };
});
vi.mock("@/lib/links/open-link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/links/open-link")>();
  return {
    ...actual,
    useOpenLink: () => () => Promise.resolve(),
  };
});

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
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
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useProviderProfileAddFlowStore } from "@/stores/settings/provider-profile-add-flow-store";

const HOST_ID = "host-add-flow";
const PROFILE_ID = "work";
const PROFILE_LABEL = "Work";
const MINTED_PROFILE_ID = "minted-1";
const DID_NOT_FINISH = "Sign-in did not finish. Retry when you are ready.";
const WAITING = "Waiting for Traycer. Your sign-in is complete.";
const UNREADABLE = "Couldn't load provider state.";
const SIGNED_IN = `Signed in as ${PROFILE_LABEL}`;
const ALREADY_SIGNED_IN = `Already signed in as ${PROFILE_LABEL}`;
const LIST_KEY = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
  HOST_ID,
  "providers.list",
  { native: null },
);

type Offers = true | false | "absent" | "10.11";
type ListResponse = ResponseOfMethod<HostRpcRegistry, "providers.list">;
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
}

let settleHeldStart: () => void = () => undefined;
let settleHeldRecolor: () => void = () => undefined;
let settleHeldAwait: () => void = () => undefined;

const ADD_FLOW_DEFAULTS = {
  echoedProfiles: undefined,
  echoedExistingProfileId: undefined,
  renameFailures: 0,
  submitOutcome: "accepted",
  listFailuresAfterAwait: 0,
  seedCache: false,
  cacheSeed: undefined,
  holdListRefresh: false,
  unknownProfileOutcome: false,
  codePaste: false,
  holdStart: false,
  holdAwait: false,
} satisfies {
  readonly echoedProfiles: readonly ProviderProfile[] | undefined;
  readonly echoedExistingProfileId: string | null | undefined;
  readonly renameFailures: number;
  readonly submitOutcome: SubmitLoginCodeResponse["outcome"];
  readonly listFailuresAfterAwait: number;
  readonly seedCache: boolean;
  readonly cacheSeed:
    | (ListResponse & { readonly futureKey: string })
    | undefined;
  readonly holdListRefresh: boolean;
  readonly unknownProfileOutcome: boolean;
  readonly codePaste: boolean;
  readonly holdStart: boolean;
  readonly holdAwait: boolean;
};

afterEach(() => {
  settleHeldStart();
  settleHeldStart = () => undefined;
  settleHeldRecolor();
  settleHeldRecolor = () => undefined;
  settleHeldAwait();
  settleHeldAwait = () => undefined;
  cleanup();
  useProviderProfileAddFlowStore.getState().close();
  useDesktopDialogStore.setState({ reportIssueAvailable: false });
  clientMock.current = null;
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

function renderAddFlow(input: {
  readonly offers: Offers;
  readonly profilesBefore: readonly ProviderProfile[];
  readonly profilesAfter: readonly ProviderProfile[];
  readonly outcome: ProviderLoginProfileOutcome | null;
  /** When set, the await answer carries these rows. Omitted keeps state null. */
  readonly echoedProfiles: readonly ProviderProfile[] | undefined;
  /** Overrides the old answer's existing-profile verdict when rows are echoed. */
  readonly echoedExistingProfileId: string | null | undefined;
  /** Number of rename requests that fail before one succeeds. */
  readonly renameFailures: number;
  /** How many providers.list calls after the await reject before one succeeds. */
  readonly listFailuresAfterAwait: number;
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
}): AddFlowHarness {
  const calls: RecordedCall[] = [];
  const created = vi.fn<(profileId: string) => void>();
  let awaitStarted = false;
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
      "providers.awaitLogin": () => {
        calls.push({ method: "providers.awaitLogin", params: null });
        awaitStarted = true;
        if (input.holdAwait) {
          return new Promise<AwaitResponse>((resolve) => {
            const release = () => resolve(nothingChanged(input.outcome));
            settleHeldAwait = release;
          });
        }
        const answer =
          input.echoedProfiles === undefined
            ? nothingChanged(input.outcome)
            : echoedAwait(
                input.outcome,
                input.echoedProfiles,
                input.echoedExistingProfileId === undefined
                  ? (input.echoedProfiles.at(0)?.profileId ?? null)
                  : input.echoedExistingProfileId,
              );
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
        return { touched: true };
      },
    },
  });
  clientMock.current = client;
  const oldComputer = input.offers === "10.11" || input.offers === "absent";
  recordNegotiatedHostManifest(HOST_ID, {
    "providers.list": { major: 10, minor: oldComputer ? 11 : 12 },
    "providers.startLogin": { major: 1, minor: oldComputer ? 4 : 5 },
    "providers.awaitLogin": { major: 2, minor: oldComputer ? 2 : 4 },
    "providers.cancelLogin": { major: 1, minor: 2 },
    "providers.submitLoginCode": { major: 1, minor: 0 },
    "providers.touchLogin": { major: 1, minor: 0 },
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
  };
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

  it("keeps today's Add dialog on a computer negotiating providers.list 10.11", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: "10.11",
      profilesBefore: [],
      profilesAfter: [],
      outcome: null,
    });
    expect(
      await screen.findByRole("heading", {
        name: "Add new Claude Code profile",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link account" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Add a profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));
    await waitFor(() => {
      expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    });
    const start = harness.calls.find(
      (call) => call.method === "providers.startLogin",
    );
    expect(start?.params).toMatchObject({
      profileId: null,
      createProfile: { label: "New profile" },
    });
    expect(start?.params).toHaveProperty("target", null);
  });

  it.each([true, "10.11"] as const)(
    "does not submit a pasted code again when Enter follows with offersSignIns %s",
    async (offers) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [],
        profilesAfter: [],
        outcome: null,
        codePaste: true,
        holdStart: true,
        holdAwait: true,
      });
      await pressAccount(offers);
      expect(screen.queryByLabelText("Paste the code")).toBeNull();
      await waitFor(() => {
        expect(
          methodCount(harness.messenger.calls, "providers.startLogin"),
        ).toBe(1);
      });
      await act(async () => {
        harness.releaseStart();
        await Promise.resolve();
      });
      const input = await screen.findByLabelText("Paste the code");
      fireEvent.paste(input, {
        clipboardData: { getData: () => "abcd#1234" },
      });
      await waitFor(() => {
        expect(
          methodCount(harness.messenger.calls, "providers.submitLoginCode"),
        ).toBe(1);
      });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(
        methodCount(harness.messenger.calls, "providers.submitLoginCode"),
      ).toBe(1);
      expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
        1,
      );
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
    },
  );

  it.each([true, "10.11"] as const)(
    "copies the active sign-in link from the real Add dialog with offersSignIns %s",
    async (offers) => {
      const clipboardDescriptor = Object.getOwnPropertyDescriptor(
        navigator,
        "clipboard",
      );
      const writeText = vi.fn((_value: string) => Promise.resolve());
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      try {
        const harness = renderAddFlow({
          ...ADD_FLOW_DEFAULTS,
          offers,
          profilesBefore: [],
          profilesAfter: [],
          outcome: null,
          holdAwait: true,
        });
        await pressAccount(offers);
        const copyButton = await screen.findByRole("button", {
          name: /Copy sign-in link/,
        });
        await act(async () => {
          fireEvent.click(copyButton);
          await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledWith("https://example.test/sign-in");
        expect(
          methodCount(harness.messenger.calls, "providers.startLogin"),
        ).toBe(1);
      } finally {
        if (clipboardDescriptor === undefined) {
          Reflect.deleteProperty(navigator, "clipboard");
        } else {
          Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
        }
      }
    },
  );

  it.each([true, "10.11"] as const)(
    "cancels an in-progress sign-in through providers.cancelLogin with offersSignIns %s",
    async (offers) => {
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [],
        profilesAfter: [],
        outcome: null,
        codePaste: true,
        submitOutcome: "noActiveLogin",
        holdAwait: true,
      });
      await pressAccount(offers);
      const input = await screen.findByLabelText("Paste the code");
      fireEvent.paste(input, {
        clipboardData: { getData: () => "abcd#1234" },
      });
      await waitFor(() => {
        expect(
          methodCount(harness.messenger.calls, "providers.submitLoginCode"),
        ).toBe(1);
      });
      await screen.findByRole("button", { name: "Cancel sign-in" });
      fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
      await waitFor(() => {
        expect(
          methodCount(harness.messenger.calls, "providers.cancelLogin"),
        ).toBe(1);
      });
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

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

  it.each([true, "10.11"] as const)(
    "names a same-email distinct profile through the real dialog with offersSignIns %s",
    async (offers) => {
      const { existing, created } = sameEmailRenameProfiles();
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [existing],
        profilesAfter: [existing, created],
        outcome:
          offers === true
            ? { kind: "signed-in", profileId: MINTED_PROFILE_ID }
            : null,
        echoedProfiles: [existing, created],
        echoedExistingProfileId: null,
      });
      await pressAccount(offers);
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
        expect(
          methodCount(harness.messenger.calls, "providers.setEnabled"),
        ).toBe(1);
      });
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
      expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
        1,
      );
      expect(
        harness.calls
          .filter((call) => call.method === "providers.setEnabled")
          .map((call) => renamedLabel(call.params)),
      ).toEqual(["Personal"]);
      expect(
        methodCount(harness.messenger.calls, "providers.cancelLogin"),
      ).toBe(0);
    },
  );

  it.each([true, "10.11"] as const)(
    "finishes a distinct-email sign-in without a naming step when offersSignIns is %s",
    async (offers) => {
      const row: ProviderProfile = {
        ...mintedSignedInRow(),
        identity: {
          email: "fresh@example.test",
          tier: "Team",
          accountUuid: null,
        },
        accentColor: PROVIDER_PROFILE_ACCENT_COLORS[0],
      };
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [],
        profilesAfter: [row],
        outcome:
          offers === true
            ? { kind: "signed-in", profileId: MINTED_PROFILE_ID }
            : null,
        echoedProfiles: [row],
        echoedExistingProfileId: null,
        seedCache: true,
      });
      await pressAccount(offers);
      expect(
        screen.queryByText(
          "Terminal account already uses this email. Name this profile so you can tell them apart.",
        ),
      ).toBeNull();
      await waitFor(() => {
        expect(harness.created).toHaveBeenCalledWith(MINTED_PROFILE_ID);
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
      expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
        1,
      );
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
    },
  );

  it.each([true, "10.11"] as const)(
    "keeps the naming step open after a failed save and allows retry with offersSignIns %s",
    async (offers) => {
      const { existing, created } = sameEmailRenameProfiles();
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [existing],
        profilesAfter: [existing, created],
        outcome:
          offers === true
            ? { kind: "signed-in", profileId: MINTED_PROFILE_ID }
            : null,
        echoedProfiles: [existing, created],
        echoedExistingProfileId: null,
        renameFailures: 1,
      });
      await pressAccount(offers);
      await screen.findByText(
        "Terminal account already uses this email. Name this profile so you can tell them apart.",
      );
      fireEvent.change(screen.getByLabelText("Profile name"), {
        target: { value: "Work org" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
      expect(
        await screen.findByText("Couldn't save the name. Try again."),
      ).toBeTruthy();
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Save profile" })).toBeTruthy();
      expect(harness.created).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
      await waitFor(() => {
        expect(harness.created).toHaveBeenCalledWith(MINTED_PROFILE_ID);
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(
        harness.calls
          .filter((call) => call.method === "providers.setEnabled")
          .map((call) => renamedLabel(call.params)),
      ).toEqual(["Work org", "Work org"]);
    },
  );

  it.each([true, "10.11"] as const)(
    "renames and recolors a same-email distinct profile with offersSignIns %s",
    async (offers) => {
      const { existing, created } = sameEmailRenameProfiles();
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [existing],
        profilesAfter: [existing, created],
        outcome:
          offers === true
            ? { kind: "signed-in", profileId: MINTED_PROFILE_ID }
            : null,
        echoedProfiles: [existing, created],
        echoedExistingProfileId: null,
        seedCache: true,
      });
      await pressAccount(offers);
      expect(
        await screen.findByText(
          "Terminal account already uses this email. Name this profile so you can tell them apart.",
        ),
      ).toBeTruthy();
      if (offers === true) {
        expect(harness.listsAfterAwait()).toBe(1);
        expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
      }

      fireEvent.change(screen.getByLabelText("Profile name"), {
        target: { value: "Personal" },
      });
      const pickedColor = PROVIDER_PROFILE_ACCENT_COLORS[2];
      expect(pickedColor).not.toBe(existing.accentColor);
      fireEvent.click(
        screen.getByRole("button", { name: `Use color ${pickedColor}` }),
      );
      if (offers === true) {
        expect(harness.listsAfterAwait()).toBe(1);
        expect(methodCount(harness.messenger.calls, "providers.list")).toBe(1);
      }

      fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
      await waitFor(() => {
        expect(methodCount(harness.calls, "providers.setEnabled")).toBe(2);
      });
      if (offers === true) {
        expect(harness.listsAfterAwait()).toBe(2);
        expect(methodCount(harness.messenger.calls, "providers.list")).toBe(2);
      }
      const setEnabledCalls = harness.calls.filter(
        (call) => call.method === "providers.setEnabled",
      );
      expect(
        setEnabledCalls.map((call) => setEnabledActionDetails(call.params)),
      ).toEqual([
        { label: "Personal", accentColor: null },
        { label: null, accentColor: pickedColor },
      ]);

      harness.releaseRecolor();
      await waitFor(() => {
        expect(harness.created).toHaveBeenCalledWith(MINTED_PROFILE_ID);
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      if (offers === true) {
        expect(harness.listsAfterAwait()).toBe(3);
        expect(methodCount(harness.messenger.calls, "providers.list")).toBe(3);
      }
      expect(methodCount(harness.messenger.calls, "providers.startLogin")).toBe(
        1,
      );
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
      expect(
        methodCount(harness.messenger.calls, "providers.cancelLogin"),
      ).toBe(0);
    },
  );

  it("waits, with Done, when the signed-in id is still absent after one re-read", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: { kind: "signed-in", profileId: PROFILE_ID },
    });
    await pressAccount(true);
    expect(await screen.findByText(WAITING)).toBeTruthy();
    expect(harness.listsAfterAwait()).toBe(1);
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(harness.created).not.toHaveBeenCalled();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
  });

  it.each([true, "10.11"] as const)(
    "shows the existing account without recoloring it when offersSignIns is %s",
    async (offers) => {
      const row = workProfile();
      const harness = renderAddFlow({
        ...ADD_FLOW_DEFAULTS,
        offers,
        profilesBefore: [row],
        profilesAfter: [row],
        outcome:
          offers === true
            ? { kind: "already-signed-in", profileId: PROFILE_ID }
            : null,
        echoedProfiles: [row],
        echoedExistingProfileId: PROFILE_ID,
      });
      await pressAccount(offers);
      if (offers === true) {
        expect(await screen.findByText(ALREADY_SIGNED_IN)).toBeTruthy();
        expect(harness.listsAfterAwait()).toBe(1);
        expect(methodCount(harness.messenger.calls, "providers.list")).toBe(2);
        expect(
          screen.getByLabelText("Profile name").hasAttribute("disabled"),
        ).toBe(true);
        expect(
          screen.queryByRole("button", { name: "Save profile" }),
        ).toBeNull();
        expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
        fireEvent.click(screen.getByRole("button", { name: "Use" }));
        await waitFor(() => {
          expect(harness.created).toHaveBeenCalledWith(PROFILE_ID);
        });
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(harness.listsAfterAwait()).toBe(1);
        expect(methodCount(harness.messenger.calls, "providers.list")).toBe(2);
        expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
      } else {
        expect(await screen.findByText("Account already linked")).toBeTruthy();
        expect(screen.queryByText(ALREADY_SIGNED_IN)).toBeNull();
        expect(harness.created).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
        expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
        fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
        await waitFor(() => {
          expect(
            methodCount(harness.messenger.calls, "providers.startLogin"),
          ).toBe(2);
        });
        const retry = harness.calls.filter(
          (call) => call.method === "providers.startLogin",
        )[1];
        if (retry === undefined) {
          throw new Error("Expected a second start login call.");
        }
        expect(retry.params).toMatchObject({
          providerId: "claude-code",
          profileId: null,
          target: null,
        });
        expect(startCreateProfile(retry.params)).toEqual({
          label: "New profile",
          shareSkillsAndPlugins: true,
        });
      }
    },
  );

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
      listBody(true, [], false),
    );
    await chooseSignedIn(harness, decisionReads);
    expect(harness.queryClient.getQueryData(LIST_KEY)).toEqual(
      listBody(true, [], false),
    );
  });

  it("names an already-signed-in profile from the answer's own rows when the re-read does not", async () => {
    const harness = renderAddFlow({
      ...ADD_FLOW_DEFAULTS,
      offers: true,
      profilesBefore: [],
      profilesAfter: [],
      outcome: { kind: "already-signed-in", profileId: PROFILE_ID },
      echoedProfiles: [workProfile()],
    });
    await pressAccount(true);
    expect(await screen.findByText(ALREADY_SIGNED_IN)).toBeTruthy();
    expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
    expect(harness.listsAfterAwait()).toBe(1);
    expect(harness.created).not.toHaveBeenCalled();
    expect(harness.queryClient.getQueryData(LIST_KEY)).toEqual(
      listBody(true, [], false),
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
      listBody(true, [row], false),
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
      ...listBody(true, [projected], false),
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
    const removedProfiles = [
      {
        providerId: "claude-code",
        profileId: "removed-work",
        aliases: ["old-work"],
      },
    ];
    const cacheSeed = {
      ...listBody(true, [projected], false),
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
    });
    await pressAccount(true);
    await waitFor(() => expect(harness.listsAfterAwait()).toBe(1));
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

  it("reads today's unfinished sign-in when the outcome is null", async () => {
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
      expect(methodCount(harness.messenger.calls, "providers.awaitLogin")).toBe(
        1,
      );
    },
  );
});
