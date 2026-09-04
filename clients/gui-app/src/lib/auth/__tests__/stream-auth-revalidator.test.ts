import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AuthService } from "@/lib/auth/auth-service";
import { createStreamAuthRevalidator } from "@/lib/auth/stream-auth-revalidator";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * `createStreamAuthRevalidator` maps `AuthService.revalidateCurrentContext()`
 * onto the transport-facing `StreamAuthRevalidator` contract. The one branch
 * this suite exists to pin is the newest `RevalidateOutcome` member,
 * `"local-plane-retained"`: a `{ kind: "rejected" }` verdict from AuthnV3 no
 * longer always means "the revalidator signed out" - since `unverified`
 * arrived, a terminal verdict on a HELD identity can instead DEMOTE the
 * session while keeping it admitted to the local plane
 * (`admitsLocalPlane`, `stores/auth/auth-store.ts`). The mapper reads the
 * projected store status (not the outcome kind) to tell the two arms apart,
 * so these tests drive the store directly rather than the full sign-in flow.
 *
 * `revalidateCurrentContext` is spied on a REAL `AuthService` instance
 * (built the same way `auth-service-authorization-loss.test.ts` does)
 * instead of a hand-rolled stub, because the production type is the concrete
 * class - a narrower object literal would need a cast this repo's lint rules
 * forbid.
 */
function makeService(): AuthService {
  const host = new MockRunnerHost({
    signInUrl:
      "https://auth.traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  return new AuthService({ runnerHost: host });
}

function resetAuth(
  status: "signed-out" | "signing-in" | "signed-in" | "unverified",
): void {
  if (status === "signed-in" || status === "unverified") {
    useAuthStore.setState({
      status,
      profile: { userId: "user-1", userName: "user-1", email: "u@e.com" },
      contextMetadata: { userId: "user-1", username: "user-1" },
      subscriptionStatus: status === "signed-in" ? "FREE" : null,
    });
    return;
  }
  useAuthStore.setState({
    status,
    profile: null,
    contextMetadata: null,
    subscriptionStatus: null,
  });
}

describe("createStreamAuthRevalidator", () => {
  let service: AuthService;

  beforeEach(() => {
    resetAuth("signed-out");
    service = makeService();
  });

  afterEach(() => {
    service.dispose();
    resetAuth("signed-out");
    vi.restoreAllMocks();
  });

  it('returns "local-plane-retained" when the outcome is rejected but the store is unverified (demotion, not sign-out)', async () => {
    resetAuth("unverified");
    vi.spyOn(service, "revalidateCurrentContext").mockResolvedValue({
      kind: "rejected",
    });
    const revalidator = createStreamAuthRevalidator(service);

    const outcome = await revalidator.revalidateForReconnect();

    expect(outcome).toBe("local-plane-retained");
  });

  it('returns "rejected" when the outcome is rejected and the store is signed-out (the revalidator already signed out)', async () => {
    resetAuth("signed-out");
    vi.spyOn(service, "revalidateCurrentContext").mockResolvedValue({
      kind: "rejected",
    });
    const revalidator = createStreamAuthRevalidator(service);

    const outcome = await revalidator.revalidateForReconnect();

    expect(outcome).toBe("rejected");
  });

  it('returns "rotated" when the outcome is valid', async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.spyOn(service, "revalidateCurrentContext").mockResolvedValue({
      kind: "valid",
      user: {
        user: {
          id: "user-1",
          name: "User One",
          providerId: "provider-1",
          providerHandle: "user-one",
          providerType: "GITHUB",
          email: "u@e.com",
          avatarUrl: null,
          activatedAt: now,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          privacyMode: false,
          isLearningEnabled: false,
        },
        userSubscription: {
          id: "sub-1",
          userID: "user-1",
          orgID: null,
          teamID: null,
          customerId: "cust-1",
          createdAt: now,
          updatedAt: now,
          subscriptionExpiry: null,
          trialEndsAt: null,
          subscriptionStatus: "FREE",
          hasPaymentMethod: null,
          isInTrial: false,
          rechargeRateSeconds: 0,
        },
        payAsYouGoUsage: { allowPayAsYouGo: false },
        teamSubscriptions: [],
      },
    });
    const revalidator = createStreamAuthRevalidator(service);

    const outcome = await revalidator.revalidateForReconnect();

    expect(outcome).toBe("rotated");
  });

  it('returns "network-error" when the outcome is a network error', async () => {
    vi.spyOn(service, "revalidateCurrentContext").mockResolvedValue({
      kind: "network-error",
    });
    const revalidator = createStreamAuthRevalidator(service);

    const outcome = await revalidator.revalidateForReconnect();

    expect(outcome).toBe("network-error");
  });

  it('returns "rejected" when revalidateCurrentContext resolves null (no live context to revalidate)', async () => {
    vi.spyOn(service, "revalidateCurrentContext").mockResolvedValue(null);
    const revalidator = createStreamAuthRevalidator(service);

    const outcome = await revalidator.revalidateForReconnect();

    expect(outcome).toBe("rejected");
  });
});
