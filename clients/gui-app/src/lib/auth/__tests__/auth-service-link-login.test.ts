/**
 * The link-login attempt fence: link claim/poll runs inside the SAME
 * `Attempt` lifecycle as device sign-in, so a link attempt superseded by a
 * newer sign-in is a silent no-op — its late approval can never overwrite
 * the newer session, and its late denial can never project a global
 * failure over it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type {
  ITokenStore,
  StoredCredentials,
  StoredCredentialsIdentity,
} from "@traycer-clients/shared/platform/runner-host";
import {
  AUTH_ERROR_STORE_UNAVAILABLE,
  AuthService,
} from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";

const CLAIM_URL = "http://localhost:5005/api/v3/auth/link/claim";
const TOKEN_URL = "http://localhost:5005/api/v3/auth/link/token";
const VALIDATION_URL = "http://localhost:5005/api/v3/user";

const PROFILE_BODY = {
  user: {
    id: "user-1",
    name: "Test User",
    providerId: "gh-1",
    providerHandle: "test-user",
    providerType: "GITHUB",
    email: "test@example.com",
    avatarUrl: null,
    activatedAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    lastSeenAt: null,
    privacyMode: false,
    isLearningEnabled: true,
  },
  userSubscription: {
    id: "sub-1",
    userID: "user-1",
    orgID: null,
    teamID: null,
    customerId: "cus-1",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    subscriptionExpiry: null,
    trialEndsAt: null,
    subscriptionStatus: "FREE",
    hasPaymentMethod: false,
    isInTrial: false,
    rechargeRateSeconds: 0,
  },
  teamSubscriptions: [],
  payAsYouGoUsage: { allowPayAsYouGo: false },
};

const trackedServices: AuthService[] = [];

function makeService(): { service: AuthService; host: MockRunnerHost } {
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
  const service = new AuthService({ runnerHost: host });
  trackedServices.push(service);
  return { service, host };
}

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface LinkFetchScript {
  /** Mutable: the claim outcome, whose `interval` paces the poll loop. */
  claimResponse: () => Response;
  /** Mutable: the next token-poll outcome. */
  tokenResponse: () => Response;
  /** Mutable: the /api/v3/user identity-validation outcome. */
  validationResponse: () => Response;
  readonly tokenPolls: string[];
}

function installLinkFetch(): { script: LinkFetchScript; restore: () => void } {
  const script: LinkFetchScript = {
    claimResponse: () =>
      json({ status: "claimed", secret: "S".repeat(43), interval: 1 }, 200),
    tokenResponse: () => json({ error: "authorization_pending" }, 428),
    validationResponse: () => new Response(null, { status: 401 }),
    tokenPolls: [],
  };
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      if (url === CLAIM_URL) {
        return Promise.resolve(script.claimResponse());
      }
      if (url === TOKEN_URL) {
        script.tokenPolls.push(url);
        return Promise.resolve(script.tokenResponse());
      }
      if (url === VALIDATION_URL) {
        return Promise.resolve(script.validationResponse());
      }
      // Anything else (refresh, sessions) answering 401 keeps stray calls
      // from accidentally signing anything in.
      return Promise.resolve(new Response(null, { status: 401 }));
    },
  });
  return {
    script,
    restore: () => {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  useAuthStore.getState().setSignedOut();
});

afterEach(() => {
  for (const service of trackedServices.splice(0)) {
    service.dispose();
  }
  useAuthStore.getState().setSignedOut();
  vi.useRealTimers();
});

describe("link-login attempt fence", () => {
  it("a late approval of a superseded link attempt is discarded, never applied", async () => {
    const { service } = makeService();
    const { script, restore } = installLinkFetch();
    try {
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      // Let the claim land and one pending poll pass.
      await vi.advanceTimersByTimeAsync(1_100);
      expect(script.tokenPolls.length).toBeGreaterThan(0);
      expect(useAuthStore.getState().status).toBe("signing-in");

      // A newer sign-in supersedes the link attempt.
      const deviceSignIn = service.signIn();

      // The next link poll would come back authorized — but the attempt is
      // no longer current, so the tokens must be dropped without ever being
      // validated or persisted.
      script.tokenResponse = () =>
        json(
          {
            token: "stolen-token",
            refreshToken: "stolen-refresh",
            familyId: "f",
          },
          200,
        );
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await linkResult;
      expect(result.kind).toBe("superseded");

      const stored = service.getCurrentSessionSnapshot();
      expect(stored.token).not.toBe("stolen-token");
      await deviceSignIn;
    } finally {
      restore();
    }
  });

  it("a late denial of a superseded link attempt cannot project a global failure", async () => {
    const { service } = makeService();
    const { script, restore } = installLinkFetch();
    try {
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(1_100);

      const deviceSignIn = service.signIn();
      const statusAfterSupersede = useAuthStore.getState().status;

      script.tokenResponse = () => json({ error: "access_denied" }, 400);
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await linkResult;
      // Silent no-op: no error surfaced, the superseding flow owns the state.
      expect(result.kind).toBe("superseded");
      expect(service.getLastError()).toBeNull();
      expect(useAuthStore.getState().status).toBe(statusAfterSupersede);
      await deviceSignIn;
    } finally {
      restore();
    }
  });

  it("a 429 carrying no Retry-After backs off to the advertised interval, not the floor", async () => {
    const { service } = makeService();
    const { script, restore } = installLinkFetch();
    try {
      script.claimResponse = () =>
        json({ status: "claimed", secret: "S".repeat(43), interval: 5 }, 200);
      // A bare 429 — what a rate limiter answers when nothing along the way
      // attaches a directive. Read as zero it would collapse the wait to the
      // 1s floor and hammer the bucket that just rejected the poll.
      script.tokenResponse = () => json({ error: "slow_down" }, 429);
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");

      await vi.advanceTimersByTimeAsync(5_100);
      expect(script.tokenPolls.length).toBe(1);
      // At the 1s floor this window would hold four more polls.
      await vi.advanceTimersByTimeAsync(4_800);
      expect(script.tokenPolls.length).toBe(1);
      await vi.advanceTimersByTimeAsync(300);
      expect(script.tokenPolls.length).toBe(2);

      script.tokenResponse = () => json({ error: "access_denied" }, 400);
      await vi.advanceTimersByTimeAsync(5_100);
      expect((await linkResult).kind).toBe("denied");
    } finally {
      restore();
    }
  });

  /**
   * A finalization that fails on the CURRENT attempt is a real failure, and
   * must not be reported as somebody else's attempt. `superseded` exists to
   * mean "this stopped being ours and nothing was projected"; these two paths
   * DID project - the global sign-in error is already showing - so the result
   * has to say so, or a caller reading it stays silent about a login that
   * genuinely broke.
   */
  it("gives up on the approval window and reports timed-out", async () => {
    // Nobody answers on the desktop. `LINK_LOGIN_APPROVAL_TIMEOUT_MS` and the
    // `failCurrent({ kind: "timed-out" })` tail had no coverage, so a change
    // to the deadline arithmetic would have failed nothing.
    const { service } = makeService();
    const { script, restore } = installLinkFetch();
    try {
      // A wide server-directed interval on purpose: the DEADLINE is what is
      // under test, and pacing at the default 1s would drive 130 polls to
      // reach it.
      script.claimResponse = () =>
        json({ status: "claimed", secret: "S".repeat(43), interval: 30 }, 200);
      script.tokenResponse = () =>
        json({ error: "authorization_pending" }, 428);
      const resultPromise = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(130_000);
      const result = await resultPromise;

      expect(result.kind).toBe("timed-out");
      expect(useAuthStore.getState().status).toBe("signed-out");
      // A code verdict, so the surface renders the precise copy and the
      // generic sign-in error stays out of it.
      expect(service.getLastError()).toBeNull();
    } finally {
      restore();
    }
  });

  it("a validation failure on the CURRENT attempt is failed, not superseded", async () => {
    const { service } = makeService();
    const { script, restore } = installLinkFetch();
    try {
      // The desktop approved and the token endpoint handed over credentials;
      // authn is then briefly unreachable for the identity check.
      script.tokenResponse = () =>
        json(
          { token: "good-token", refreshToken: "good-refresh", familyId: "f" },
          200,
        );
      script.validationResponse = () => new Response(null, { status: 401 });
      const resultPromise = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(1_100);
      const result = await resultPromise;

      expect(result.kind).not.toBe("superseded");
      expect(result.kind).toBe("failed");
      expect(useAuthStore.getState().status).toBe("signed-out");
      // The global sign-in error is the SOLE presentation for this one: no
      // code verdict is stored, because "invalid or expired" would misdescribe
      // a network blip after an approval that did land.
      expect(service.getLastError()).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("a credential-persist rejection on the CURRENT attempt is failed, not superseded", async () => {
    const { service, host } = makeService();
    const { script, restore } = installLinkFetch();
    const realStore: ITokenStore = host.tokenStore;
    Object.defineProperty(realStore, "signIn", {
      configurable: true,
      value: (): Promise<void> =>
        Promise.reject(new Error("credentials file is read-only")),
    });
    try {
      script.validationResponse = () => json(PROFILE_BODY, 200);
      script.tokenResponse = () =>
        json(
          { token: "good-token", refreshToken: "good-refresh", familyId: "f" },
          200,
        );
      const resultPromise = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(1_100);
      const result = await resultPromise;

      // Nothing superseded this attempt; the durable write simply refused.
      expect(result.kind).not.toBe("superseded");
      expect(result.kind).toBe("failed");
      expect(useAuthStore.getState().status).toBe("signed-out");
      expect(service.getLastError()).not.toBeNull();
    } finally {
      restore();
    }
  });

  /** Pauses the credential save at the durable-store boundary. */
  function pauseStoreSignIn(realStore: ITokenStore): {
    saveEnteredPromise: Promise<void>;
    releaseSave: () => void;
  } {
    let releaseSave: () => void = () => undefined;
    let saveEntered: () => void = () => undefined;
    const saveEnteredPromise = new Promise<void>((resolve) => {
      saveEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const originalSignIn = realStore.signIn.bind(realStore);
    Object.defineProperty(realStore, "signIn", {
      configurable: true,
      value: async (
        tokens: { readonly token: string; readonly refreshToken: string },
        identity: StoredCredentialsIdentity,
      ): Promise<void> => {
        saveEntered();
        await gate;
        return originalSignIn(tokens, identity);
      },
    });
    return { saveEnteredPromise, releaseSave };
  }

  it("a supersession landing MID-SAVE undoes the durable credential write", async () => {
    const { service, host } = makeService();
    const { script, restore } = installLinkFetch();
    const realStore: ITokenStore = host.tokenStore;
    const { saveEnteredPromise, releaseSave } = pauseStoreSignIn(realStore);
    try {
      script.validationResponse = () => json(PROFILE_BODY, 200);
      script.tokenResponse = () =>
        json(
          {
            token: "attempt-a-token",
            refreshToken: "attempt-a-r",
            familyId: "f",
          },
          200,
        );
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      // Reach the paused save: claim, one poll (authorized), validation.
      await vi.advanceTimersByTimeAsync(1_100);
      await saveEnteredPromise;

      // B starts (superseding A mid-save) and immediately fails to launch.
      Object.defineProperty(host.deviceFlow, "start", {
        configurable: true,
        value: () => Promise.resolve(null),
      });
      const deviceSignIn = service.signIn();
      await vi.advanceTimersByTimeAsync(10);
      await deviceSignIn;

      // A's paused write now lands — and must be undone, not persisted.
      releaseSave();
      const result = await linkResult;
      expect(result.kind).toBe("superseded");
      const stored: StoredCredentials | null = await realStore.get();
      expect(stored).toBeNull();
      expect(useAuthStore.getState().status).not.toBe("signed-in");
    } finally {
      restore();
    }
  });

  it("a FAILED undo is surfaced, and recovery completes it before adopting — the zombie never returns", async () => {
    const { service, host } = makeService();
    const { script, restore } = installLinkFetch();
    const realStore: ITokenStore = host.tokenStore;
    const { saveEnteredPromise, releaseSave } = pauseStoreSignIn(realStore);
    // The undo's atomic conditional delete faults — the stale pair stays
    // durable. That must fire the shared store-fault seam AND fence the
    // recovery loop: until the delete lands, nothing durable may be adopted.
    let deleteIfTokenBroken = true;
    const realDeleteIfToken = realStore.deleteIfToken.bind(realStore);
    Object.defineProperty(realStore, "deleteIfToken", {
      configurable: true,
      value: (expectedToken: string): Promise<"deleted" | "kept"> =>
        deleteIfTokenBroken
          ? Promise.reject(new Error("EIO: credentials file unwritable"))
          : realDeleteIfToken(expectedToken),
    });
    try {
      script.validationResponse = () => json(PROFILE_BODY, 200);
      script.tokenResponse = () =>
        json(
          {
            token: "attempt-a-token",
            refreshToken: "attempt-a-r",
            familyId: "f",
          },
          200,
        );
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(1_100);
      await saveEnteredPromise;

      Object.defineProperty(host.deviceFlow, "start", {
        configurable: true,
        value: () => Promise.resolve(null),
      });
      const deviceSignIn = service.signIn();
      await vi.advanceTimersByTimeAsync(10);
      await deviceSignIn;

      releaseSave();
      const result = await linkResult;
      expect(result.kind).toBe("superseded");
      // Observable: the store-unavailable projection is the surfaced error,
      // and the stale pair is indeed still durable.
      expect(service.getLastError()).toBe(AUTH_ERROR_STORE_UNAVAILABLE);
      expect((await realStore.get())?.token).toBe("attempt-a-token");

      // Recovery ticks while the conditional delete still fails: the stale
      // token WOULD validate (the /user stub says 200), but the pending-undo
      // fence must keep the loop from adopting it.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(useAuthStore.getState().status).not.toBe("signed-in");

      // The store heals. Recovery completes the pending conditional delete
      // FIRST, then finds no stored session — the zombie never signs back in.
      deleteIfTokenBroken = false;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await realStore.get()).toBeNull();
      expect(useAuthStore.getState().status).not.toBe("signed-in");
    } finally {
      restore();
    }
  });

  it("a watcher self-write echo cannot re-adopt the stale pair while its undo is pending", async () => {
    const { service, host } = makeService();
    const { script, restore } = installLinkFetch();
    const realStore: ITokenStore = host.tokenStore;
    const { saveEnteredPromise, releaseSave } = pauseStoreSignIn(realStore);
    let deleteIfTokenBroken = true;
    const realDeleteIfToken = realStore.deleteIfToken.bind(realStore);
    Object.defineProperty(realStore, "deleteIfToken", {
      configurable: true,
      value: (expectedToken: string): Promise<"deleted" | "kept"> =>
        deleteIfTokenBroken
          ? Promise.reject(new Error("EIO: credentials file unwritable"))
          : realDeleteIfToken(expectedToken),
    });
    try {
      script.validationResponse = () => json(PROFILE_BODY, 200);
      script.tokenResponse = () =>
        json(
          {
            token: "attempt-a-token",
            refreshToken: "attempt-a-r",
            familyId: "f",
          },
          200,
        );
      // STARTED service: the credentials-store change subscription is live,
      // so the superseded save's own durable write fires the reconcile path
      // — the adoption route the recovery-only fence used to miss.
      await service.start();
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(1_100);
      await saveEnteredPromise;

      Object.defineProperty(host.deviceFlow, "start", {
        configurable: true,
        value: () => Promise.resolve(null),
      });
      const deviceSignIn = service.signIn();
      await vi.advanceTimersByTimeAsync(10);
      await deviceSignIn;

      releaseSave();
      const result = await linkResult;
      expect(result.kind).toBe("superseded");
      // The write's change notification has fired and the reconcile has had
      // every chance to run — with the undo still failing, it must adopt
      // NOTHING, even though the stale token would validate (stubbed 200).
      await vi.advanceTimersByTimeAsync(5_000);
      expect(useAuthStore.getState().status).not.toBe("signed-in");
      expect((await realStore.get())?.token).toBe("attempt-a-token");

      // The store heals: the pending delete completes first, so neither the
      // reconcile nor the recovery loop ever signs the zombie back in.
      deleteIfTokenBroken = false;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await realStore.get()).toBeNull();
      expect(useAuthStore.getState().status).not.toBe("signed-in");
    } finally {
      restore();
    }
  });

  it("overlapping undos never lose a failing token: A's settled kept must not clear B's pending delete", async () => {
    const { service, host } = makeService();
    const { script, restore } = installLinkFetch();
    const realStore: ITokenStore = host.tokenStore;
    // Per-token save gates: A and B each pause at the durable-store boundary
    // and are released independently, so their writes and undos interleave.
    const slots = new Map<
      string,
      {
        gate: Promise<void>;
        release: () => void;
        entered: Promise<void>;
        markEntered: () => void;
      }
    >();
    const slotFor = (token: string) => {
      let slot = slots.get(token);
      if (slot === undefined) {
        let release: () => void = () => undefined;
        let markEntered: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const entered = new Promise<void>((resolve) => {
          markEntered = resolve;
        });
        slot = { gate, release, entered, markEntered };
        slots.set(token, slot);
      }
      return slot;
    };
    const originalSignIn = realStore.signIn.bind(realStore);
    Object.defineProperty(realStore, "signIn", {
      configurable: true,
      value: async (
        tokens: { readonly token: string; readonly refreshToken: string },
        identity: StoredCredentialsIdentity,
      ): Promise<void> => {
        const slot = slotFor(tokens.token);
        slot.markEntered();
        await slot.gate;
        return originalSignIn(tokens, identity);
      },
    });
    // Only B's conditional delete fails; A's settles as kept.
    let bDeleteBroken = true;
    const realDeleteIfToken = realStore.deleteIfToken.bind(realStore);
    Object.defineProperty(realStore, "deleteIfToken", {
      configurable: true,
      value: (expectedToken: string): Promise<"deleted" | "kept"> =>
        expectedToken === "attempt-b-token" && bDeleteBroken
          ? Promise.reject(new Error("EIO: credentials file unwritable"))
          : realDeleteIfToken(expectedToken),
    });
    try {
      script.validationResponse = () => json(PROFILE_BODY, 200);
      script.tokenResponse = () =>
        json(
          {
            token: "attempt-a-token",
            refreshToken: "attempt-a-r",
            familyId: "f",
          },
          200,
        );
      const linkA = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(1_100);
      await slotFor("attempt-a-token").entered;

      // B supersedes A and runs to ITS OWN gated save.
      script.tokenResponse = () =>
        json(
          {
            token: "attempt-b-token",
            refreshToken: "attempt-b-r",
            familyId: "f",
          },
          200,
        );
      const linkB = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(1_100);

      // C supersedes B and fails immediately.
      Object.defineProperty(host.deviceFlow, "start", {
        configurable: true,
        value: () => Promise.resolve(null),
      });
      const attemptC = service.signIn();
      await vi.advanceTimersByTimeAsync(10);
      await attemptC;

      // A's write lands, then B's overwrites it. A's undo then compares and
      // settles `kept` (B owns the file) — with a single-slot fence that
      // settle used to null the record of B's STILL-FAILING delete.
      slotFor("attempt-a-token").release();
      slotFor("attempt-b-token").release();
      expect((await linkA).kind).toBe("superseded");
      expect((await linkB).kind).toBe("superseded");

      // B is durable and its delete keeps failing: nothing may be adopted,
      // even though the token validates (stubbed 200).
      await vi.advanceTimersByTimeAsync(5_000);
      expect(useAuthStore.getState().status).not.toBe("signed-in");
      expect((await realStore.get())?.token).toBe("attempt-b-token");

      // Heal: B's token was never lost — the drain deletes it and the
      // zombie never signs in.
      bDeleteBroken = false;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await realStore.get()).toBeNull();
      expect(useAuthStore.getState().status).not.toBe("signed-in");
    } finally {
      restore();
    }
  });

  it("a SECOND window can never adopt a quarantined pair: shared store, real fan-out", async () => {
    const { service, host } = makeService();
    // Window B: a second, independently STARTED AuthService over the SAME
    // runner host — the same shared token store and the same change
    // fan-out, exactly like a second Electron window. It has no local
    // pending-undo record for A's token; only the store authority's
    // quarantine can stop it.
    const windowB = new AuthService({ runnerHost: host });
    trackedServices.push(windowB);
    const { script, restore } = installLinkFetch();
    const realStore: ITokenStore = host.tokenStore;
    const { saveEnteredPromise, releaseSave } = pauseStoreSignIn(realStore);
    try {
      script.validationResponse = () => json(PROFILE_BODY, 200);
      script.tokenResponse = () =>
        json(
          {
            token: "attempt-a-token",
            refreshToken: "attempt-a-r",
            familyId: "f",
          },
          200,
        );
      await service.start();
      await windowB.start();
      // The store authority's conditional delete fails; the quarantine it
      // registered BEFORE the attempt stays.
      host.tokenStoreConditionalDeleteError = new Error(
        "EIO: credentials file unwritable",
      );
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(1_100);
      await saveEnteredPromise;

      Object.defineProperty(host.deviceFlow, "start", {
        configurable: true,
        value: () => Promise.resolve(null),
      });
      const deviceSignIn = service.signIn();
      await vi.advanceTimersByTimeAsync(10);
      await deviceSignIn;

      releaseSave();
      expect((await linkResult).kind).toBe("superseded");

      // The write's fan-out reached BOTH windows. The raw entry is durable,
      // but the store serves it to NO reader — so neither window adopts,
      // even though the token would validate (stubbed 200).
      await vi.advanceTimersByTimeAsync(5_000);
      expect(useAuthStore.getState().status).not.toBe("signed-in");
      expect(host.tokenStoreEntries.get("traycer.token")?.token).toBe(
        "attempt-a-token",
      );
      expect(await realStore.get()).toBeNull();

      // Window B's proactive ROTATE against its older live same-user token,
      // racing A's failed undo: the mutation view is quarantine-filtered
      // like the read view, so the rotate is told the session is gone —
      // never handed the zombie as `superseded`, and nothing is spent.
      const rotated = await realStore.rotate({
        userId: "user-1",
        token: "attempt-older-token",
      });
      expect(rotated.outcome).toBe("deleted");
      expect(rotated.pair).toBeNull();

      // Heal: the deletion lands BEFORE either window adopts anything.
      host.tokenStoreConditionalDeleteError = null;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(host.tokenStoreEntries.get("traycer.token")).toBeUndefined();
      expect(useAuthStore.getState().status).not.toBe("signed-in");
    } finally {
      restore();
    }
  });

  it("terminal denial of the CURRENT attempt signs out WITHOUT the generic message", async () => {
    const { service } = makeService();
    const { script, restore } = installLinkFetch();
    try {
      script.tokenResponse = () => json({ error: "access_denied" }, 400);
      const resultPromise = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(1_100);
      const result = await resultPromise;
      expect(result.kind).toBe("denied");
      expect(useAuthStore.getState().status).toBe("signed-out");
      // The returned kind is what the surfaces render ("the sign-in was
      // rejected on your computer"). A generic `lastError` beside it would put
      // two explanations of one failure on the same screen, the weaker one
      // telling the user to try again.
      expect(service.getLastError()).toBeNull();
    } finally {
      restore();
    }
  });
});
