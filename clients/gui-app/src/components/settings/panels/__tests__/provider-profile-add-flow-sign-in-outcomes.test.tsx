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
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderLoginProfileOutcome,
  ProviderMutationCliStateV21,
  ProviderProfile,
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
  readonly queryClient: QueryClient;
  readonly listsAfterAwait: () => number;
  readonly listCalls: () => number;
  readonly releaseRecolor: () => void;
}

let settleHeldRecolor: () => void = () => undefined;

const ADD_FLOW_DEFAULTS = {
  echoedProfiles: undefined,
  listFailuresAfterAwait: 0,
  ownership: false,
  seedCache: false,
} satisfies {
  readonly echoedProfiles: readonly ProviderProfile[] | undefined;
  readonly listFailuresAfterAwait: number;
  readonly ownership: boolean;
  readonly seedCache: boolean;
};

afterEach(() => {
  settleHeldRecolor();
  settleHeldRecolor = () => undefined;
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
}): AddFlowHarness {
  const calls: RecordedCall[] = [];
  const created = vi.fn<(profileId: string) => void>();
  let awaitStarted = false;
  let listsAfterAwait = 0;
  let listCalls = 0;
  let release: ((value: SetEnabledResponse) => void) | null = null;
  let released = false;
  const failuresAfterAwait = input.listFailuresAfterAwait;
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.list": () => {
        listCalls += 1;
        if (awaitStarted) {
          listsAfterAwait += 1;
          if (listsAfterAwait <= failuresAfterAwait) {
            throw new Error("providers.list failed");
          }
        }
        return listBody(
          input.offers,
          awaitStarted ? input.profilesAfter : input.profilesBefore,
        );
      },
      "providers.startLogin": (params) => {
        calls.push({ method: "providers.startLogin", params });
        return startedBody();
      },
      "providers.awaitLogin": () => {
        calls.push({ method: "providers.awaitLogin", params: null });
        awaitStarted = true;
        return input.echoedProfiles === undefined
          ? nothingChanged(input.outcome)
          : echoedAwait(input.outcome, input.echoedProfiles);
      },
      "providers.setEnabled": (params) => {
        calls.push({ method: "providers.setEnabled", params });
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      "providers.cancelLogin": (params) => {
        calls.push({ method: "providers.cancelLogin", params });
        return { cancelled: true };
      },
    },
  });
  clientMock.current = client;
  if (input.ownership) {
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.startLogin": { major: 1, minor: 4 },
      "providers.cancelLogin": { major: 1, minor: 2 },
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
      listBody(input.offers, input.profilesBefore),
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
    queryClient,
    listsAfterAwait: () => listsAfterAwait,
    listCalls: () => listCalls,
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

function methodCount(calls: readonly RecordedCall[], method: string): number {
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
    });
    await pressAccount(true);
    const decisionReads = await expectSignedInDecision(harness);
    expect(decisionReads).toBe(1);
    await chooseSignedIn(harness, decisionReads);
  });

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
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(harness.listsAfterAwait()).toBe(1);
    expect(harness.created).not.toHaveBeenCalled();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
  });

  it("offers Use for an account that already has a profile, without recoloring it", async () => {
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
    expect(screen.queryByText("Account already linked")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save profile" })).toBeNull();
    expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    await waitFor(() => {
      expect(harness.created).toHaveBeenCalledWith(PROFILE_ID);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(methodCount(harness.calls, "providers.setEnabled")).toBe(0);
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
    },
  );
});
