import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_BURST,
  BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserPrimaryProfileDelta,
  BrowserStorageCookie,
} from "@traycer/protocol/host/browser/contracts";
import {
  carryOverEchoCookies,
  carryOverForgetLedgerDigest,
  CARRY_OVER_DOMAIN,
  carryOverObservedFrame,
  CARRY_OVER_PERSISTENT_EXPIRES,
  forgetLedgerFrame,
  observedFrame,
  type ObservedServerFrame,
} from "@traycer/protocol/host/browser/__tests__/observed-carry-over-fixture";
import { browserViewIpcPayload } from "../../../ipc/browser-view-ipc-payload";
import {
  applyBrowserObservedProfile,
  BrowserObservedConnectionGovernor,
  type BrowserObservedProfileOutcome,
} from "../browser-observed-profile";
import { BrowserJarSerializer } from "../browser-jar-serializer";
import {
  BROWSER_COOKIE_DELTA_WINDOW_MS,
  BrowserCookieChangeObserver,
} from "../browser-cookie-change-observer";
import {
  browserForgetLedgerDigestForHost,
  initBrowserForgetLedger,
  isBrowserForgetLedgerPendingAck,
  isHeadlessOriginCookieKey,
  recordForgetLedgerAck,
  recordForgottenBrowserSite,
  recordHeadlessOriginCookieKeys,
  releaseBrowserForgetLedgerConnection,
  releaseHeadlessOriginCookieKeys,
} from "../browser-forget-ledger";
import { cookieKeyId } from "../browser-storage-state";
import { FakeCookieJar } from "./cookie-jar-fixture";

/**
 * The DESKTOP half of the universal-sign-in carry-over loop, driven from the
 * frames a host actually sends (ticket 07).
 *
 * The loop crosses a repo boundary, so this file and its host-side twin
 * (`observed-carry-over.cross-plane.test.ts` in `traycer-host`) meet at
 * `observed-carry-over-fixture.ts` in `@traycer/protocol`. Every observation
 * here comes out of that fixture already parsed by the real server-frame union
 * and is then put through the real IPC payload schema, so both narrowing layers
 * a frame crosses on this machine run before the applier sees it - and the
 * ECHO this file measures is pinned back against the shared fixture, which is
 * what the host suite consumes to prove the loop terminates.
 *
 * Ticket 03's applier suite and ticket 04's ledger suite own the unit-level
 * semantics - counts, partial application, trace sampling, digest projection,
 * watermark monotonicity - and are not repeated here.
 */

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
}));

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  sanitizeLogFields: (fields: Record<string, unknown>) => fields,
  describeLogError: (error: unknown) => String(error),
}));

const HOST_ID = "host-1";
const CONNECTION_ID = "connection-1";

/**
 * The frames only THIS side has a use for: nothing produces them, and no host
 * assertion consumes them, so they are built here out of the shared
 * {@link observedFrame} rather than carried in the cross-repo fixture.
 */
function cookie(input: {
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

/** A claimed domain that derives to nothing, so no scope can check its cookies. */
function domainMismatchFrame(): ObservedServerFrame {
  return observedFrame({
    domain: ".",
    cookies: [cookie({ name: "sid", domain: ".", expires: -1 })],
  });
}

/** One cookie over the wire bound, which the applier drops whole. */
function overBoundFrame(): ObservedServerFrame {
  return observedFrame({
    domain: CARRY_OVER_DOMAIN,
    cookies: Array.from(
      { length: BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_COOKIES + 1 },
      (_unused, index) =>
        cookie({
          name: `c${index}`,
          domain: CARRY_OVER_DOMAIN,
          expires: -1,
        }),
    ),
  });
}

/**
 * A live sign-in carrying one already-expired cookie - a removal wearing a
 * write's clothing, dropped per cookie while the rest of the frame applies.
 */
function expiredCookieFrame(expiredAt: number): ObservedServerFrame {
  return observedFrame({
    domain: CARRY_OVER_DOMAIN,
    cookies: [
      cookie({ name: "fresh", domain: CARRY_OVER_DOMAIN, expires: -1 }),
      cookie({ name: "sid", domain: CARRY_OVER_DOMAIN, expires: expiredAt }),
    ],
  });
}

/**
 * One desktop's receive path for an observed frame, wired exactly as
 * `browser-view-ipc.ts` wires it: the IPC payload schema, the real applier, the
 * real per-connection governor, the real jar serializer, and the real forget
 * ledger as the no-resurrection gate.
 */
class DesktopReceiveHarness {
  readonly jar = new FakeCookieJar();
  /**
   * The desktop's own cookie observer, when a case wires one. `browser-
   * session.ts` hands the applier's claims to it exactly like this, and it is
   * the half `ObservedApplyHarness` cannot exercise.
   */
  observer: BrowserCookieChangeObserver | null = null;
  private readonly serializer = new BrowserJarSerializer();
  private readonly governor = new BrowserObservedConnectionGovernor(() =>
    Date.now(),
  );

  async receive(
    frame: ObservedServerFrame,
    connectionId: string,
  ): Promise<BrowserObservedProfileOutcome> {
    // The renderer adds the connection provenance the frame never carries, and
    // the main process narrows the whole thing again at the IPC edge.
    const observed = browserViewIpcPayload.observedProfile.parse({
      connectionId,
      hostId: HOST_ID,
      domain: frame.domain,
      cookies: frame.cookies,
    });
    const result = await applyBrowserObservedProfile(observed, {
      now: () => Date.now(),
      isForgottenPendingAck: isBrowserForgetLedgerPendingAck,
      isHeadlessOriginKey: isHeadlessOriginCookieKey,
      // Wired exactly as `browser-view-ipc.ts` wires it, observer half
      // included - the half `ObservedApplyHarness` has no observer for.
      claimHeadlessOriginKeys: (keys) => {
        this.observer?.noteAppliedKeys(keys);
        return recordHeadlessOriginCookieKeys(keys);
      },
      releaseHeadlessOriginKeys: (keys) => {
        this.observer?.forgetAppliedKeys(keys);
        return releaseHeadlessOriginCookieKeys(keys);
      },
      getTargetJar: () => ({
        session: { cookies: this.jar },
        durableJar: true,
      }),
      serializeOnDomain: (domain, action) =>
        this.serializer.runOnDomain(domain, action),
      governor: this.governor,
    });
    return result.outcome;
  }
}

let directory = "";
let harness: DesktopReceiveHarness;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  directory = await mkdtemp(join(tmpdir(), "carry-over-cross-plane-"));
  // A ledger with nothing in it, so a test that does not forget anything is
  // never gated by another test's file.
  await initBrowserForgetLedger(join(directory, `${crypto.randomUUID()}.json`));
  releaseBrowserForgetLedgerConnection(CONNECTION_ID);
  harness = new DesktopReceiveHarness();
});

afterEach(async () => {
  releaseBrowserForgetLedgerConnection(CONNECTION_ID);
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

describe("carry-over loop, desktop side of the wire", () => {
  it("applies the host's observation and echoes exactly the shared fixture's delta, once", async () => {
    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = new BrowserCookieChangeObserver({
      cookies: harness.jar,
      emit: (delta) => deltas.push(delta),
      now: () => Date.now(),
      // Additions only, which no removal guard touches, so one faked clock
      // answers for both.
      monotonicNow: () => Date.now(),
      coalesceWindowMs: BROWSER_COOKIE_DELTA_WINDOW_MS,
      // This suite is about the echo, not about ownership attribution, which
      // `browser-observed-profile.test.ts` pins against the real observer.
      onLocalCookieWrite: () => undefined,
    });
    observer.attach();

    expect(await harness.receive(carryOverObservedFrame(), CONNECTION_ID)).toBe(
      "applied",
    );
    expect(harness.jar.names()).toEqual(["csrf", "sid"]);

    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    // THE PIN. The host suite feeds `carryOverEchoCookies()` into the real
    // store and asserts the next headless capture learns nothing from it - the
    // loop's only terminator. That argument is only as good as this equality:
    // if Chromium's round trip ever spells a field differently from what the
    // host stored, it fails HERE rather than as an unbounded emit/apply/echo
    // cycle in production.
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.domain).toBe(CARRY_OVER_DOMAIN);
    expect(deltas[0]?.removedKeys).toEqual([]);
    expect(
      deltas[0]?.cookies.toSorted((left, right) =>
        left.name < right.name ? -1 : 1,
      ),
    ).toEqual(
      carryOverEchoCookies().toSorted((left, right) =>
        left.name < right.name ? -1 : 1,
      ),
    );

    // Nothing re-opens a window on its own: one applied frame is one echo.
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS * 3);
    expect(deltas).toHaveLength(1);

    observer.dispose();
  });

  it("keeps the custody it claimed over its own writes, and loses it to the desktop's", async () => {
    // The ORDER pin, and the one that needs a real observer: the applier
    // claims the keys before it writes them, because its own `cookies.set`
    // fires the same insert event the desktop's browsing does. Claim after the
    // write and the observer sees an insert it cannot attribute, releases the
    // key, and the sending host loses the right to refresh the session it just
    // established. `ObservedApplyHarness` cannot see this - it wires no
    // observer - so the case lives here, with the real one.
    const observer = new BrowserCookieChangeObserver({
      cookies: harness.jar,
      emit: () => undefined,
      now: () => Date.now(),
      monotonicNow: () => Date.now(),
      coalesceWindowMs: BROWSER_COOKIE_DELTA_WINDOW_MS,
      onLocalCookieWrite: (key) => void releaseHeadlessOriginCookieKeys([key]),
    });
    observer.attach();
    harness.observer = observer;
    const sid = cookieKeyId({
      domain: CARRY_OVER_DOMAIN,
      name: "sid",
      path: "/",
    });

    expect(await harness.receive(carryOverObservedFrame(), CONNECTION_ID)).toBe(
      "applied",
    );

    expect(isHeadlessOriginCookieKey(sid)).toBe(true);

    // And the desktop's own browsing writing the same key takes it straight
    // back - the other half of the same mechanism, on the same jar.
    await harness.jar.set({
      url: `https://${CARRY_OVER_DOMAIN}/`,
      name: "sid",
      value: "signed-in-here",
      domain: CARRY_OVER_DOMAIN,
      path: "/",
      secure: true,
      expirationDate: CARRY_OVER_PERSISTENT_EXPIRES,
    });

    expect(isHeadlessOriginCookieKey(sid)).toBe(false);

    observer.dispose();
  });
});

describe("desktop rejections over real frames", () => {
  it("refuses a frame whose claimed domain derives to nothing", async () => {
    expect(await harness.receive(domainMismatchFrame(), CONNECTION_ID)).toBe(
      "domain-mismatch",
    );
    expect(harness.jar.names()).toEqual([]);
  });

  it("refuses a frame over the wire's cookie bound, whole", async () => {
    expect(await harness.receive(overBoundFrame(), CONNECTION_ID)).toBe(
      "over-bound",
    );
    // Whole, not a prefix: applying part of an over-bound frame would let a
    // sender choose which half of a sign-in reaches the master jar.
    expect(harness.jar.names()).toEqual([]);
  });

  it("drops an expired cookie per cookie and applies the rest of the frame", async () => {
    // The implicit sign-out channel: a frame with no removals field can still
    // perform one by re-setting a live cookie with a past expiry, which
    // Chromium treats as a delete.
    harness.jar.seed({
      name: "sid",
      value: "live-session",
      domain: CARRY_OVER_DOMAIN,
      hostOnly: true,
      path: "/",
      secure: true,
      httpOnly: false,
      session: false,
      sameSite: "lax",
      expirationDate: CARRY_OVER_PERSISTENT_EXPIRES,
    });

    expect(
      await harness.receive(
        expiredCookieFrame(Date.now() / 1_000 - 60),
        CONNECTION_ID,
      ),
    ).toBe("applied");
    expect(harness.jar.find("sid")?.value).toBe("live-session");
    expect(harness.jar.names()).toEqual(["fresh", "sid"]);
  });

  it("refuses a host that keeps sending past one attach replay's worth", async () => {
    for (
      let sent = 0;
      sent < BROWSER_PRIMARY_PROFILE_OBSERVED_MAX_BURST;
      sent += 1
    ) {
      expect(
        await harness.receive(carryOverObservedFrame(), CONNECTION_ID),
      ).toBe("applied");
    }

    // The burst is the number the HOST paces its replay to, so a limiter that
    // refused earlier would silently truncate a legitimate reconnect.
    expect(await harness.receive(carryOverObservedFrame(), CONNECTION_ID)).toBe(
      "rate-limited",
    );
  });

  it("refuses an observation for a site this connection has not acked pruning", async () => {
    await recordForgottenBrowserSite(CARRY_OVER_DOMAIN);

    expect(await harness.receive(carryOverObservedFrame(), CONNECTION_ID)).toBe(
      "ledger-unacked",
    );
    expect(harness.jar.names()).toEqual([]);
  });
});

describe("offline forget, driven from the desktop", () => {
  it("projects the digest the host prunes from, and holds the login gone until that host acks", async () => {
    // The user forgets a site while the host holding it is disconnected. There
    // is no stream to tell, so the record IS the ledger.
    const revision = await recordForgottenBrowserSite(CARRY_OVER_DOMAIN);
    expect(revision).toBe(1);

    const digest = browserForgetLedgerDigestForHost(HOST_ID);
    const forgottenAt = digest.domains[0]?.forgottenAt ?? 0;
    // Pinned against the shared fixture on everything but this machine's own
    // wall clock, and then proven wire-legal. The host suite consumes exactly
    // this digest to show its replay does not resurrect the site.
    expect(digest).toEqual(carryOverForgetLedgerDigest(forgottenAt));
    expect(forgetLedgerFrame(digest).revision).toBe(revision);

    // The host comes back and, before its prune has been confirmed, replays
    // what it still holds. Refused: an ack is the only evidence the prune
    // happened, and this connection has given none.
    expect(await harness.receive(carryOverObservedFrame(), CONNECTION_ID)).toBe(
      "ledger-unacked",
    );
    expect(harness.jar.names()).toEqual([]);

    // The host acks the revision it pruned through. Everything it observes
    // after that is a post-prune capture, so the gate opens.
    await recordForgetLedgerAck({
      hostId: HOST_ID,
      connectionId: CONNECTION_ID,
      revision,
    });

    expect(await harness.receive(carryOverObservedFrame(), CONNECTION_ID)).toBe(
      "applied",
    );
    expect(harness.jar.names()).toEqual(["csrf", "sid"]);
  });
});
