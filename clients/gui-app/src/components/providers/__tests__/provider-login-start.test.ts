import { describe, expect, it, vi } from "vitest";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  PROVIDER_LOGIN_PACK_POLL_MS,
  PROVIDER_LOGIN_STILL_STARTING_CAP,
  providerLoginAnswerWantsPackRetry,
  providerLoginNotStartedMessage,
  providerLoginPackFailure,
  providerLoginStartCopy,
  startProviderLoginUntilSettled,
  type ProviderStartLoginAnswer,
  type ProviderStartLoginRequest,
  type StartProviderLoginInput,
} from "@/components/providers/provider-login-start";

const REQUEST: ProviderStartLoginRequest = {
  providerId: "codex",
  profileId: null,
  createProfile: null,
};

function answer(
  overrides: Partial<ProviderStartLoginAnswer>,
): ProviderStartLoginAnswer {
  return {
    url: null,
    started: false,
    profileId: null,
    userCode: null,
    failure: null,
    pending: null,
    pack: null,
    ...overrides,
  };
}

const STARTED_ANSWER = answer({
  url: "https://example.test/oauth",
  started: true,
  profileId: "profile-1",
});
const STARTING_ANSWER = answer({ pending: "starting" });
const DOWNLOADING_ANSWER = answer({
  pending: "pack_preparing",
  pack: { percent: 42, reason: null, retryAtMs: null },
});
const NOT_STARTED_ANSWER = answer({ started: false });

/** Every field `startProviderLoginUntilSettled` needs, so a test overrides
 *  only what it is exercising. */
function baseInput(
  overrides: Partial<StartProviderLoginInput>,
): StartProviderLoginInput {
  return {
    request: REQUEST,
    startLogin: () => Promise.resolve(STARTED_ANSWER),
    ensurePack: () => Promise.resolve(undefined),
    retryPackFirst: false,
    onProgress: () => {},
    shouldStop: () => false,
    wait: () => Promise.resolve(),
    ...overrides,
  };
}

/** A `startLogin` fake that answers each call from a fixed queue, repeating
 *  the last entry once the queue is exhausted (a bug would otherwise read as
 *  an out-of-bounds `undefined` rather than as one extra call). */
function queuedStartLogin(
  answers: readonly ProviderStartLoginAnswer[],
): (request: ProviderStartLoginRequest) => Promise<ProviderStartLoginAnswer> {
  let call = 0;
  return () => {
    const index = Math.min(call, answers.length - 1);
    call += 1;
    return Promise.resolve(answers[index]);
  };
}

describe("startProviderLoginUntilSettled", () => {
  it("returns the first answer without pending", async () => {
    const startLogin = vi.fn(() => Promise.resolve(STARTED_ANSWER));
    const onProgress = vi.fn();
    const result = await startProviderLoginUntilSettled(
      baseInput({ startLogin, onProgress }),
    );
    expect(result).toBe(STARTED_ANSWER);
    expect(startLogin).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("keeps asking on 'starting' without waiting", async () => {
    const startLogin = vi.fn(
      queuedStartLogin([STARTING_ANSWER, STARTED_ANSWER]),
    );
    const wait = vi.fn(() => Promise.resolve());
    const result = await startProviderLoginUntilSettled(
      baseInput({ startLogin, wait }),
    );
    expect(result).toBe(STARTED_ANSWER);
    expect(startLogin).toHaveBeenCalledTimes(2);
    expect(wait).not.toHaveBeenCalled();
  });

  it("keeps asking on 'pack_preparing' after wait(2000)", async () => {
    const startLogin = vi.fn(
      queuedStartLogin([DOWNLOADING_ANSWER, STARTED_ANSWER]),
    );
    const wait = vi.fn(() => Promise.resolve());
    const result = await startProviderLoginUntilSettled(
      baseInput({ startLogin, wait }),
    );
    expect(result).toBe(STARTED_ANSWER);
    expect(startLogin).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(PROVIDER_LOGIN_PACK_POLL_MS);
  });

  it("calls onProgress with launching / downloading + percent", async () => {
    const startLogin = vi.fn(
      queuedStartLogin([STARTING_ANSWER, DOWNLOADING_ANSWER, STARTED_ANSWER]),
    );
    const onProgress = vi.fn();
    await startProviderLoginUntilSettled(
      baseInput({ startLogin, onProgress, wait: () => Promise.resolve() }),
    );
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(
      1,
      { kind: "launching" },
      STARTING_ANSWER,
    );
    expect(onProgress).toHaveBeenNthCalledWith(
      2,
      { kind: "downloading", percent: 42 },
      DOWNLOADING_ANSWER,
    );
  });

  it("stops and returns the latest answer once shouldStop() turns true right after an answer", async () => {
    const startLogin = vi.fn(
      queuedStartLogin([STARTING_ANSWER, STARTED_ANSWER]),
    );
    // True from the very first check onward: the loop must never place a
    // second call.
    const shouldStop = vi.fn(() => true);
    const result = await startProviderLoginUntilSettled(
      baseInput({ startLogin, shouldStop }),
    );
    expect(result).toBe(STARTING_ANSWER);
    expect(startLogin).toHaveBeenCalledTimes(1);
  });

  it("stops and returns the latest answer once shouldStop() turns true after the wait", async () => {
    const startLogin = vi.fn(
      queuedStartLogin([DOWNLOADING_ANSWER, STARTED_ANSWER]),
    );
    // False until the wait has actually been asked for, so the first check
    // (right after the answer) still lets the loop reach the wait at all.
    let waited = false;
    const shouldStop = vi.fn(() => waited);
    const wait = vi.fn(() => {
      waited = true;
      return Promise.resolve();
    });
    const result = await startProviderLoginUntilSettled(
      baseInput({ startLogin, shouldStop, wait }),
    );
    expect(result).toBe(DOWNLOADING_ANSWER);
    expect(startLogin).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("gives up after PROVIDER_LOGIN_STILL_STARTING_CAP consecutive 'starting' answers and returns that answer", async () => {
    const startLogin = vi.fn(() => Promise.resolve(STARTING_ANSWER));
    const onProgress = vi.fn();
    const result = await startProviderLoginUntilSettled(
      baseInput({ startLogin, onProgress }),
    );
    expect(result).toBe(STARTING_ANSWER);
    expect(result.pending).toBe("starting");
    expect(startLogin).toHaveBeenCalledTimes(PROVIDER_LOGIN_STILL_STARTING_CAP);
    // The cap-triggering call returns before its own onProgress fires.
    expect(onProgress).toHaveBeenCalledTimes(
      PROVIDER_LOGIN_STILL_STARTING_CAP - 1,
    );
  });

  it("resets the consecutive count on a 'pack_preparing' answer", async () => {
    // (CAP - 1) starting answers, one pack_preparing (resets the counter),
    // then (CAP - 1) more starting answers, then a final one - more than CAP
    // 'starting' answers across the whole run, which only passes if the
    // counter was genuinely reset rather than merely slowed down.
    const startingRun = Array.from(
      { length: PROVIDER_LOGIN_STILL_STARTING_CAP - 1 },
      () => STARTING_ANSWER,
    );
    const startLogin = vi.fn(
      queuedStartLogin([
        ...startingRun,
        DOWNLOADING_ANSWER,
        ...startingRun,
        STARTED_ANSWER,
      ]),
    );
    const result = await startProviderLoginUntilSettled(
      baseInput({ startLogin, wait: () => Promise.resolve() }),
    );
    expect(result).toBe(STARTED_ANSWER);
    expect(startLogin).toHaveBeenCalledTimes(
      2 * (PROVIDER_LOGIN_STILL_STARTING_CAP - 1) + 2,
    );
  });

  it("with retryPackFirst: true calls ensurePack once before the first startLogin", async () => {
    const calls: string[] = [];
    const ensurePack = vi.fn(() => {
      calls.push("ensurePack");
      return Promise.resolve(undefined);
    });
    const startLogin = vi.fn(() => {
      calls.push("startLogin");
      return Promise.resolve(STARTED_ANSWER);
    });
    await startProviderLoginUntilSettled(
      baseInput({ startLogin, ensurePack, retryPackFirst: true }),
    );
    expect(ensurePack).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["ensurePack", "startLogin"]);
  });

  it("still proceeds to startLogin when a retried ensurePack rejects", async () => {
    const ensurePack = vi.fn(() =>
      Promise.reject(new Error("ensurePack failed")),
    );
    const startLogin = vi.fn(() => Promise.resolve(STARTED_ANSWER));
    const result = await startProviderLoginUntilSettled(
      baseInput({ startLogin, ensurePack, retryPackFirst: true }),
    );
    expect(result).toBe(STARTED_ANSWER);
    expect(startLogin).toHaveBeenCalledTimes(1);
  });

  it("with retryPackFirst: false never calls ensurePack", async () => {
    const ensurePack = vi.fn(() => Promise.resolve(undefined));
    await startProviderLoginUntilSettled(
      baseInput({ ensurePack, retryPackFirst: false }),
    );
    expect(ensurePack).not.toHaveBeenCalled();
  });

  it("rejects when startLogin rejects", async () => {
    const failure = new Error("start failed");
    const startLogin = vi.fn(() => Promise.reject(failure));
    await expect(
      startProviderLoginUntilSettled(baseInput({ startLogin })),
    ).rejects.toBe(failure);
  });
});

describe("providerLoginStartCopy", () => {
  it("is null while opening (no news yet)", () => {
    expect(providerLoginStartCopy({ kind: "opening" }, "codex")).toBeNull();
  });

  it("names the provider while launching", () => {
    expect(
      providerLoginStartCopy({ kind: "launching" }, "claude-code"),
    ).toEqual({
      title: "Starting Claude Code…",
      guidance:
        "This can take up to a minute. The sign-in page opens as soon as it is ready.",
    });
  });

  it("shows the percent while downloading, when known", () => {
    const copy = providerLoginStartCopy(
      { kind: "downloading", percent: 42 },
      "codex",
    );
    expect(copy).not.toBeNull();
    expect(copy?.title).toBe("Preparing Codex… 42%");
    expect(copy?.guidance).toBe(
      "First-time setup is downloading. Sign-in continues on its own when it finishes.",
    );
  });

  it("shows an indeterminate label while downloading, when the percent is unknown", () => {
    const copy = providerLoginStartCopy(
      { kind: "downloading", percent: null },
      "codex",
    );
    expect(copy?.title).toBe("Preparing Codex…");
  });
});

describe("providerLoginPackFailure", () => {
  it("is null when the answer carries no pack", () => {
    expect(providerLoginPackFailure(answer({ pack: null }))).toBeNull();
  });

  it("is null when the pack is still downloading (no reason)", () => {
    expect(
      providerLoginPackFailure(
        answer({
          pack: { percent: 50, reason: null, retryAtMs: null },
        }),
      ),
    ).toBeNull();
  });

  it("reports the failure when the pack's reason is set", () => {
    expect(
      providerLoginPackFailure(
        answer({
          pack: { percent: null, reason: "network", retryAtMs: 1_000 },
        }),
      ),
    ).toEqual({
      kind: "error",
      percent: null,
      retryAtMs: 1_000,
      reason: "network",
      fallbackRunnable: false,
    });
  });
});

describe("providerLoginAnswerWantsPackRetry", () => {
  it("is false for a null answer", () => {
    expect(providerLoginAnswerWantsPackRetry(null)).toBe(false);
  });

  it("is false when there is no pack failure to retry", () => {
    expect(providerLoginAnswerWantsPackRetry(NOT_STARTED_ANSWER)).toBe(false);
  });

  const RETRYABLE_REASONS = [
    "disk-full",
    "network",
    "verification",
    "live-owner-stalled",
    "unknown",
  ] as const;
  const NOT_RETRYABLE_REASONS = [
    "unrepairable",
    "trust-unavailable",
    "local-storage-mismatch",
  ] as const;

  for (const reason of RETRYABLE_REASONS) {
    it(`is true for the retryable reason '${reason}'`, () => {
      const withReason = answer({
        pack: { percent: null, reason, retryAtMs: null },
      });
      expect(providerLoginAnswerWantsPackRetry(withReason)).toBe(true);
    });
  }

  for (const reason of NOT_RETRYABLE_REASONS) {
    it(`is false for the non-retryable reason '${reason}'`, () => {
      const withReason = answer({
        pack: { percent: null, reason, retryAtMs: null },
      });
      expect(providerLoginAnswerWantsPackRetry(withReason)).toBe(false);
    });
  }
});

describe("providerLoginNotStartedMessage", () => {
  const PROVIDER_ID: ProviderId = "codex";
  const NOT_STARTED = "Sign-in did not start. Try again.";

  it("prefers the typed failure over anything pack-related", () => {
    const withBoth = answer({
      failure: "device_code_missing",
      pack: { percent: null, reason: "network", retryAtMs: null },
    });
    expect(
      providerLoginNotStartedMessage(withBoth, PROVIDER_ID, NOT_STARTED),
    ).toBe("Sign-in did not print a device code in time. Try again.");
  });

  it("falls back to the pack failure's own message when there is no typed failure", () => {
    const packFailed = answer({
      pack: { percent: null, reason: "network", retryAtMs: null },
    });
    expect(
      providerLoginNotStartedMessage(packFailed, PROVIDER_ID, NOT_STARTED),
    ).toBe(
      "Codex setup failed - the download could not be reached. Retry when you're back online.",
    );
  });

  it("falls back to the surface's generic sentence when neither applies", () => {
    expect(
      providerLoginNotStartedMessage(
        NOT_STARTED_ANSWER,
        PROVIDER_ID,
        NOT_STARTED,
      ),
    ).toBe(NOT_STARTED);
  });
});
