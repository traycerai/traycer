import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cookie, CookiesSetDetails } from "electron";
import {
  BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_BURST,
  BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES,
  type BrowserPrimaryProfileDelta,
  type BrowserStorageCookie,
} from "@traycer/protocol/host/browser/contracts";
import {
  applyBrowserObservedProfile,
  BrowserObservedConnectionGovernor,
  traceBrowserObservedProfile,
  type BrowserObservedProfileResult,
} from "../browser-observed-profile";
import { BrowserJarSerializer } from "../browser-jar-serializer";
import {
  BROWSER_COOKIE_DELTA_WINDOW_MS,
  BrowserCookieChangeObserver,
} from "../browser-cookie-change-observer";
import { log } from "../../../app/logger";
import { matchesDomainFilter } from "./cookie-jar-fixture";

/**
 * The desktop's enforcement of `primaryProfileObserved` (universal-sign-in
 * ticket 03), driven through the real apply path: the real cookie schema, the
 * real `cookies.set` conversion, and - for the echo round - the real cookie
 * change observer.
 *
 * The jar below is the one piece that has to be a stand-in, so it models the
 * two Chromium behaviours the enforcement is written against: a `set` whose
 * expiration is in the past DELETES the matching cookie, and a `set` may refuse
 * one cookie without the batch around it failing.
 */

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  // The real one, near enough for these assertions: what matters is that the
  // trace passes its fields through a truncating redactor at all.
  sanitizeLogFields: (fields: Record<string, unknown>) => fields,
  describeLogError: (error: unknown) => String(error),
}));

class FakeCookieJar {
  private readonly jar: Cookie[] = [];
  private listener:
    | ((
        event: unknown,
        cookie: Cookie,
        cause: string,
        removed: boolean,
      ) => void)
    | null = null;
  /** Cookie names this jar refuses, standing in for Chromium's own validation. */
  private readonly refusedNames = new Set<string>();
  flushes = 0;

  set(details: CookiesSetDetails): Promise<void> {
    // Electron types the name as optional; the apply path always names one.
    const name = details.name ?? "";
    if (this.refusedNames.has(name)) {
      return Promise.reject(new Error(`jar refused ${name}`));
    }
    const cookie = toJarCookie(details);
    // Chromium's own semantics, and the reason expired cookies never reach
    // here: setting an already-expired cookie is a DELETE of the match.
    if (
      details.expirationDate !== undefined &&
      details.expirationDate * 1_000 <= Date.now()
    ) {
      this.removeAt(this.indexOf(cookie), cookie);
      return Promise.resolve();
    }
    const index = this.indexOf(cookie);
    if (index === -1) this.jar.push(cookie);
    else this.jar[index] = cookie;
    this.emit(cookie, false);
    return Promise.resolve();
  }

  get(filter: { readonly domain?: string }): Promise<Cookie[]> {
    const domain = filter.domain;
    return Promise.resolve(
      domain === undefined
        ? [...this.jar]
        : this.jar.filter((cookie) =>
            matchesDomainFilter(cookie.domain ?? "", domain),
          ),
    );
  }

  flushStore(): Promise<void> {
    this.flushes += 1;
    return Promise.resolve();
  }

  on(
    _event: "changed",
    listener: (
      event: unknown,
      cookie: Cookie,
      cause: string,
      removed: boolean,
    ) => void,
  ): void {
    this.listener = listener;
  }

  off(
    _event: "changed",
    listener: (
      event: unknown,
      cookie: Cookie,
      cause: string,
      removed: boolean,
    ) => void,
  ): void {
    if (this.listener === listener) this.listener = null;
  }

  /** Pre-existing jar state the applier never wrote, and no `changed` event. */
  seed(cookie: Cookie): void {
    this.jar.push(cookie);
  }

  refuse(name: string): void {
    this.refusedNames.add(name);
  }

  names(): readonly string[] {
    return this.jar.map((cookie) => cookie.name).sort();
  }

  find(name: string): Cookie | undefined {
    return this.jar.find((cookie) => cookie.name === name);
  }

  private removeAt(index: number, cookie: Cookie): void {
    if (index === -1) return;
    this.jar.splice(index, 1);
    this.emit(cookie, true);
  }

  private indexOf(cookie: Cookie): number {
    return this.jar.findIndex(
      (existing) =>
        existing.name === cookie.name &&
        canonicalDomain(existing.domain ?? "") ===
          canonicalDomain(cookie.domain ?? "") &&
        existing.path === cookie.path,
    );
  }

  private emit(cookie: Cookie, removed: boolean): void {
    this.listener?.({}, cookie, "explicit", removed);
  }
}

function canonicalDomain(domain: string): string {
  return domain.startsWith(".") ? domain.slice(1) : domain;
}

function toJarCookie(details: CookiesSetDetails): Cookie {
  const hostOnly = details.domain === undefined;
  return {
    name: details.name ?? "",
    value: details.value ?? "",
    domain: details.domain ?? new URL(details.url).hostname,
    hostOnly,
    path: details.path ?? "/",
    secure: details.secure === true,
    httpOnly: details.httpOnly === true,
    session: details.expirationDate === undefined,
    sameSite: details.sameSite ?? "no_restriction",
    expirationDate: details.expirationDate,
  };
}

function seededCookie(input: {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
}): Cookie {
  return {
    name: input.name,
    value: input.value,
    domain: input.domain,
    hostOnly: true,
    path: "/",
    secure: true,
    httpOnly: false,
    session: false,
    sameSite: "lax",
    expirationDate: futureSeconds(),
  };
}

function observedCookie(input: {
  readonly name: string;
  readonly domain: string;
  readonly expires: number;
}): BrowserStorageCookie {
  return {
    name: input.name,
    value: `${input.name}-value`,
    domain: input.domain,
    path: "/",
    expires: input.expires,
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
    partitionKey: null,
  };
}

function futureSeconds(): number {
  return Date.now() / 1_000 + 3_600;
}

function pastSeconds(): number {
  return Date.now() / 1_000 - 60;
}

/**
 * One desktop's worth of the apply path: the jar, the per-connection governor,
 * and the serial queue every jar write goes through. `apply` mirrors the IPC
 * handler exactly - validate, merge, then trace the result - so the trace runs
 * on every case these tests cover.
 */
class ObservedApplyHarness {
  readonly jar = new FakeCookieJar();
  readonly serializer = new BrowserJarSerializer();
  readonly governor = new BrowserObservedConnectionGovernor(() => Date.now());
  /**
   * Sites the forget ledger covers at a revision the naming connection has not
   * acked pruning, keyed `<connectionId> <domain>` - the real gate's two inputs
   * (`browser-forget-ledger.ts` decides this from the ledger and the acked
   * revisions; the end-to-end wiring is pinned in that module's own suite).
   */
  readonly forgottenPendingAck = new Set<string>();

  apply(input: {
    readonly domain: string;
    readonly cookies: readonly BrowserStorageCookie[];
    readonly connectionId: string;
  }): Promise<BrowserObservedProfileResult> {
    const observed = {
      connectionId: input.connectionId,
      hostId: "host-1",
      domain: input.domain,
      cookies: input.cookies,
    };
    return applyBrowserObservedProfile(observed, {
      now: () => Date.now(),
      isForgottenPendingAck: (gate) =>
        this.forgottenPendingAck.has(`${gate.connectionId} ${gate.domain}`),
      getSession: () => ({ cookies: this.jar }),
      serializeOnDomain: (domain, action) =>
        this.serializer.runOnDomain(domain, action),
      governor: this.governor,
    }).then((result) => {
      traceBrowserObservedProfile(result, {
        hostId: observed.hostId,
        connectionId: observed.connectionId,
        governor: this.governor,
      });
      return result;
    });
  }

  /** One frame for `example.com` on this harness's default connection. */
  applyFrame(
    cookies: readonly BrowserStorageCookie[],
  ): Promise<BrowserObservedProfileResult> {
    return this.apply({
      domain: "example.com",
      cookies,
      connectionId: "connection-1",
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("observed sign-in apply", () => {
  it("merges the frame's cookies into the jar and traces the apply", async () => {
    const harness = new ObservedApplyHarness();
    harness.jar.seed(
      seededCookie({ name: "kept", value: "keep-me", domain: "other.test" }),
    );

    const result = await harness.applyFrame([
      observedCookie({ name: "sid", domain: "example.com", expires: -1 }),
      // A subdomain cookie collapses to the same registrable domain, so it
      // belongs to this frame's scope and applies with the rest.
      observedCookie({
        name: "sub",
        domain: "app.example.com",
        expires: futureSeconds(),
      }),
    ]);

    expect(result.outcome).toBe("applied");
    expect(result.appliedCookies).toBe(2);
    // Merge-only: an unrelated site's cookie is not touched by a frame that
    // does not name it.
    expect(harness.jar.names()).toEqual(["kept", "sid", "sub"]);
    expect(log.info).toHaveBeenCalledWith(
      "[browser-view] merged an observed sign-in",
      expect.objectContaining({ domain: "example.com", reason: "applied" }),
    );
  });

  it("drops the cookies of another site and still applies the rest of the frame", async () => {
    const harness = new ObservedApplyHarness();

    const result = await harness.applyFrame([
      observedCookie({ name: "sid", domain: "example.com", expires: -1 }),
      observedCookie({ name: "stolen", domain: "evil.test", expires: -1 }),
      // A near-miss that RFC 6265 domain-matching alone would let through.
      observedCookie({
        name: "lookalike",
        domain: "notexample.com",
        expires: -1,
      }),
    ]);

    expect(result.outcome).toBe("applied");
    expect(result.domainMismatchCookies).toBe(2);
    expect(harness.jar.names()).toEqual(["sid"]);
    expect(log.warn).toHaveBeenCalledWith(
      "[browser-view] refused an observed sign-in",
      expect.objectContaining({ reason: "domain-mismatch", cookies: 2 }),
    );
  });

  it("leaves the cookie an expired one names in the jar, and applies the live cookie beside it", async () => {
    // The acceptance test for the implicit sign-out channel: the frame cannot
    // express a removal, so a compromised host's only remaining move is to
    // re-set the live cookie with a past expiry, which Chromium would treat as
    // a delete. The pre-existing cookie must be there afterwards, untouched.
    const harness = new ObservedApplyHarness();
    harness.jar.seed(
      seededCookie({
        name: "sid",
        value: "live-session",
        domain: "example.com",
      }),
    );

    const result = await harness.applyFrame([
      observedCookie({ name: "csrf", domain: "example.com", expires: -1 }),
      observedCookie({
        name: "sid",
        domain: "example.com",
        expires: pastSeconds(),
      }),
    ]);

    expect(result.outcome).toBe("applied");
    expect(result.appliedCookies).toBe(1);
    expect(result.expiredCookies).toBe(1);
    expect(harness.jar.find("sid")?.value).toBe("live-session");
    expect(harness.jar.names()).toEqual(["csrf", "sid"]);
    expect(log.warn).toHaveBeenCalledWith(
      "[browser-view] refused an observed sign-in",
      expect.objectContaining({ reason: "expired-cookie", cookies: 1 }),
    );
  });

  it("passes a session cookie through: a negative expires is the sentinel, not a past time", async () => {
    const harness = new ObservedApplyHarness();

    const result = await harness.applyFrame([
      observedCookie({ name: "sid", domain: "example.com", expires: -1 }),
    ]);

    expect(result.expiredCookies).toBe(0);
    expect(harness.jar.find("sid")?.session).toBe(true);
  });

  it("counts a cookie the jar itself refuses instead of failing the frame", async () => {
    const harness = new ObservedApplyHarness();
    harness.jar.refuse("refused");

    const result = await harness.applyFrame([
      observedCookie({ name: "refused", domain: "example.com", expires: -1 }),
      observedCookie({ name: "sid", domain: "example.com", expires: -1 }),
    ]);

    expect(result.outcome).toBe("applied");
    expect(result.appliedCookies).toBe(1);
    expect(result.rejectedCookies).toBe(1);
    expect(harness.jar.names()).toEqual(["sid"]);
  });

  it("keeps going past a malformed cookie in the MIDDLE of a frame, and still flushes", async () => {
    // These three are wire-legal - the protocol schema takes any string - but
    // the desktop's own cookie schema THROWS on each of them rather than
    // answering with a failed parse. A throw that escapes the per-cookie guard
    // would abort the loop where it happened, applying an attacker-chosen
    // PREFIX of the frame and skipping the flush, with nothing counted or
    // traced. The jar fake cannot catch this: it only models jar-level
    // refusals, and these never reach the jar.
    const harness = new ObservedApplyHarness();
    const malformed: Record<number, BrowserStorageCookie> = {
      5: {
        ...observedCookie({
          name: "bad-path",
          domain: "example.com",
          expires: -1,
        }),
        path: "",
      },
      9: {
        ...observedCookie({ name: "", domain: "example.com", expires: -1 }),
      },
      14: {
        ...observedCookie({
          name: "no-slash",
          domain: "example.com",
          expires: -1,
        }),
        path: "relative",
      },
    };
    const cookies = Array.from({ length: 20 }, (_unused, index) => {
      return (
        malformed[index] ??
        observedCookie({
          name: `sid-${index}`,
          domain: "example.com",
          expires: -1,
        })
      );
    });

    const result = await harness.applyFrame(cookies);

    expect(result.outcome).toBe("applied");
    expect(result.appliedCookies).toBe(17);
    expect(result.rejectedCookies).toBe(3);
    // Every good cookie AFTER the first malformed one is in the jar - that is
    // the assertion the abort would break.
    expect(harness.jar.names()).toHaveLength(17);
    expect(harness.jar.find("sid-19")).toBeDefined();
    // And the batch was made durable, which an escaped throw would have skipped.
    expect(harness.jar.flushes).toBe(1);
    expect(log.info).toHaveBeenCalledWith(
      "[browser-view] merged an observed sign-in",
      expect.objectContaining({ reason: "applied", cookies: 17, rejected: 3 }),
    );
  });

  it("drops a whole frame that is over the shared per-frame cookie bound", async () => {
    const harness = new ObservedApplyHarness();
    const cookies = Array.from(
      { length: BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES + 1 },
      (_unused, index) =>
        observedCookie({
          name: `sid-${index}`,
          domain: "example.com",
          expires: -1,
        }),
    );

    const result = await harness.applyFrame(cookies);

    // Whole-frame, never a prefix: applying an attacker-chosen slice of an
    // over-bound frame is the one direction that fails open.
    expect(result.outcome).toBe("over-bound");
    expect(harness.jar.names()).toEqual([]);
    expect(harness.jar.flushes).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      "[browser-view] refused an observed sign-in",
      expect.objectContaining({ reason: "over-bound" }),
    );
  });

  it("refuses a frame for a site the sending connection has not acked forgetting", async () => {
    const harness = new ObservedApplyHarness();
    harness.forgottenPendingAck.add("connection-1 example.com");

    const result = await harness.applyFrame([
      observedCookie({ name: "sid", domain: "example.com", expires: -1 }),
    ]);

    expect(result.outcome).toBe("ledger-unacked");
    expect(harness.jar.names()).toEqual([]);
    expect(harness.jar.flushes).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      "[browser-view] refused an observed sign-in",
      expect.objectContaining({ reason: "ledger-unacked" }),
    );
  });

  it("refuses per connection, so one host's ack does not vouch for another's frames", async () => {
    // The gate is a happens-before, and a happens-before belongs to the stream
    // that established it: a host that acked the revision pruned before it
    // observed anything, which says nothing about what a DIFFERENT host was
    // holding when it captured.
    const harness = new ObservedApplyHarness();
    harness.forgottenPendingAck.add("connection-2 example.com");
    const cookies = [
      observedCookie({ name: "sid", domain: "example.com", expires: -1 }),
    ];

    const acked = await harness.apply({
      domain: "example.com",
      cookies,
      connectionId: "connection-1",
    });
    const unacked = await harness.apply({
      domain: "example.com",
      cookies,
      connectionId: "connection-2",
    });

    expect(acked.outcome).toBe("applied");
    expect(unacked.outcome).toBe("ledger-unacked");
  });

  it("drops a frame whose claimed domain does not derive at all", async () => {
    const harness = new ObservedApplyHarness();
    harness.jar.seed(
      seededCookie({
        name: "sid",
        value: "live-session",
        domain: "example.com",
      }),
    );

    // Nothing to check the cookies against, so there is nothing the frame can
    // be trusted about - it is refused whole rather than per cookie. The raw
    // claim is what the trace carries, which is why the trace sanitises it.
    const dropped = await harness.apply({
      domain: ".",
      cookies: [observedCookie({ name: "sid", domain: ".", expires: -1 })],
      connectionId: "connection-1",
    });

    expect(dropped.outcome).toBe("domain-mismatch");
    expect(dropped.domain).toBe(".");
    expect(harness.jar.names()).toEqual(["sid"]);
    expect(harness.jar.flushes).toBe(0);
  });

  it("never removes: a frame whose every cookie is dropped leaves the jar exactly as it was", async () => {
    const harness = new ObservedApplyHarness();
    harness.jar.seed(
      seededCookie({
        name: "sid",
        value: "live-session",
        domain: "example.com",
      }),
    );

    const result = await harness.applyFrame([
      observedCookie({ name: "stolen", domain: "evil.test", expires: -1 }),
      observedCookie({
        name: "sid",
        domain: "example.com",
        expires: pastSeconds(),
      }),
    ]);

    expect(result.appliedCookies).toBe(0);
    expect(harness.jar.names()).toEqual(["sid"]);
    expect(harness.jar.find("sid")?.value).toBe("live-session");
    // Nothing reached the jar at all, so it was not even flushed.
    expect(harness.jar.flushes).toBe(0);
  });
});

describe("observed sign-in serialization", () => {
  const LIVE_COOKIE = [
    observedCookie({ name: "sid", domain: "example.com", expires: -1 }),
  ];

  it("queues a merge behind a clear of the same site, so the ledger read cannot go stale", async () => {
    // The TOCTOU this exists to remove: the applier reads the gate, then
    // awaits, then writes. Serialising the two means a clear cannot begin AND
    // FINISH inside that await - the merge simply runs after it, with the read
    // taken on the far side. Here the host acks the covering revision while
    // the clear is still holding the site, which is exactly the sequence that
    // would go stale if the read happened before the queue.
    const harness = new ObservedApplyHarness();
    let releaseClear = (): void => undefined;
    const clearRunning = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    harness.forgottenPendingAck.add("connection-1 example.com");
    const clear = harness.serializer.runOnDomain("example.com", async () => {
      await clearRunning;
      harness.forgottenPendingAck.delete("connection-1 example.com");
    });

    const applied = harness.applyFrame(LIVE_COOKIE);
    await vi.advanceTimersByTimeAsync(0);
    // Still queued: the clear holds the site.
    expect(harness.jar.names()).toEqual([]);

    releaseClear();
    await clear;
    const result = await applied;

    // It ran after the clear finished, so its read saw an acked revision.
    // Without the queue it would have read the pending one and refused.
    expect(result.outcome).toBe("applied");
    expect(harness.jar.names()).toEqual(["sid"]);
  });

  it("lets an unrelated site through while one site is held", async () => {
    const harness = new ObservedApplyHarness();
    let releaseClear = (): void => undefined;
    const clearRunning = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const clear = harness.serializer.runOnDomain(
      "example.com",
      () => clearRunning,
    );

    const result = await harness.apply({
      domain: "other.test",
      cookies: [
        observedCookie({ name: "sid", domain: "other.test", expires: -1 }),
      ],
      connectionId: "connection-1",
    });

    // A merge for one site must not wait behind a clear of another; only
    // same-site work has an ordering to get wrong.
    expect(result.outcome).toBe("applied");
    releaseClear();
    await clear;
  });

  it("holds every site behind a forget-all barrier", async () => {
    const harness = new ObservedApplyHarness();
    let releaseForget = (): void => undefined;
    const forgetRunning = new Promise<void>((resolve) => {
      releaseForget = resolve;
    });
    const forget = harness.serializer.runOnEveryDomain(() => forgetRunning);

    const applied = harness.applyFrame(LIVE_COOKIE);
    await vi.advanceTimersByTimeAsync(0);
    // A forget names no site, so nothing may be written to any of them until
    // the jar is empty.
    expect(harness.jar.names()).toEqual([]);

    releaseForget();
    await forget;
    await applied;
    expect(harness.jar.names()).toEqual(["sid"]);
  });
});

describe("observed frame rate limiting", () => {
  it("admits exactly one replay burst per connection, then refuses, and refills over time", async () => {
    const harness = new ObservedApplyHarness();
    const frame = (
      connectionId: string,
    ): Promise<BrowserObservedProfileResult> =>
      harness.apply({
        domain: "example.com",
        cookies: [
          observedCookie({ name: "sid", domain: "example.com", expires: -1 }),
        ],
        connectionId,
      });

    for (
      let sent = 0;
      sent < BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_BURST;
      sent += 1
    ) {
      const result = await frame("connection-1");
      // The host paces an attach replay to exactly this many frames, so a
      // limiter that refused any of them would truncate a legitimate reconnect
      // and leave the user signed out with nothing reporting why.
      expect(result.outcome).toBe("applied");
    }

    expect((await frame("connection-1")).outcome).toBe("rate-limited");
    // A second stream of the same desktop gets its own replay from the host,
    // paced against the same burst - so it must not be charged the first's.
    expect((await frame("connection-2")).outcome).toBe("applied");

    await vi.advanceTimersByTimeAsync(1_000);
    expect((await frame("connection-1")).outcome).toBe("applied");
    expect((await frame("connection-1")).outcome).toBe("rate-limited");
    expect(log.warn).toHaveBeenCalledWith(
      "[browser-view] refused an observed sign-in",
      expect.objectContaining({ reason: "rate-limited" }),
    );
  });
});

describe("observed rejection trace sampling", () => {
  const REFUSED: BrowserObservedProfileResult = {
    domain: "example.com",
    outcome: "ledger-unacked",
    appliedCookies: 0,
    domainMismatchCookies: 0,
    expiredCookies: 0,
    rejectedCookies: 0,
  };

  it("writes the 1st, 10th and 100th of a repeated rejection, with the running count", () => {
    const governor = new BrowserObservedConnectionGovernor(() => Date.now());
    for (let occurrence = 0; occurrence < 100; occurrence += 1) {
      traceBrowserObservedProfile(REFUSED, {
        hostId: "host-1",
        connectionId: "connection-1",
        governor,
      });
    }

    // Rejections arrive at wire rate and carry a sender-chosen domain, so a
    // line each is the flood it describes. Exponential sampling keeps the first
    // occurrence and the magnitude and drops the repetition.
    expect(log.warn).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenNthCalledWith(
      1,
      "[browser-view] refused an observed sign-in",
      expect.objectContaining({ reason: "ledger-unacked", occurrences: 1 }),
    );
    expect(log.warn).toHaveBeenNthCalledWith(
      3,
      "[browser-view] refused an observed sign-in",
      expect.objectContaining({ reason: "ledger-unacked", occurrences: 100 }),
    );
  });

  it("tallies each reason and each connection on its own", () => {
    const governor = new BrowserObservedConnectionGovernor(() => Date.now());
    traceBrowserObservedProfile(REFUSED, {
      hostId: "host-1",
      connectionId: "connection-1",
      governor,
    });
    traceBrowserObservedProfile(
      { ...REFUSED, outcome: "over-bound" },
      { hostId: "host-1", connectionId: "connection-1", governor },
    );
    traceBrowserObservedProfile(REFUSED, {
      hostId: "host-1",
      connectionId: "connection-2",
      governor,
    });
    // The second `ledger-unacked` on connection-1 is the coalesced one.
    traceBrowserObservedProfile(REFUSED, {
      hostId: "host-1",
      connectionId: "connection-1",
      governor,
    });

    expect(log.warn).toHaveBeenCalledTimes(3);
  });
});

describe("observed sign-in echo", () => {
  it("produces exactly one delta round for one applied frame", async () => {
    const harness = new ObservedApplyHarness();
    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = new BrowserCookieChangeObserver({
      cookies: harness.jar,
      emit: (delta) => deltas.push(delta),
      now: () => Date.now(),
      coalesceWindowMs: BROWSER_COOKIE_DELTA_WINDOW_MS,
    });
    observer.attach();

    const result = await harness.applyFrame([
      observedCookie({ name: "sid", domain: "example.com", expires: -1 }),
      observedCookie({ name: "csrf", domain: "example.com", expires: -1 }),
      observedCookie({
        name: "sub",
        domain: "app.example.com",
        expires: futureSeconds(),
      }),
    ]);
    expect(result.appliedCookies).toBe(3);

    // The echo is deliberately NOT suppressed: it is what converges the user's
    // other hosts on the jar. What must not happen is amplification.
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.cookies.map((cookie) => cookie.name).sort()).toEqual([
      "csrf",
      "sid",
      "sub",
    ]);
    expect(deltas[0]?.removedKeys).toEqual([]);

    // Nothing re-opens a window on its own: the loop terminates here, and the
    // host's own no-op merge is what stops it coming back the other way.
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS * 3);
    expect(deltas).toHaveLength(1);

    observer.dispose();
  });
});
