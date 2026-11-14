// Sign in again, through the real ProfileEditDialog (startInReauth), over a
// host client. offersSignIns on the seeded providers.list is the only switch.
// Absent and false keep today's dialog. True reads profileOutcome.
const clientMock = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);

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
  return { ...actual, useOpenLink: () => () => Promise.resolve() };
});

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderLoginProfileOutcome,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ProviderMutationCliStateV21 } from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  profile,
  provider,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { useProviderProfileAddFlowStore } from "@/stores/settings/provider-profile-add-flow-store";

const HOST_ID = "host-sign-in-again";
const PROFILE_ID = "work";
const PROFILE_LABEL = "Work";
const SIGN_IN_AGAIN = "Sign in again";
const SIGN_IN_TO_LABEL = `Sign in to ${PROFILE_LABEL}`;
const DIFFERENT_ACCOUNT = `That sign-in is a different account. ${PROFILE_LABEL} was not changed.`;
const UNPROVEN =
  "This sign-in can't be matched to the account this profile uses.";
const NOT_CHANGED = `${PROFILE_LABEL} was not changed.`;
const WAITING_FOR_PROFILE = "Waiting for Traycer. Your sign-in is complete.";
const DID_NOT_FINISH = "Sign-in did not finish. Try again.";
const ADD_AS_NEW = "Add as a new profile";
const SWITCH_ACCOUNT = "Switch account";
const BROWSER_WAIT = "Approve sign-in in your browser";

type Offers = true | false | "absent";
type ListResponse = ResponseOfMethod<HostRpcRegistry, "providers.list">;
type StartResponse = ResponseOfMethod<HostRpcRegistry, "providers.startLogin">;
type AwaitResponse = ResponseOfMethod<HostRpcRegistry, "providers.awaitLogin">;

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

let releaseHeldAwait: ((value: AwaitResponse) => void) | null = null;

const REAUTH_DEFAULTS = {
  echoedSignedIn: false,
  ownership: false,
} satisfies {
  readonly echoedSignedIn: boolean;
  readonly ownership: boolean;
};

afterEach(() => {
  releaseHeldAwait?.(nothingChanged(null));
  releaseHeldAwait = null;
  cleanup();
  clientMock.current = null;
  useProviderProfileAddFlowStore.getState().close();
  resetNegotiatedManifests();
});

function workProfile(): ProviderProfile {
  return { ...profile(PROFILE_ID, "managed"), label: PROFILE_LABEL };
}

function listBody(offers: Offers): ListResponse {
  const body: ListResponse = {
    providers: [provider("claude-code", [workProfile()])],
    native: null,
  };
  if (offers === "absent") return body;
  return { ...body, offersSignIns: offers };
}

function startedBody(): StartResponse {
  return {
    url: "https://example.test/sign-in",
    started: true,
    profileId: PROFILE_ID,
    userCode: null,
    failure: null,
    pending: null,
    pack: null,
    targetRefusal: null,
  };
}

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

/** Old keys say this profile is already signed in. */
function signedInAwait(
  outcome: ProviderLoginProfileOutcome | null,
): AwaitResponse {
  const row = workProfile();
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
    profiles: [row],
  };
  return {
    state,
    existingProfileId: PROFILE_ID,
    codeRejected: false,
    refusal: null,
    installation: null,
    profileOutcome: outcome,
  };
}

function methodCount(calls: readonly RecordedCall[], method: string): number {
  return calls.filter((call) => call.method === method).length;
}

function renderReauth(input: {
  readonly offers: Offers;
  readonly outcome: ProviderLoginProfileOutcome | null;
  readonly holdAwait: boolean;
  /** The await answer's rows include this profile, authenticated. */
  readonly echoedSignedIn: boolean;
  /** Record the login-ownership manifest before the dialog mounts. */
  readonly ownership: boolean;
}) {
  const calls: RecordedCall[] = [];
  const { client, messenger } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.list": (params) => {
        calls.push({ method: "providers.list", params });
        return listBody(input.offers);
      },
      "providers.startLogin": (params) => {
        calls.push({ method: "providers.startLogin", params });
        return startedBody();
      },
      "providers.awaitLogin": () => {
        calls.push({ method: "providers.awaitLogin", params: null });
        if (input.holdAwait) {
          return new Promise((resolve) => {
            releaseHeldAwait = resolve;
          });
        }
        return input.echoedSignedIn
          ? signedInAwait(input.outcome)
          : nothingChanged(input.outcome);
      },
      "providers.cancelLogin": (params) => {
        calls.push({ method: "providers.cancelLogin", params });
        return { cancelled: true };
      },
    },
  });
  if (input.ownership) {
    recordNegotiatedHostManifest(HOST_ID, {
      "providers.startLogin": { major: 1, minor: 4 },
      "providers.cancelLogin": { major: 1, minor: 2 },
    });
  }
  clientMock.current = client;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(
    hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_ID,
      "providers.list",
      { native: null },
    ),
    listBody(input.offers),
  );
  const onOpenChange = vi.fn<(open: boolean) => void>();
  const selected = vi.fn<(profileId: string | null) => void>();
  const row = workProfile();
  const element = (open: boolean) => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProfileEditDialog
          state={provider("claude-code", [row])}
          profile={row}
          profiles={[row]}
          canOauth
          oauthUnavailableHint={null}
          startInReauth
          isLocalHost
          open={open}
          onOpenChange={onOpenChange}
          remainingProfilesAfterRemoval={[]}
          onSelectedProfileIdChange={selected}
          profileEnablementAvailable
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(element(true));
  return {
    onOpenChange,
    selected,
    calls,
    messenger,
    cancelCount: () => methodCount(calls, "providers.cancelLogin"),
    closeDialog: () => {
      view.rerender(element(false));
    },
  };
}

const SIGN_IN_METHODS = [
  "providers.awaitLogin",
  "providers.startLogin",
] as const;

function recordedMethodNames(calls: readonly RecordedCall[]): string[] {
  return [...new Set(calls.map((call) => call.method))].sort();
}

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

function renderManage() {
  let listCalls = 0;
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.list": () => {
        listCalls += 1;
        return listBody(true);
      },
    },
  });
  clientMock.current = client;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(
    hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_ID,
      "providers.list",
      { native: null },
    ),
    listBody(true),
  );
  const row = workProfile();
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProfileEditDialog
          state={provider("claude-code", [row])}
          profile={row}
          profiles={[row]}
          canOauth
          oauthUnavailableHint={null}
          startInReauth={false}
          isLocalHost
          open
          onOpenChange={() => undefined}
          remainingProfilesAfterRemoval={[]}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { listCalls: () => listCalls };
}

const REAUTH_MISFITS = [
  {
    label: "target-refused",
    outcome: { kind: "target-refused", reason: "not-authorized" },
  },
  {
    label: "staged-for-leave",
    outcome: { kind: "staged-for-leave", profileId: PROFILE_ID },
  },
] as const satisfies ReadonlyArray<{
  readonly label: string;
  readonly outcome: ProviderLoginProfileOutcome;
}>;

const SETTLED_CLOSE = [
  {
    name: "waiting-for-profile",
    outcome: { kind: "waiting-for-profile" },
    sentence: WAITING_FOR_PROFILE,
  },
  {
    name: "account-mismatch",
    outcome: { kind: "account-mismatch" },
    sentence: DIFFERENT_ACCOUNT,
  },
  {
    name: "account-unproven",
    outcome: { kind: "account-unproven" },
    sentence: UNPROVEN,
  },
] as const satisfies ReadonlyArray<{
  readonly name: string;
  readonly outcome: ProviderLoginProfileOutcome;
  readonly sentence: string;
}>;

describe("ProfileEditDialog startInReauth sign-in outcomes", () => {
  it("names the header Sign in again when offersSignIns is true", async () => {
    renderReauth({
      ...REAUTH_DEFAULTS,
      offers: true,
      outcome: null,
      holdAwait: false,
    });
    expect(
      await screen.findByRole("dialog", { name: SIGN_IN_AGAIN }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: SIGN_IN_TO_LABEL })).toBeNull();
  });

  it.each([false, "absent"] as const)(
    "keeps today's Sign in to label header when offersSignIns is %s",
    async (offers) => {
      renderReauth({
        ...REAUTH_DEFAULTS,
        offers,
        outcome: null,
        holdAwait: false,
      });
      expect(
        await screen.findByRole("dialog", { name: SIGN_IN_TO_LABEL }),
      ).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: SIGN_IN_AGAIN })).toBeNull();
    },
  );

  it("shows the different-account sentence, Done, and Switch account", async () => {
    const harness = renderReauth({
      ...REAUTH_DEFAULTS,
      offers: true,
      outcome: { kind: "account-mismatch" },
      holdAwait: false,
    });
    expect(await screen.findByText(DIFFERENT_ACCOUNT)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: SWITCH_ACCOUNT }));
    expect(screen.queryByRole("button", { name: ADD_AS_NEW })).toBeNull();
    expect(harness.onOpenChange).toHaveBeenCalledWith(false);
    const flow = useProviderProfileAddFlowStore.getState();
    expect(flow.harnessId).toBe("claude");
    expect(flow.hostId).toBe(HOST_ID);
    expect(flow.switchSource).toEqual({
      profileId: PROFILE_ID,
      label: PROFILE_LABEL,
    });
    flow.onProfileCreated?.(PROFILE_ID);
    expect(harness.selected).toHaveBeenCalledWith(PROFILE_ID);
  });

  it("an unmatchable sign-in shows that it can't be matched and that the profile was not changed, offers Add as a new profile, and changes nothing", async () => {
    const harness = renderReauth({
      ...REAUTH_DEFAULTS,
      offers: true,
      outcome: { kind: "account-unproven" },
      holdAwait: false,
    });
    expect(await screen.findByText(UNPROVEN)).toBeTruthy();
    expect(screen.getByText(NOT_CHANGED)).toBeTruthy();
    expect(screen.getByRole("button", { name: ADD_AS_NEW })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(harness.selected).not.toHaveBeenCalled();
    expect(harness.onOpenChange).not.toHaveBeenCalledWith(false);
    const name = screen.getByLabelText("Profile name");
    if (!(name instanceof HTMLInputElement)) {
      throw new Error("Profile name is not an input");
    }
    expect(name.value).toBe(PROFILE_LABEL);
    expect(recordedMethodNames(harness.calls)).toEqual([...SIGN_IN_METHODS]);
    expect(recordedMethodNames(harness.messenger.calls)).toEqual([
      ...SIGN_IN_METHODS,
    ]);
    expect(methodCount(harness.calls, "providers.startLogin")).toBe(1);
    expect(methodCount(harness.calls, "providers.awaitLogin")).toBe(1);
  });

  it("shows the waiting-for-profile sentence and Done", async () => {
    renderReauth({
      ...REAUTH_DEFAULTS,
      offers: true,
      outcome: { kind: "waiting-for-profile" },
      holdAwait: false,
    });
    expect(await screen.findByText(WAITING_FOR_PROFILE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it.each(REAUTH_MISFITS)(
    "ends $label on today's unfinished sign-in when the old keys are empty",
    async ({ outcome }) => {
      const harness = renderReauth({
        ...REAUTH_DEFAULTS,
        offers: true,
        outcome,
        holdAwait: false,
        ownership: true,
      });
      expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Cancel sign-in" }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(screen.queryByText(`Signed in as ${PROFILE_LABEL}`)).toBeNull();
      expect(
        screen.queryByText(`Already signed in as ${PROFILE_LABEL}`),
      ).toBeNull();
      expect(screen.queryByText(DIFFERENT_ACCOUNT)).toBeNull();
      expect(screen.queryByText(UNPROVEN)).toBeNull();
      expect(screen.queryByText(ADD_AS_NEW)).toBeNull();
      expect(screen.queryByText(WAITING_FOR_PROFILE)).toBeNull();
      expect(harness.selected).not.toHaveBeenCalled();
      const cancel = harness.calls.find(
        (call) => call.method === "providers.cancelLogin",
      );
      expect(cancelHolderId(cancel?.params)).toEqual(expect.any(String));
    },
  );

  it.each(REAUTH_MISFITS)(
    "ends $label on today's unfinished sign-in when the old keys say signed in",
    async ({ outcome }) => {
      const harness = renderReauth({
        ...REAUTH_DEFAULTS,
        offers: true,
        outcome,
        holdAwait: false,
        echoedSignedIn: true,
        ownership: true,
      });
      expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Cancel sign-in" }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(screen.queryByText(`Signed in as ${PROFILE_LABEL}`)).toBeNull();
      expect(
        screen.queryByText(`Already signed in as ${PROFILE_LABEL}`),
      ).toBeNull();
      expect(screen.queryByText(DIFFERENT_ACCOUNT)).toBeNull();
      expect(screen.queryByText(UNPROVEN)).toBeNull();
      expect(screen.queryByText(ADD_AS_NEW)).toBeNull();
      expect(screen.queryByText(WAITING_FOR_PROFILE)).toBeNull();
      expect(harness.selected).not.toHaveBeenCalled();
      const cancel = harness.calls.find(
        (call) => call.method === "providers.cancelLogin",
      );
      expect(cancelHolderId(cancel?.params)).toEqual(expect.any(String));
    },
  );

  it("reads no providers.list when Manage profile opens over a fresh cache", async () => {
    const harness = renderManage();
    expect(
      await screen.findByRole("dialog", { name: "Edit profile" }),
    ).toBeTruthy();
    expect(harness.listCalls()).toBe(0);
  });

  it("keeps today's did-not-finish result for already-signed-in", async () => {
    renderReauth({
      ...REAUTH_DEFAULTS,
      offers: true,
      outcome: { kind: "already-signed-in", profileId: PROFILE_ID },
      holdAwait: false,
    });
    expect(await screen.findByText(DID_NOT_FINISH)).toBeTruthy();
    expect(
      screen.queryByText(`Already signed in as ${PROFILE_LABEL}`),
    ).toBeNull();
    expect(screen.queryByText(ADD_AS_NEW)).toBeNull();
    expect(screen.queryByText(WAITING_FOR_PROFILE)).toBeNull();
  });

  it.each([false, "absent"] as const)(
    "hides the close button and ignores Escape while sign-in is waiting and offersSignIns is %s",
    async (offers) => {
      const harness = renderReauth({
        ...REAUTH_DEFAULTS,
        offers,
        outcome: null,
        holdAwait: true,
      });
      expect(await screen.findByText(BROWSER_WAIT)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(harness.onOpenChange).not.toHaveBeenCalled();
      expect(
        screen.getByRole("dialog", { name: SIGN_IN_TO_LABEL }),
      ).toBeTruthy();
      expect(harness.cancelCount()).toBe(0);
    },
  );

  it.each(SETTLED_CLOSE)(
    "closes from the close button on $name without providers.cancelLogin",
    async ({ outcome, sentence }) => {
      const harness = renderReauth({
        ...REAUTH_DEFAULTS,
        offers: true,
        outcome,
        holdAwait: false,
      });
      expect(await screen.findByText(sentence)).toBeTruthy();
      const close = screen.getByRole("button", { name: "Close" });
      fireEvent.click(close);
      expect(harness.onOpenChange).toHaveBeenCalledWith(false);
      expect(harness.cancelCount()).toBe(0);
      harness.closeDialog();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(harness.cancelCount()).toBe(0);
    },
  );

  it("hides the close button while a fact-true sign-in is still waiting", async () => {
    const harness = renderReauth({
      ...REAUTH_DEFAULTS,
      offers: true,
      outcome: null,
      holdAwait: true,
    });
    expect(await screen.findByText(BROWSER_WAIT)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: SIGN_IN_AGAIN })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(harness.cancelCount()).toBe(0);
  });
});
