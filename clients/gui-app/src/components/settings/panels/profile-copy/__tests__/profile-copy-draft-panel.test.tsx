import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler, useEffect, useMemo, useState, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfileCopyDraftPanel } from "@/components/settings/panels/profile-copy/profile-copy-draft-panel";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import {
  COPY_NAMES,
  DEST_HOST_ID,
  DEST_HOST_TWO_ID,
  hostDirectoryEntry,
  LOGIN_ATTEMPT_ID,
  recordedOutcome,
  SOURCE_HOST_ID,
  TARGET_PROFILE_ID,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import type { ProfileCopyReason } from "@/lib/profile-copy/profile-copy-model";
import { profileCopySharedResourceCopy } from "@/lib/profile-copy/profile-copy-presentation";
import {
  claudeProviderState,
  hostOption,
  managedProfile,
} from "./profile-copy-component-fixtures";

const harness = vi.hoisted(
  (): {
    spine: HostClient<HostRpcRegistry> | null;
    hosts: HostScopeOption[];
    clientFor: ((hostId: string) => HostClient<HostRpcRegistry> | null) | null;
  } => ({ spine: null, hosts: [], clientFor: null }),
);

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null) return null;
    if (harness.clientFor !== null) return harness.clientFor(hostId);
    if (harness.spine === null) return null;
    return harness.spine.createRequesterForHostId(hostId);
  },
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: harness.hosts,
    activeHostId: DEST_HOST_ID,
    isLoading: false,
    directoryResolved: true,
    directoryFailed: false,
    listsResolved: true,
    listsFailed: false,
    retryLists: () => undefined,
    nowMs: 0,
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: () => undefined }),
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => () => Promise.resolve(),
}));

function resetFlow(): void {
  useProfileCopyFlowStore.setState({
    view: null,
    session: 0,
    activeLogin: null,
    directBlocks: {},
  });
}

function mismatchOutcome() {
  return recordedOutcome({
    state: "account-confirmation-required",
    revision: 4,
    readiness: {
      preparation: "complete",
      verification: "verified",
      verificationRevision: 1,
      acceptedVerificationRevision: null,
      identity: "mismatch",
      identityRevision: 8,
      acceptedIdentityRevision: null,
      writer: "none",
      writerGeneration: 0,
      quarantined: false,
    },
  });
}

describe("ProfileCopyDraftPanel", () => {
  beforeEach(() => {
    resetFlow();
    harness.spine = null;
    harness.clientFor = null;
    harness.hosts = [
      hostOption(DEST_HOST_ID, "Linux box", false),
      hostOption(DEST_HOST_TWO_ID, "Build server", false),
      hostOption(SOURCE_HOST_ID, "Studio Mac", true),
    ];
  });
  afterEach(() => {
    cleanup();
    resetFlow();
    harness.spine = null;
    harness.clientFor = null;
    vi.useRealTimers();
  });

  it("shows a stale-revision answer and does not resend it", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: mismatchOutcome(),
        }),
        "providers.profileCopy.confirmIdentity": () => ({
          result: "stale-revision" as const,
          outcome: mismatchOutcome(),
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    harness.spine = spine;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyDraftPanel
            outcome={mismatchOutcome()}
            names={COPY_NAMES}
            route="code-paste"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Keep this account" }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep this account" }));
    await waitFor(() =>
      expect(
        screen.getByText(/This changed on Linux box since you last looked/),
      ).toBeTruthy(),
    );
    expect(
      messenger.calls.filter(
        (call) => call.method === "providers.profileCopy.confirmIdentity",
      ),
    ).toHaveLength(1);
    expect(
      messenger.calls.find(
        (call) => call.method === "providers.profileCopy.confirmIdentity",
      )?.params,
    ).toMatchObject({
      decision: "accept-mismatch",
      identityRevision: 8,
    });
    expect(
      messenger.calls.find(
        (call) => call.method === "providers.profileCopy.confirmIdentity",
      )?.authority.endpoint.hostId,
    ).toBe(DEST_HOST_ID);
  });

  it("disables Sign in while another destination holds the lock", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: recordedOutcome({ state: "sign-in-required" }),
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    harness.spine = spine;
    useProfileCopyFlowStore.getState().claimLogin({
      destinationHostId: DEST_HOST_TWO_ID,
      attemptId: "55555555-5555-4555-8555-555555555555",
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyDraftPanel
            outcome={recordedOutcome({ state: "sign-in-required" })}
            names={COPY_NAMES}
            route="code-paste"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Sign in on Linux box/ }),
      ).toHaveProperty("disabled", true),
    );
    expect(
      screen.getByText(/Finish signing in on Build server first/),
    ).toBeTruthy();
  });

  it("cancels the draft with cancelDraft when no sign-in is live", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: recordedOutcome({ state: "sign-in-required" }),
        }),
        "providers.profileCopy.cancelDraft": () => ({
          result: "current" as const,
          outcome: recordedOutcome({ state: "cancelled", reason: "cancelled" }),
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    harness.spine = spine;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyDraftPanel
            outcome={recordedOutcome({ state: "sign-in-required" })}
            names={COPY_NAMES}
            route="code-paste"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Cancel this device" }),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel this device" }));
    fireEvent.click(
      within(screen.getByTestId("confirm-destructive-dialog")).getByRole(
        "button",
        { name: "Cancel copy" },
      ),
    );
    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) => call.method === "providers.profileCopy.cancelDraft",
        ),
      ).toBe(true),
    );
    expect(
      messenger.calls.some(
        (call) => call.method === "providers.profileCopy.login.cancel",
      ),
    ).toBe(false);
  });

  it("cancels a live sign-in with login.cancel and sends no cancelDraft", async () => {
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: recordedOutcome({ state: "sign-in-required" }),
        }),
        "providers.profileCopy.login.start": () => ({
          outcome: recordedOutcome({
            state: "signing-in",
            reason: null,
            revision: 2,
          }),
          loginAttemptId: LOGIN_ATTEMPT_ID,
          challenge: {
            kind: "device-code" as const,
            url: "https://example.invalid/device",
            userCode: "WXYZ-1234",
          },
        }),
        "providers.profileCopy.login.await": () => new Promise(() => undefined),
        "providers.profileCopy.login.cancel": () => ({
          outcome: recordedOutcome({
            state: "cancelled",
            reason: null,
            revision: 5,
          }),
          loginAttemptId: LOGIN_ATTEMPT_ID,
          challenge: {
            kind: "device-code" as const,
            url: "https://example.invalid/device",
            userCode: "WXYZ-1234",
          },
        }),
        "providers.profileCopy.cancelDraft": () => ({
          result: "current" as const,
          outcome: recordedOutcome({ state: "cancelled", reason: "cancelled" }),
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    harness.spine = spine;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyDraftPanel
            outcome={recordedOutcome({ state: "sign-in-required" })}
            names={COPY_NAMES}
            route="code-paste"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Sign in on Linux box/ }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Sign in on Linux box/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Cancel copy to Linux box" }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel copy to Linux box" }),
    );
    const confirm = within(screen.getByTestId("confirm-destructive-dialog"));
    expect(confirm.getByText(/stops the sign-in/)).toBeTruthy();
    fireEvent.click(confirm.getByRole("button", { name: "Cancel copy" }));
    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) => call.method === "providers.profileCopy.login.cancel",
        ),
      ).toBe(true),
    );
    expect(
      messenger.calls.find(
        (call) => call.method === "providers.profileCopy.login.cancel",
      )?.params,
    ).toMatchObject({ loginAttemptId: LOGIN_ATTEMPT_ID });
    expect(
      messenger.calls.some(
        (call) => call.method === "providers.profileCopy.cancelDraft",
      ),
    ).toBe(false);
  });

  it("withdraws Verify after a direct blocked unsupported-auth answer", async () => {
    const queryClient = createAppQueryClient();
    const pending = recordedOutcome({
      state: "verification-pending",
      revision: 6,
      readiness: {
        preparation: "complete",
        verification: "not-checked",
        verificationRevision: null,
        acceptedVerificationRevision: null,
        identity: "not-checked",
        identityRevision: null,
        acceptedIdentityRevision: null,
        writer: "none",
        writerGeneration: 0,
        quarantined: false,
      },
    });
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: pending,
        }),
        "providers.profileCopy.verify": () => ({
          result: "current" as const,
          outcome: recordedOutcome({
            state: "blocked",
            reason: "unsupported-auth",
            revision: 6,
          }),
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    harness.spine = spine;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyDraftPanel
            outcome={pending}
            names={COPY_NAMES}
            route="automatic"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Verify" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(
        useProfileCopyFlowStore.getState().directBlocks[
          pending.attempt.attemptId
        ],
      ).toEqual({
        verb: "verify",
        revision: 6,
        reason: "unsupported-auth",
        repeats: 1,
      }),
    );
    await waitFor(() =>
      expect(
        messenger.calls.filter(
          (call) => call.method === "providers.profileCopy.draftStatus",
        ).length,
      ).toBeGreaterThan(1),
    );
    // The re-read has LANDED: the row is pending, not blocked, at the same
    // revision - so a missing Verify now is the refusal memory, not the state.
    await waitFor(() =>
      expect(screen.getByText("Verification pending")).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify again" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Cancel this device" }),
    ).toBeTruthy();
  });

  it("sends setPreference with desiredEnabled and never shows the profile as ready", async () => {
    const queryClient = createAppQueryClient();
    const pending = recordedOutcome({
      state: "verification-pending",
      desiredEnabled: false,
      targetProfileId: TARGET_PROFILE_ID,
    });
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: pending,
        }),
        "providers.profileCopy.setPreference": (params) => ({
          result: "current" as const,
          outcome: { ...pending, desiredEnabled: params.desiredEnabled },
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    harness.spine = spine;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyDraftPanel
            outcome={pending}
            names={COPY_NAMES}
            route="automatic"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByRole("switch")).toBeTruthy());
    expect(screen.queryByText(/^Signed in$/)).toBeNull();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(
        messenger.calls.some(
          (call) => call.method === "providers.profileCopy.setPreference",
        ),
      ).toBe(true),
    );
    expect(
      messenger.calls.find(
        (call) => call.method === "providers.profileCopy.setPreference",
      )?.params,
    ).toMatchObject({ desiredEnabled: true });
    expect(screen.queryByText(/^Signed in$/)).toBeNull();
  });

  it("keeps login.touch firing across panel re-renders every 30s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const queryClient = createAppQueryClient();
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: recordedOutcome({ state: "sign-in-required" }),
        }),
        "providers.profileCopy.login.start": () => ({
          outcome: recordedOutcome({
            state: "signing-in",
            reason: null,
            revision: 2,
          }),
          loginAttemptId: LOGIN_ATTEMPT_ID,
          challenge: {
            kind: "code-paste" as const,
            url: "https://example.invalid/login",
          },
        }),
        "providers.profileCopy.login.await": () => new Promise(() => undefined),
        "providers.profileCopy.login.touch": () => ({
          outcome: recordedOutcome({
            state: "signing-in",
            reason: null,
            revision: 2,
          }),
          loginAttemptId: LOGIN_ATTEMPT_ID,
          challenge: {
            kind: "code-paste" as const,
            url: "https://example.invalid/login",
          },
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    harness.spine = spine;

    let panelCommits = 0;
    function TickingPanel(): ReactNode {
      const [tick, setTick] = useState(0);
      useEffect(() => {
        const id = window.setInterval(() => {
          setTick((value) => value + 1);
        }, 30_000);
        return () => window.clearInterval(id);
      }, []);
      const base = useMemo(
        () => recordedOutcome({ state: "sign-in-required" }),
        [],
      );
      return (
        <Profiler
          id="draft-panel"
          onRender={(_id, phase) => {
            if (phase === "update") panelCommits += 1;
          }}
        >
          <ProfileCopyDraftPanel
            outcome={{ ...base }}
            names={COPY_NAMES}
            route="code-paste"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={<span hidden data-tick={tick} />}
          />
        </Profiler>
      );
    }

    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <TickingPanel />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Sign in on Linux box/ }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Sign in on Linux box/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Cancel copy to Linux box" }),
      ).toBeTruthy(),
    );
    const commitsAtArm = panelCommits;
    const touchCount = (): number =>
      messenger.calls.filter(
        (call) => call.method === "providers.profileCopy.login.touch",
      ).length;
    expect(touchCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(touchCount()).toBe(0);
    expect(panelCommits).toBeGreaterThan(commitsAtArm);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(touchCount()).toBe(1);
    expect(panelCommits).toBeGreaterThanOrEqual(commitsAtArm + 2);
    const firstTouch = messenger.calls.find(
      (call) => call.method === "providers.profileCopy.login.touch",
    );
    expect(firstTouch?.authority.endpoint.hostId).toBe(DEST_HOST_ID);
    expect(firstTouch?.params).toMatchObject({
      loginAttemptId: LOGIN_ATTEMPT_ID,
      expectedRevision: 2,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(touchCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(touchCount()).toBe(2);
  });

  it("reads already-present enablement and auth from the destination's providers.list", async () => {
    const queryClient = createAppQueryClient();
    const destMessenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-d",
      handlers: {
        "providers.list": () => ({
          providers: [
            claudeProviderState([
              { ...managedProfile(TARGET_PROFILE_ID, "Work"), enabled: false },
            ]),
          ],
          native: null,
        }),
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: recordedOutcome({
            state: "already-present",
            targetProfileId: TARGET_PROFILE_ID,
            targetEnabled: null,
            targetAuthStatus: null,
          }),
        }),
      },
    });
    const sourceMessenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-s",
      handlers: {
        "providers.list": () => ({
          providers: [
            claudeProviderState([
              { ...managedProfile(TARGET_PROFILE_ID, "Work"), enabled: true },
            ]),
          ],
          native: null,
        }),
      },
    });
    const destSpine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === DEST_HOST_ID
          ? hostDirectoryEntry(DEST_HOST_ID, "Linux box")
          : null,
      messenger: destMessenger,
    });
    const sourceSpine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        hostId === SOURCE_HOST_ID
          ? hostDirectoryEntry(SOURCE_HOST_ID, "Studio Mac")
          : null,
      messenger: sourceMessenger,
    });
    destSpine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    sourceSpine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    harness.clientFor = (hostId) => {
      if (hostId === DEST_HOST_ID) {
        return destSpine.createRequesterForHostId(hostId);
      }
      if (hostId === SOURCE_HOST_ID) {
        return sourceSpine.createRequesterForHostId(hostId);
      }
      return null;
    };
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyDraftPanel
            outcome={recordedOutcome({
              state: "already-present",
              targetProfileId: TARGET_PROFILE_ID,
              targetEnabled: null,
              targetAuthStatus: null,
            })}
            names={COPY_NAMES}
            route="automatic"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText(/Turned off · Signed in/)).toBeTruthy(),
    );
    expect(
      destMessenger.calls.some((call) => call.method === "providers.list"),
    ).toBe(true);
    expect(
      destMessenger.calls.find((call) => call.method === "providers.list")
        ?.authority.endpoint.hostId,
    ).toBe(DEST_HOST_ID);
    expect(
      sourceMessenger.calls.some((call) => call.method === "providers.list"),
    ).toBe(false);
  });

  it("offers Verify again after a blocked login-start-unavailable Verify, then shared-resource copy on repeat", async () => {
    const queryClient = createAppQueryClient();
    const pending = recordedOutcome({
      state: "verification-pending",
      revision: 4,
      readiness: {
        preparation: "complete",
        verification: "not-checked",
        verificationRevision: null,
        acceptedVerificationRevision: null,
        identity: "not-checked",
        identityRevision: null,
        acceptedIdentityRevision: null,
        writer: "none",
        writerGeneration: 0,
        quarantined: false,
      },
    });
    let draftReads = 0;
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.draftStatus": () => {
          draftReads += 1;
          return { result: "current" as const, outcome: pending };
        },
        "providers.profileCopy.verify": () => ({
          result: "current" as const,
          outcome: recordedOutcome({
            state: "blocked",
            reason: "login-start-unavailable",
            revision: 4,
          }),
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    harness.spine = spine;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyDraftPanel
            outcome={pending}
            names={COPY_NAMES}
            route="automatic"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Verify" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(
        screen.getByText(/Verify couldn't start on Linux box right now/),
      ).toBeTruthy(),
    );
    // The blocked answer is re-read at once (the host never stores it). Once
    // that read lands the row is pending again, and the refusal is still said
    // - as a notice at this revision - with Verify, never Sign in, offered.
    // The transient blocked wording is pinned in profile-copy-presentation.
    await waitFor(() => expect(draftReads).toBeGreaterThan(1));
    await waitFor(() =>
      expect(screen.getByText("Verification pending")).toBeTruthy(),
    );
    expect(
      screen.getByText(/Verify couldn't start on Linux box right now/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sign in/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Verify again" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          /Another Claude Code sign-in is still holding a shared resource on Linux box/,
        ),
      ).toBeTruthy(),
    );
  });

  it("keeps Sign in after a login-start-unavailable refusal and shows shared copy on repeat", async () => {
    const queryClient = createAppQueryClient();
    const required = recordedOutcome({ state: "sign-in-required" });
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: required,
        }),
        "providers.profileCopy.login.start": () => ({
          outcome: recordedOutcome({
            state: "blocked",
            reason: "login-start-unavailable",
            revision: 1,
          }),
          loginAttemptId: null,
          challenge: null,
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    harness.spine = spine;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyDraftPanel
            outcome={required}
            names={COPY_NAMES}
            route="code-paste"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Sign in on Linux box/ }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Sign in on Linux box/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Sign-in couldn't start on Linux box right now/),
      ).toBeTruthy(),
    );
    // Until the re-read lands the row is the blocked answer ("Try sign-in
    // again"); after it, the draft reads sign-in-required again.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Sign in on Linux box/ }),
      ).toBeTruthy(),
    );
    expect(
      screen.getByText(/Sign-in couldn't start on Linux box right now/),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Sign in on Linux box/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          /Another Claude Code sign-in is still holding a shared resource on Linux box/,
        ),
      ).toBeTruthy(),
    );
  });

  it("withdraws Sign in for a route-closed refusal at this revision and offers it again at a new revision", async () => {
    const queryClient = createAppQueryClient();
    const first = recordedOutcome({ state: "sign-in-required", revision: 1 });
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: first,
        }),
        "providers.profileCopy.login.start": () => ({
          outcome: recordedOutcome({
            state: "blocked",
            reason: "adapter-not-admitted",
            revision: 1,
          }),
          loginAttemptId: null,
          challenge: null,
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    harness.spine = spine;
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyDraftPanel
            outcome={first}
            names={COPY_NAMES}
            route="code-paste"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Sign in on Linux box/ }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Sign in on Linux box/ }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Sign in on Linux box/ }),
      ).toBeNull(),
    );
    const next = recordedOutcome({ state: "sign-in-required", revision: 2 });
    rerender(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyDraftPanel
            outcome={next}
            names={COPY_NAMES}
            route="code-paste"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole("button", { name: /Sign in on Linux box/ }),
    ).toBeTruthy();
  });

  it("shows the failed-read notice after Verify returns verification-pending not-checked", async () => {
    const queryClient = createAppQueryClient();
    const pending = recordedOutcome({
      state: "verification-pending",
      revision: 3,
      reason: "verification-unavailable",
      readiness: {
        preparation: "complete",
        verification: "not-checked",
        verificationRevision: null,
        acceptedVerificationRevision: null,
        identity: "not-checked",
        identityRevision: null,
        acceptedIdentityRevision: null,
        writer: "none",
        writerGeneration: 0,
        quarantined: false,
      },
    });
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: pending,
        }),
        "providers.profileCopy.verify": () => ({
          result: "current" as const,
          outcome: pending,
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    harness.spine = spine;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyDraftPanel
            outcome={pending}
            names={COPY_NAMES}
            route="automatic"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Verify" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(
        screen.getByText(/Couldn't read the copied settings on Linux box/),
      ).toBeTruthy(),
    );
    expect(
      messenger.calls.filter(
        (call) => call.method === "providers.profileCopy.verify",
      ),
    ).toHaveLength(1);
  });

  it("shows the verify-timeout notice when Verify returns verification-timeout", async () => {
    const queryClient = createAppQueryClient();
    const pending = recordedOutcome({
      state: "verification-pending",
      revision: 3,
      reason: "verification-timeout",
      readiness: {
        preparation: "complete",
        verification: "not-checked",
        verificationRevision: null,
        acceptedVerificationRevision: null,
        identity: "not-checked",
        identityRevision: null,
        acceptedIdentityRevision: null,
        writer: "none",
        writerGeneration: 0,
        quarantined: false,
      },
    });
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.draftStatus": () => ({
          result: "current" as const,
          outcome: pending,
        }),
        "providers.profileCopy.verify": () => ({
          result: "current" as const,
          outcome: pending,
        }),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    harness.spine = spine;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyDraftPanel
            outcome={pending}
            names={COPY_NAMES}
            route="automatic"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Verify" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          /Claude Code didn't answer the check on Linux box in time/,
        ),
      ).toBeTruthy(),
    );
  });

  const startedJobPanelShapes: ReadonlyArray<{
    readonly reason: ProfileCopyReason;
    readonly notice: string;
    readonly withdraws: boolean;
  }> = [
    {
      reason: "login-start-unavailable",
      notice:
        "Sign-in couldn't start on Linux box: it may not accept the copied Claude Code settings. Cancel this device and copy again.",
      withdraws: true,
    },
    {
      reason: "device-auth-unavailable",
      notice:
        "Device-code sign-in isn't turned on for this Claude Code account. Turn it on in the account's security settings, then check again.",
      withdraws: true,
    },
    {
      reason: "login-resource-busy",
      notice: profileCopySharedResourceCopy(COPY_NAMES),
      withdraws: false,
    },
  ];

  for (const shape of startedJobPanelShapes) {
    it(`shows a start-refused notice for a started job with no challenge (${shape.reason})`, async () => {
      const queryClient = createAppQueryClient();
      let draftReads = 0;
      const messenger = new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "req-1",
        handlers: {
          "providers.profileCopy.draftStatus": () => {
            draftReads += 1;
            return {
              result: "current" as const,
              outcome: recordedOutcome({
                state: "sign-in-required",
                revision: draftReads === 1 ? 1 : 5,
              }),
            };
          },
          "providers.profileCopy.login.start": () => ({
            outcome: recordedOutcome({
              state: "blocked",
              reason: shape.reason,
              revision: 3,
            }),
            loginAttemptId: LOGIN_ATTEMPT_ID,
            challenge: null,
          }),
          "providers.profileCopy.login.await": () => ({
            outcome: recordedOutcome({
              state: "sign-in-required",
              revision: 4,
            }),
            loginAttemptId: LOGIN_ATTEMPT_ID,
            challenge: {
              kind: "code-paste" as const,
              url: "https://example.invalid/login",
            },
          }),
        },
      });
      const spine = new HostClient<HostRpcRegistry>({
        registry: hostRpcRegistry,
        schedulingPolicy: hostRpcSchedulingPolicy,
        invalidator: createHostQueryInvalidator(queryClient),
        findHostById: (hostId) =>
          harness.hosts.find((host) => host.hostId === hostId)?.entry ??
          hostDirectoryEntry(hostId, hostId),
        messenger,
      });
      spine.setRequestContext(
        createRequestContextFixture({
          origin: "renderer",
          bearerToken: "tok-draft",
        }),
      );
      harness.spine = spine;
      render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ProfileCopyDraftPanel
              outcome={recordedOutcome({
                state: "sign-in-required",
                revision: 1,
              })}
              names={COPY_NAMES}
              route="code-paste"
              cancelRequested={false}
              destinationIsLocal={false}
              extraActions={null}
            />
          </TooltipProvider>
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /Sign in on Linux box/ }),
        ).toBeTruthy(),
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Sign in on Linux box/ }),
      );
      await waitFor(() => expect(draftReads).toBeGreaterThan(1));
      // The re-read (revision 5, sign-in-required) has LANDED: while the row
      // was still the revision-3 blocked answer, its body hid this sentence.
      await waitFor(() =>
        expect(
          screen.getByText(
            "Sign in on Linux box to finish. The name and color are already set.",
          ),
        ).toBeTruthy(),
      );
      // Exactly one element says it, and it is the login NOTICE (a status
      // line), not the row body the blocked answer rendered.
      const noticeMatches = screen.getAllByText(shape.notice);
      expect(noticeMatches).toHaveLength(1);
      expect(noticeMatches[0]?.getAttribute("role")).toBe("status");
      expect(
        messenger.calls.filter(
          (call) => call.method === "providers.profileCopy.login.await",
        ),
      ).toHaveLength(0);
      if (shape.withdraws) {
        expect(
          screen.queryByRole("button", { name: /Sign in on Linux box/ }),
        ).toBeNull();
      } else {
        expect(
          screen.getByRole("button", { name: /Sign in on Linux box/ }),
        ).toBeTruthy();
      }
    });
  }

  it("clears the start-refused notice on the next start", async () => {
    const queryClient = createAppQueryClient();
    let starts = 0;
    let draftReads = 0;
    const busyNotice = profileCopySharedResourceCopy(COPY_NAMES);
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.profileCopy.draftStatus": () => {
          draftReads += 1;
          return {
            result: "current" as const,
            outcome: recordedOutcome({
              state: "sign-in-required",
              revision: draftReads === 1 ? 1 : 5,
            }),
          };
        },
        "providers.profileCopy.login.start": () => {
          starts += 1;
          if (starts === 1) {
            return {
              outcome: recordedOutcome({
                state: "blocked",
                reason: "login-resource-busy",
                revision: 3,
              }),
              loginAttemptId: LOGIN_ATTEMPT_ID,
              challenge: null,
            };
          }
          return {
            outcome: recordedOutcome({
              state: "signing-in",
              reason: null,
              revision: 6,
            }),
            loginAttemptId: LOGIN_ATTEMPT_ID,
            challenge: {
              kind: "code-paste" as const,
              url: "https://example.invalid/login",
            },
          };
        },
        "providers.profileCopy.login.await": () => new Promise(() => undefined),
      },
    });
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      schedulingPolicy: hostRpcSchedulingPolicy,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) =>
        harness.hosts.find((host) => host.hostId === hostId)?.entry ??
        hostDirectoryEntry(hostId, hostId),
      messenger,
    });
    spine.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "tok-draft",
      }),
    );
    harness.spine = spine;
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProfileCopyDraftPanel
            outcome={recordedOutcome({
              state: "sign-in-required",
              revision: 1,
            })}
            names={COPY_NAMES}
            route="code-paste"
            cancelRequested={false}
            destinationIsLocal={false}
            extraActions={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Sign in on Linux box/ }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Sign in on Linux box/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          "Sign in on Linux box to finish. The name and color are already set.",
        ),
      ).toBeTruthy(),
    );
    const busyMatches = screen.getAllByText(busyNotice);
    expect(busyMatches).toHaveLength(1);
    expect(busyMatches[0]?.getAttribute("role")).toBe("status");
    fireEvent.click(
      screen.getByRole("button", { name: /Sign in on Linux box/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Cancel copy to Linux box" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(busyNotice)).toBeNull();
  });
});
