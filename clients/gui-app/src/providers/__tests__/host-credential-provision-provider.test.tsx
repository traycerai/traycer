import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { MintHostCredentialFetchResult } from "@traycer-clients/shared/auth/devices-sessions-fetcher";
import {
  appHostCredentialMintFlow,
  resetHostCredentialProvisioning,
  setHostCredentialMintRunner,
} from "@/lib/auth/host-credential-provisioning";
import { useAuthStore } from "@/stores/auth/auth-store";
import { appLogger } from "@/lib/logger";

const mintHostCredentialMock = vi.hoisted(() =>
  vi.fn(
    (_request: {
      readonly hostId: string;
      readonly hostLabel: string | null;
      readonly platform: string | null;
    }): Promise<MintHostCredentialFetchResult> =>
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

function renderProvider(): void {
  render(
    <HostCredentialProvisionProvider>
      <div data-testid="child" />
    </HostCredentialProvisionProvider>,
  );
}

describe("<HostCredentialProvisionProvider /> silent provisioning", () => {
  beforeEach(() => {
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
    resetHostCredentialProvisioning();
    signIn("user-a");
  });

  afterEach(() => {
    cleanup();
    setHostCredentialMintRunner(null);
    resetHostCredentialProvisioning();
    signOut();
  });

  it("mints immediately with no dialog — a single call, no OTP round trip", async () => {
    renderProvider();

    const attempt = appHostCredentialMintFlow({
      hostId: HOST_ID,
      reason: "missing",
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
    // Single-argument call: no useStepUpCredential flag any more.
    expect(mintHostCredentialMock).toHaveBeenCalledWith({
      hostId: HOST_ID,
      hostLabel: "Test Host",
      platform: null,
    });
  });

  it("does not hand back a credential minted after identity changes mid-flight", async () => {
    const deferred: {
      resolve: ((result: MintHostCredentialFetchResult) => void) | null;
    } = { resolve: null };
    mintHostCredentialMock.mockImplementationOnce(
      () =>
        new Promise<MintHostCredentialFetchResult>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    renderProvider();

    const attempt = appHostCredentialMintFlow({
      hostId: HOST_ID,
      reason: "missing",
    });

    act(() => {
      switchUser("user-b");
    });

    const resolveMint = deferred.resolve;
    if (resolveMint === null) {
      throw new Error("mint was never started");
    }
    resolveMint({
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

    // The mint DID fire (provisioning is not identity-gated up front) but the
    // credential must not be handed to a transport now serving another user.
    await expect(attempt).resolves.toEqual({ kind: "unavailable" });
  });

  it("resolves unavailable without minting when the host binding has no auth service", async () => {
    hostBindingState.auth = null;
    renderProvider();

    await expect(
      appHostCredentialMintFlow({ hostId: HOST_ID, reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(mintHostCredentialMock).not.toHaveBeenCalled();
  });

  it("resolves unavailable on a superseded (409) mint response", async () => {
    mintHostCredentialMock.mockResolvedValueOnce({ kind: "superseded" });
    renderProvider();

    await expect(
      appHostCredentialMintFlow({ hostId: HOST_ID, reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(mintHostCredentialMock).toHaveBeenCalledTimes(1);
  });

  it("resolves unavailable when the mint call throws", async () => {
    mintHostCredentialMock.mockRejectedValueOnce(new Error("network down"));
    renderProvider();

    await expect(
      appHostCredentialMintFlow({ hostId: HOST_ID, reason: "missing" }),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  describe("a host the cloud refuses on every mint", () => {
    const REFUSED_HOST_ID = "host-refused";

    beforeEach(() => {
      mintHostCredentialMock.mockResolvedValue({ kind: "superseded" });
      vi.useFakeTimers();
      vi.setSystemTime(0);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("climbs the escalation ladder instead of minting on every ask", async () => {
      renderProvider();
      const ask = () =>
        appHostCredentialMintFlow({
          hostId: REFUSED_HOST_ID,
          reason: "missing",
        });

      await expect(ask()).resolves.toEqual({ kind: "unavailable" });
      expect(mintHostCredentialMock).toHaveBeenCalledTimes(1);

      // The first refusal waits 0: the next transport's ask still mints.
      vi.setSystemTime(1_000);
      await expect(ask()).resolves.toEqual({ kind: "unavailable" });
      expect(mintHostCredentialMock).toHaveBeenCalledTimes(2);

      // Two refusals in: the rung is 120s counted from the second one (t=1s).
      vi.setSystemTime(2_000);
      await expect(ask()).resolves.toEqual({
        kind: "pending-elsewhere",
        retryAfterMs: 119_000,
      });
      expect(mintHostCredentialMock).toHaveBeenCalledTimes(2);

      vi.setSystemTime(1_000 + 120_000);
      await expect(ask()).resolves.toEqual({ kind: "unavailable" });
      expect(mintHostCredentialMock).toHaveBeenCalledTimes(3);
    });

    it("logs each spent mint with its attempt and the wait that follows, and no user identity", async () => {
      const info = vi.spyOn(appLogger, "info").mockImplementation(() => {});
      renderProvider();
      const ask = () =>
        appHostCredentialMintFlow({
          hostId: REFUSED_HOST_ID,
          reason: "missing",
        });

      await ask();
      vi.setSystemTime(1_000);
      await ask();
      vi.setSystemTime(1_000 + 120_000);
      await ask();

      const spentLines = info.mock.calls.filter(
        ([message]) => message === "Host credential mint handed nothing back",
      );
      expect(spentLines).toEqual([
        [
          "Host credential mint handed nothing back",
          { hostId: REFUSED_HOST_ID, attempt: 1, nextMintWaitMs: 0 },
        ],
        [
          "Host credential mint handed nothing back",
          { hostId: REFUSED_HOST_ID, attempt: 2, nextMintWaitMs: 120_000 },
        ],
        [
          "Host credential mint handed nothing back",
          { hostId: REFUSED_HOST_ID, attempt: 3, nextMintWaitMs: 240_000 },
        ],
      ]);
      const logged = JSON.stringify(spentLines);
      expect(logged).not.toContain("user-a");
      expect(logged).not.toContain("example.com");
    });
  });
});
