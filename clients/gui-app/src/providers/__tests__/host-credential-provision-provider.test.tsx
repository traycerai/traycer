import "../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { MintHostCredentialFetchResult } from "@traycer-clients/shared/auth/devices-sessions-fetcher";
import type { StepUpCredential } from "@/lib/auth/step-up-flow";
import type { StepUpPromptRequest } from "@/lib/auth/step-up-prompt";
import {
  appHostCredentialMintFlow,
  resetHostCredentialProvisioning,
  setHostCredentialMintRunner,
  setHostCredentialProvisionGate,
} from "@/lib/auth/host-credential-provisioning";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Captures the active step-up prompt so tests can resolve/reject it without
 * driving Radix dialog DOM (which is flaky in this suite).
 */
const dialogState = vi.hoisted<{
  request: StepUpPromptRequest | null;
  /** Distinct prompt ids ever shown (not re-renders of the same request). */
  shownPromptIds: number[];
}>(() => ({
  request: null,
  shownPromptIds: [],
}));

const mintHostCredentialMock = vi.hoisted(() =>
  vi.fn(
    (
      _request: {
        readonly hostId: string;
        readonly hostLabel: string | null;
        readonly platform: string | null;
      },
      _useStepUp: boolean,
    ): Promise<MintHostCredentialFetchResult> =>
      Promise.resolve({
        kind: "ok",
        response: {
          token: "host-access-jws",
          refreshToken: "host-refresh-jwe",
          familyId: "family-1",
          hostId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          expiresIn: 900,
          provisionedAt: "2026-07-08T12:00:00.000Z",
        },
      }),
  ),
);

const hostBindingState = vi.hoisted<{
  auth: { mintHostCredential: typeof mintHostCredentialMock } | null;
}>(() => ({
  auth: { mintHostCredential: mintHostCredentialMock },
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () =>
    hostBindingState.auth === null ? null : { auth: hostBindingState.auth },
  useHostDirectory: () => ({
    findById: (hostId: string) =>
      hostId.length === 0 ? undefined : { hostId, label: "Test Host" },
  }),
}));

vi.mock("@/providers/use-runner-host", () => ({
  // No cross-window gate — these tests pin the identity fence, not the claim registry.
  useRunnerHostOrNull: () => null,
}));

vi.mock("@/components/auth/step-up-challenge-dialog", () => ({
  StepUpChallengeDialog: (props: {
    readonly request: StepUpPromptRequest | null;
    readonly onVerified: (credential: StepUpCredential) => void;
    readonly onCancel: () => void;
  }): ReactNode => {
    dialogState.request = props.request;
    if (
      props.request !== null &&
      !dialogState.shownPromptIds.includes(props.request.id)
    ) {
      dialogState.shownPromptIds.push(props.request.id);
    }
    return null;
  },
}));

import { HostCredentialProvisionProvider } from "@/providers/host-credential-provision-provider";

const HOST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function signIn(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.com` },
    contextMetadata: { userId, username: userId },
  });
}

function signOut(): void {
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
  });
}

function switchUser(userId: string): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: { userId, userName: userId, email: `${userId}@example.com` },
    contextMetadata: { userId, username: userId },
  });
}

function stepUpCredential(): StepUpCredential {
  return { expiresAtMs: Date.now() + 60_000 };
}

async function waitForPrompt(): Promise<StepUpPromptRequest> {
  await waitFor(() => {
    expect(dialogState.request).not.toBeNull();
  });
  const request = dialogState.request;
  if (request === null) {
    throw new Error("expected an active step-up prompt");
  }
  return request;
}

function renderProvider(): void {
  render(
    <HostCredentialProvisionProvider>
      <div data-testid="child" />
    </HostCredentialProvisionProvider>,
  );
}

describe("<HostCredentialProvisionProvider /> identity fence", () => {
  beforeEach(() => {
    dialogState.request = null;
    dialogState.shownPromptIds = [];
    mintHostCredentialMock.mockClear();
    mintHostCredentialMock.mockResolvedValue({
      kind: "ok",
      response: {
        token: "host-access-jws",
        refreshToken: "host-refresh-jwe",
        familyId: "family-1",
        hostId: HOST_ID,
        expiresIn: 900,
        provisionedAt: "2026-07-08T12:00:00.000Z",
      },
    });
    hostBindingState.auth = { mintHostCredential: mintHostCredentialMock };
    setHostCredentialMintRunner(null);
    setHostCredentialProvisionGate(null);
    resetHostCredentialProvisioning();
    signIn("user-a");
  });

  afterEach(() => {
    cleanup();
    setHostCredentialMintRunner(null);
    setHostCredentialProvisionGate(null);
    resetHostCredentialProvisioning();
    signOut();
  });

  it("does not mint when identity changes after OTP succeeds (orphaned-credential guard)", async () => {
    // Load-bearing: the generation fence alone would return unavailable AFTER
    // minting, leaving a superseding server row. The provider must refuse to
    // call mintHostCredential at all once the signed-in user has changed.
    renderProvider();

    const attempt = appHostCredentialMintFlow({
      hostId: HOST_ID,
      reason: "missing",
    });
    const prompt = await waitForPrompt();

    act(() => {
      // Resolve the dialog first, then flip identity before the runner
      // continues past the await — identityRef updates, so mint must not fire.
      prompt.resolve(stepUpCredential());
      switchUser("user-b");
    });

    // Weight: mint must not fire. Outcome is secondary (generation fence
    // rewrites cancel → unavailable when identity moves mid-flight).
    expect(mintHostCredentialMock).not.toHaveBeenCalled();
    await expect(attempt).resolves.toEqual({ kind: "unavailable" });
  });

  it("rejects the visible prompt on identity change so the attempt settles", async () => {
    renderProvider();

    const attempt = appHostCredentialMintFlow({
      hostId: HOST_ID,
      reason: "missing",
    });
    await waitForPrompt();
    expect(dialogState.request).not.toBeNull();

    act(() => {
      signOut();
    });

    // Weight: dialog gone + mint never fired + attempt settles (no hang).
    // Outcome is unavailable, not declined: the provider maps cancel → declined,
    // but identity change also calls resetHostCredentialProvisioning(), which
    // bumps generation; the flow fence then rewrites the result to unavailable
    // so an attempt for a departed identity cannot hand anything to a transport
    // now serving someone else. declined would mean the user said no — nobody did.
    expect(dialogState.request).toBeNull();
    expect(mintHostCredentialMock).not.toHaveBeenCalled();
    await expect(attempt).resolves.toEqual({ kind: "unavailable" });
  });

  it("does not display a queued prompt after an identity change", async () => {
    renderProvider();

    const first = appHostCredentialMintFlow({
      hostId: HOST_ID,
      reason: "missing",
    });
    await waitForPrompt();
    expect(dialogState.shownPromptIds).toHaveLength(1);

    // Second host queues behind the first dialog via promptChainRef.
    const second = appHostCredentialMintFlow({
      hostId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      reason: "missing",
    });
    // Still only the first host's prompt is visible.
    expect(dialogState.shownPromptIds).toHaveLength(1);

    act(() => {
      switchUser("user-b");
    });

    // Weight: no second dialog shown, mint never fired, both attempts settle.
    // Outcome unavailable for the same generation-fence reason as above.
    expect(dialogState.shownPromptIds).toHaveLength(1);
    expect(dialogState.request).toBeNull();
    expect(mintHostCredentialMock).not.toHaveBeenCalled();
    await expect(first).resolves.toEqual({ kind: "unavailable" });
    await expect(second).resolves.toEqual({ kind: "unavailable" });
  });

  it("mints exactly once when the identity is stable through OTP (control)", async () => {
    // Without this control, the three "mint not called" tests would pass
    // against a provider that can never mint at all.
    renderProvider();

    const attempt = appHostCredentialMintFlow({
      hostId: HOST_ID,
      reason: "missing",
    });
    const prompt = await waitForPrompt();

    act(() => {
      prompt.resolve(stepUpCredential());
    });

    await expect(attempt).resolves.toEqual({
      kind: "provisioned",
      token: "host-access-jws",
      refreshToken: "host-refresh-jwe",
      familyId: "family-1",
      provisionedAt: "2026-07-08T12:00:00.000Z",
      expiresIn: 900,
    });
    expect(mintHostCredentialMock).toHaveBeenCalledTimes(1);
    expect(mintHostCredentialMock).toHaveBeenCalledWith(
      {
        hostId: HOST_ID,
        hostLabel: "Test Host",
        platform: null,
      },
      true,
    );
  });
});
