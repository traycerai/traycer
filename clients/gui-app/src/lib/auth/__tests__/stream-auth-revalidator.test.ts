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
 * In that same branch the revalidator reports a host refusal of the held
 * bearer to the service (`AuthService.noteHostRefusedHeldBearer`), exactly as
 * the unary path does, and nothing more: whether the refusal ends the local
 * plane (authn refused the session AND the held bearer has expired) is the
 * service's call, because only it holds the bearer and the terminal latch. So
 * this suite pins the WIRING - the service is told once on that branch and on
 * no other, and a service that never latched stays inert however the store was
 * set up - and leaves the decision itself to
 * `auth-service-held-session-host-refusal.test.ts`, which also drives this
 * revalidator end to end against a real refused session.
 *
 * `revalidateCurrentContext` is spied on a REAL `AuthService` instance
 * (built the same way `auth-service-authorization-loss.test.ts` does)
 * instead of a hand-rolled stub, because the production type is the concrete
 * class - a narrower object literal would need a cast this repo's lint rules
 * forbid. `noteHostRefusedHeldBearer` is spied on the same instance WITHOUT
 * replacing it, so the real method runs behind every call count.
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
      cloudVerdictLoss: "unreachable",
      hostRefusedHeldBearer: false,
    });
    return;
  }
  useAuthStore.setState({
    status,
    profile: null,
    contextMetadata: null,
    subscriptionStatus: null,
    cloudVerdictLoss: "unreachable",
    hostRefusedHeldBearer: false,
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

  it("reports the host refusal to the service exactly once on the local-plane-retained branch", async () => {
    resetAuth("unverified");
    useAuthStore.setState({ cloudVerdictLoss: "session-rejected" });
    vi.spyOn(service, "revalidateCurrentContext").mockResolvedValue({
      kind: "rejected",
    });
    const noteRefusal = vi.spyOn(service, "noteHostRefusedHeldBearer");
    const revalidator = createStreamAuthRevalidator(service);

    const outcome = await revalidator.revalidateForReconnect();

    expect(outcome).toBe("local-plane-retained");
    expect(noteRefusal).toHaveBeenCalledTimes(1);
    // Reported, not acted on by the revalidator itself: the session stays
    // `unverified` and the flag is the service's to set.
    expect(useAuthStore.getState().status).toBe("unverified");
  });

  it("leaves the decision to the service: a service that never latched stays inert behind the call, whatever the store says", async () => {
    resetAuth("unverified");
    // The store alone says authn refused the session. The flag is not the
    // store's to infer from that (it used to be): only the service holds both
    // the terminal latch and the bearer whose expiry decides it, and this one
    // never latched.
    useAuthStore.setState({ cloudVerdictLoss: "session-rejected" });
    vi.spyOn(service, "revalidateCurrentContext").mockResolvedValue({
      kind: "rejected",
    });
    const noteRefusal = vi.spyOn(service, "noteHostRefusedHeldBearer");
    const revalidator = createStreamAuthRevalidator(service);

    const outcome = await revalidator.revalidateForReconnect();

    expect(outcome).toBe("local-plane-retained");
    expect(noteRefusal).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
  });

  it("reports the refusal once for a session that is still signed-in too (a store fault, not an authn verdict), and the service records nothing", async () => {
    resetAuth("signed-in");
    // A stale latched loss must not turn a signed-in session into a refusal.
    useAuthStore.setState({ cloudVerdictLoss: "session-rejected" });
    vi.spyOn(service, "revalidateCurrentContext").mockResolvedValue({
      kind: "rejected",
    });
    const noteRefusal = vi.spyOn(service, "noteHostRefusedHeldBearer");
    const revalidator = createStreamAuthRevalidator(service);

    const outcome = await revalidator.revalidateForReconnect();

    expect(outcome).toBe("local-plane-retained");
    expect(noteRefusal).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
  });

  it('returns "rejected" and reports no host refusal when the outcome is rejected and the store is signed-out (the revalidator already signed out)', async () => {
    resetAuth("signed-out");
    vi.spyOn(service, "revalidateCurrentContext").mockResolvedValue({
      kind: "rejected",
    });
    const noteRefusal = vi.spyOn(service, "noteHostRefusedHeldBearer");
    const revalidator = createStreamAuthRevalidator(service);

    const outcome = await revalidator.revalidateForReconnect();

    expect(outcome).toBe("rejected");
    expect(noteRefusal).not.toHaveBeenCalled();
    expect(useAuthStore.getState().hostRefusedHeldBearer).toBe(false);
  });

  it('returns "rotated" and reports no host refusal when the outcome is valid', async () => {
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
        environments: { personal: null, teams: [] },
        actingAs: null,
      },
    });
    const noteRefusal = vi.spyOn(service, "noteHostRefusedHeldBearer");
    const revalidator = createStreamAuthRevalidator(service);

    const outcome = await revalidator.revalidateForReconnect();

    expect(outcome).toBe("rotated");
    expect(noteRefusal).not.toHaveBeenCalled();
  });

  it('returns "network-error" and reports no host refusal when the outcome is a network error', async () => {
    resetAuth("unverified");
    useAuthStore.setState({ cloudVerdictLoss: "session-rejected" });
    vi.spyOn(service, "revalidateCurrentContext").mockResolvedValue({
      kind: "network-error",
    });
    const noteRefusal = vi.spyOn(service, "noteHostRefusedHeldBearer");
    const revalidator = createStreamAuthRevalidator(service);

    const outcome = await revalidator.revalidateForReconnect();

    expect(outcome).toBe("network-error");
    expect(noteRefusal).not.toHaveBeenCalled();
  });

  it('returns "rejected" and reports no host refusal when revalidateCurrentContext resolves null (no live context to revalidate)', async () => {
    vi.spyOn(service, "revalidateCurrentContext").mockResolvedValue(null);
    const noteRefusal = vi.spyOn(service, "noteHostRefusedHeldBearer");
    const revalidator = createStreamAuthRevalidator(service);

    const outcome = await revalidator.revalidateForReconnect();

    expect(outcome).toBe("rejected");
    expect(noteRefusal).not.toHaveBeenCalled();
  });
});
