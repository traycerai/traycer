/**
 * The link-login poll's projected progress: the phone's QR sign-in surface
 * counts down to the next `/link/token` poll off the loop's own absolute
 * `nextPollAtMs`, so the number it shows is derived from the cadence the loop
 * is actually running at — the claim's advertised interval, or whatever a
 * `slow_down` directive stretched it to — and never from a constant in the UI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { AuthService, type LinkLoginProgress } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";

const CLAIM_URL = "http://localhost:5005/api/v3/auth/link/claim";
const TOKEN_URL = "http://localhost:5005/api/v3/auth/link/token";

/** Deliberately not the server's real cadence: a hardcoded countdown fails. */
const ADVERTISED_INTERVAL_SECONDS = 3;
const RETRY_AFTER_SECONDS = 9;

const trackedServices: AuthService[] = [];

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
  const service = new AuthService({ runnerHost: host });
  trackedServices.push(service);
  return service;
}

function json(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function slowDown(seconds: number): Response {
  return new Response(JSON.stringify({ error: "slow_down" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(seconds),
    },
  });
}

interface LinkFetchScript {
  tokenResponse: () => Response;
}

function installLinkFetch(): { script: LinkFetchScript; restore: () => void } {
  const script: LinkFetchScript = {
    tokenResponse: () => json({ error: "authorization_pending" }, 428),
  };
  const originalFetch: unknown = (globalThis as { fetch?: unknown }).fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: unknown): Promise<Response> => {
      const url = typeof input === "string" ? input : String(input);
      if (url === CLAIM_URL) {
        return Promise.resolve(
          json(
            {
              status: "claimed",
              secret: "S".repeat(43),
              interval: ADVERTISED_INTERVAL_SECONDS,
            },
            200,
          ),
        );
      }
      if (url === TOKEN_URL) {
        return Promise.resolve(script.tokenResponse());
      }
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

/** One emission, stamped with the clock it was published at. */
interface Emission {
  readonly progress: LinkLoginProgress | null;
  readonly atMs: number;
}

function recordProgress(service: AuthService): {
  emissions: Emission[];
  dispose: () => void;
} {
  const emissions: Emission[] = [];
  const subscription = service.onLinkLoginProgressChange((progress) => {
    emissions.push({ progress, atMs: Date.now() });
  });
  return {
    emissions,
    dispose: () => {
      subscription.dispose();
    },
  };
}

/**
 * The wait each `waiting` emission is advertising — the gap between when the
 * surface is told the next poll lands and when it was told. This is the
 * number the countdown starts at.
 */
function advertisedWaitsMs(emissions: readonly Emission[]): number[] {
  return emissions
    .filter((entry) => entry.progress?.phase === "waiting")
    .map((entry) => (entry.progress?.nextPollAtMs ?? 0) - entry.atMs);
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

describe("link-login poll progress", () => {
  it("counts down to the CLAIM'S advertised interval, not a fixed cadence", async () => {
    const service = makeService();
    const { script, restore } = installLinkFetch();
    const recorder = recordProgress(service);
    try {
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      // Let the claim land; the first wait is published before its sleep.
      await vi.advanceTimersByTimeAsync(0);

      expect(advertisedWaitsMs(recorder.emissions)).toEqual([
        ADVERTISED_INTERVAL_SECONDS * 1_000,
      ]);

      script.tokenResponse = () => json({ error: "access_denied" }, 400);
      await vi.advanceTimersByTimeAsync(ADVERTISED_INTERVAL_SECONDS * 1_000);
      await linkResult;
    } finally {
      recorder.dispose();
      restore();
    }
  });

  it("marks the poll itself as checking, then returns to a fresh countdown", async () => {
    const service = makeService();
    const { script, restore } = installLinkFetch();
    const recorder = recordProgress(service);
    try {
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(0);
      // One full pending poll: the wait elapses, the request goes out, and
      // the loop re-arms.
      await vi.advanceTimersByTimeAsync(ADVERTISED_INTERVAL_SECONDS * 1_000);

      const phases = recorder.emissions
        .map((entry) => entry.progress?.phase ?? null)
        .filter((phase) => phase !== null);
      expect(phases.slice(0, 3)).toEqual(["waiting", "checking", "waiting"]);

      script.tokenResponse = () => json({ error: "access_denied" }, 400);
      await vi.advanceTimersByTimeAsync(ADVERTISED_INTERVAL_SECONDS * 1_000);
      await linkResult;
    } finally {
      recorder.dispose();
      restore();
    }
  });

  it("a slow_down Retry-After stretches the countdown, and a pending poll snaps it back", async () => {
    const service = makeService();
    const { script, restore } = installLinkFetch();
    const recorder = recordProgress(service);
    try {
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(0);

      // The first poll is paced: the wait it directs must be the one the
      // surface counts down, not the interval the claim advertised.
      script.tokenResponse = () => slowDown(RETRY_AFTER_SECONDS);
      await vi.advanceTimersByTimeAsync(ADVERTISED_INTERVAL_SECONDS * 1_000);

      // The directive is spent after one wait — an ordinary pending poll
      // restores the advertised cadence rather than leaving it ratcheted up.
      script.tokenResponse = () =>
        json({ error: "authorization_pending" }, 428);
      await vi.advanceTimersByTimeAsync(RETRY_AFTER_SECONDS * 1_000);

      expect(advertisedWaitsMs(recorder.emissions)).toEqual([
        ADVERTISED_INTERVAL_SECONDS * 1_000,
        RETRY_AFTER_SECONDS * 1_000,
        ADVERTISED_INTERVAL_SECONDS * 1_000,
      ]);

      script.tokenResponse = () => json({ error: "access_denied" }, 400);
      await vi.advanceTimersByTimeAsync(ADVERTISED_INTERVAL_SECONDS * 1_000);
      await linkResult;
    } finally {
      recorder.dispose();
      restore();
    }
  });

  it("clears the countdown when the desktop rejects — no clock keeps ticking past the end", async () => {
    const service = makeService();
    const { script, restore } = installLinkFetch();
    const recorder = recordProgress(service);
    try {
      const linkResult = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(0);
      expect(service.getLinkLoginProgress()).not.toBeNull();

      script.tokenResponse = () => json({ error: "access_denied" }, 400);
      await vi.advanceTimersByTimeAsync(ADVERTISED_INTERVAL_SECONDS * 1_000);

      const result = await linkResult;
      expect(result.kind).toBe("denied");
      expect(service.getLinkLoginProgress()).toBeNull();
      expect(recorder.emissions.at(-1)?.progress).toBeNull();
    } finally {
      recorder.dispose();
      restore();
    }
  });

  it("a superseding attempt clears the old poll's countdown before publishing its own", async () => {
    const service = makeService();
    const { script, restore } = installLinkFetch();
    const recorder = recordProgress(service);
    try {
      const firstAttempt = service.signInWithLinkCode("ABCDE-FGHJK");
      await vi.advanceTimersByTimeAsync(0);
      const emissionsBeforeSupersede = recorder.emissions.length;

      // A second scan supersedes the first; the abandoned loop's countdown
      // must not stay on screen behind the new one.
      const secondAttempt = service.signInWithLinkCode("KMNPQ-RSTVW");
      expect(
        recorder.emissions
          .slice(emissionsBeforeSupersede)
          .some((entry) => entry.progress === null),
      ).toBe(true);

      script.tokenResponse = () => json({ error: "access_denied" }, 400);
      await vi.advanceTimersByTimeAsync(ADVERTISED_INTERVAL_SECONDS * 1_000);
      await firstAttempt;
      await secondAttempt;
    } finally {
      recorder.dispose();
      restore();
    }
  });
});
