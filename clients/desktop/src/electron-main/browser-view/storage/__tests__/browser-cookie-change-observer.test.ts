import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cookie } from "electron";
import type {
  BrowserCookieKey,
  BrowserPrimaryProfileDelta,
} from "@traycer/protocol/host/browser/contracts";
import {
  BROWSER_COOKIE_DELTA_WINDOW_MS,
  BROWSER_COOKIE_REMOVAL_GRACE_MS,
  BrowserCookieChangeObserver,
  type BrowserCookieChangeSource,
} from "../browser-cookie-change-observer";
import { log } from "../../../app/logger";
import { browserStorageCookies } from "../browser-storage-state";
import {
  makeCookie,
  makeSessionCookie,
  matchesDomainFilter,
  type CookieChangeListener,
} from "./cookie-jar-fixture";

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  // The real one, near enough for these assertions: what matters is that the
  // trace passes its fields through a truncating redactor at all.
  sanitizeLogFields: (fields: Record<string, unknown>) => fields,
  describeLogError: (error: unknown) => String(error),
}));

/**
 * Minimal stand-in for Electron's `Session["cookies"]`: a jar array plus the
 * single listener slot the observer actually uses. `get({domain})` mirrors
 * Chromium's own domain-match filter (the domain itself or any subdomain of
 * it) - the observer's flush path leans on exactly that behaviour to read
 * back "everything the scope currently holds".
 */
class FakeCookieChangeSource implements BrowserCookieChangeSource {
  private readonly jar: Cookie[] = [];
  private listener: CookieChangeListener | null = null;

  get(filter: { readonly domain: string }): Promise<Cookie[]> {
    return Promise.resolve(
      this.jar.filter((cookie) =>
        matchesDomainFilter(cookie.domain ?? "", filter.domain),
      ),
    );
  }

  on(_event: "changed", listener: CookieChangeListener): void {
    this.listener = listener;
  }

  off(_event: "changed", listener: CookieChangeListener): void {
    if (this.listener === listener) this.listener = null;
  }

  /** Adds a cookie to the jar without firing a `changed` event - pre-existing state the observer never saw appear. */
  seed(cookie: Cookie): void {
    this.jar.push(cookie);
  }

  /** Upserts a cookie and fires the matching `changed` event - jar first, then event, exactly as Chromium does it. */
  set(cookie: Cookie): void {
    this.upsert(cookie);
    this.emit(cookie, "explicit", false);
  }

  /** Removes a cookie from the jar and fires the matching removal event. */
  remove(cookie: Cookie): void {
    this.removeWithCause(cookie, "explicit");
  }

  /**
   * The same, under one of Chromium's other removal causes: `expired` for the
   * expiry sweep, `evicted` for capacity garbage collection, and
   * `expired-overwrite` for a `Set-Cookie` carrying a past date - which is a
   * server-side sign-out and stays witnessable.
   */
  removeWithCause(cookie: Cookie, cause: string): void {
    const index = this.indexOf(cookie);
    if (index !== -1) this.jar.splice(index, 1);
    this.emit(cookie, cause, true);
  }

  private upsert(cookie: Cookie): void {
    const index = this.indexOf(cookie);
    if (index === -1) this.jar.push(cookie);
    else this.jar[index] = cookie;
  }

  private indexOf(cookie: Cookie): number {
    return this.jar.findIndex(
      (existing) =>
        existing.name === cookie.name &&
        existing.domain === cookie.domain &&
        existing.path === cookie.path,
    );
  }

  private emit(cookie: Cookie, cause: string, removed: boolean): void {
    if (this.listener === null) {
      throw new Error("FakeCookieChangeSource fired before attach()");
    }
    this.listener({}, cookie, cause, removed);
  }
}

/**
 * The same jar with every `get()` parked until the test releases it. The flush
 * path reads its slice through `cookies.get()`, so holding that promise open is
 * the only way to place a WHOLE suppression - entry and exit both - inside the
 * flush's await, which is the interval neither point-in-time check can see.
 */
class GatedCookieChangeSource extends FakeCookieChangeSource {
  private pendingRead: (() => void) | null = null;

  override get(filter: { readonly domain: string }): Promise<Cookie[]> {
    // Read the jar now, resolve later: what the flush ends up holding is the
    // slice as it was when the read started, exactly as a real in-flight read
    // would be.
    const slice = super.get(filter);
    return new Promise<Cookie[]>((resolve) => {
      this.pendingRead = () => {
        this.pendingRead = null;
        resolve(slice);
      };
    });
  }

  readIsParked(): boolean {
    return this.pendingRead !== null;
  }

  releaseRead(): void {
    const pendingRead = this.pendingRead;
    if (pendingRead === null) throw new Error("no cookie read is parked");
    pendingRead();
  }
}

/**
 * Every key the observer attributed to this machine's own browsing, in order.
 *
 * It is the ownership rule's one input (universal-sign-in ticket 08): a key
 * that lands here is one a host may no longer overwrite.
 */
const localWrites: BrowserCookieKey[] = [];

/**
 * Attaches with the startup grace window running: the clock reads the attach
 * instant.
 *
 * `monotonicNow` is driven off the same faked `Date` as `now` rather than off
 * `performance`, so `advanceTimersByTimeAsync` moves both and a test's elapsed
 * time means one thing. In production they are different clocks precisely
 * because the wall one can go backwards.
 */
function makeObserverAtAttach(
  source: BrowserCookieChangeSource,
  deltas: BrowserPrimaryProfileDelta[],
): BrowserCookieChangeObserver {
  const observer = new BrowserCookieChangeObserver({
    cookies: source,
    emit: (delta) => deltas.push(delta),
    now: () => Date.now(),
    monotonicNow: () => Date.now(),
    coalesceWindowMs: BROWSER_COOKIE_DELTA_WINDOW_MS,
    onLocalCookieWrite: (key) => localWrites.push(key),
  });
  observer.attach();
  return observer;
}

/**
 * The same, then straight past the startup grace window - the state a jar is
 * in for all but the first minute of a run, and the only state in which a
 * removal is witnessed at all. Nothing is scheduled at attach, so moving the
 * clock here fires no timer; it just puts the observer where every test that
 * is not ABOUT the grace window means to be.
 */
function makeObserver(
  source: BrowserCookieChangeSource,
  deltas: BrowserPrimaryProfileDelta[],
): BrowserCookieChangeObserver {
  const observer = makeObserverAtAttach(source, deltas);
  vi.setSystemTime(Date.now() + BROWSER_COOKIE_REMOVAL_GRACE_MS);
  return observer;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // The trace assertions below are about what THIS test wrote, and one of them
  // is an absence.
  vi.clearAllMocks();
  localWrites.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserCookieChangeObserver coalescing", () => {
  it("collapses three changes across two hosts of one registrable domain into a single delta whose issuedAt is the window-open time", async () => {
    const source = new FakeCookieChangeSource();
    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    const openedAt = Date.now();
    const cookieA = makeCookie({ name: "a", domain: "a.example.com" });
    const cookieB = makeCookie({ name: "b", domain: "example.com" });
    const cookieC = makeCookie({ name: "c", domain: "www.example.com" });

    source.set(cookieA);
    await vi.advanceTimersByTimeAsync(500);
    source.set(cookieB);
    await vi.advanceTimersByTimeAsync(400);
    source.set(cookieC);

    // Still inside the window: nothing has flushed yet.
    expect(deltas).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS - 900);

    expect(deltas).toHaveLength(1);
    const delta = deltas[0];
    if (delta === undefined) throw new Error("expected a flushed delta");
    expect(delta.domain).toBe("example.com");
    // issuedAt is when the window opened (the first change), not the later
    // flush time - the host uses it to order captures, so a flush-time stamp
    // would misorder a burst that straddled the window boundary.
    expect(delta.issuedAt).toBe(openedAt);
    expect(delta.cookies.map((cookie) => cookie.name).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    // A plain set/refresh removed nothing: this is the load-bearing case,
    // since the host signs live sessions out on exactly this field.
    expect(delta.removedKeys).toEqual([]);

    observer.dispose();
  });

  it("reports only the final state of a scope after a remove-then-reset within the same window", async () => {
    const source = new FakeCookieChangeSource();
    const goneCookie = makeCookie({ name: "gone", domain: "example.com" });
    const resetCookie = makeCookie({ name: "reset", domain: "example.com" });
    source.seed(goneCookie);
    source.seed(resetCookie);

    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    source.remove(goneCookie);
    source.remove(resetCookie);
    source.set(resetCookie);

    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(1);
    const delta = deltas[0];
    if (delta === undefined) throw new Error("expected a flushed delta");
    expect(delta.cookies.map((cookie) => cookie.name)).toEqual(["reset"]);
    // `goneCookie` really left the jar and stayed gone - a genuine removal.
    // `resetCookie` was removed then re-set within the same window (Chromium's
    // `overwrite` cause) and is present in the flushed slice, so its claim is
    // a coalescing artifact and must not survive.
    expect(delta.removedKeys).toEqual([
      { domain: "example.com", name: "gone", path: "/" },
    ]);

    observer.dispose();
  });

  it("suppressAll mutes every domain while the whole jar is cleared", async () => {
    const source = new FakeCookieChangeSource();
    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);
    const first = makeCookie({ name: "sid", domain: "example.com" });
    const second = makeCookie({ name: "sid", domain: "other.test" });
    source.seed(first);
    source.seed(second);

    // A window already open on entry describes a jar about to be destroyed.
    source.set(makeCookie({ name: "pending", domain: "example.com" }));

    await observer.suppressAll(async () => {
      // What `clearStorageData()` looks like from here: a removal for every
      // cookie in the jar, across domains the caller could not enumerate.
      source.remove(first);
      source.remove(second);
      await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);
      expect(deltas).toHaveLength(0);
    });

    // Nothing was left armed to fire after the forget either - a delta landing
    // now would re-create the entry the host just shredded.
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);
    expect(deltas).toHaveLength(0);

    // The observer is muted, not broken: the next real change still coalesces.
    source.set(makeCookie({ name: "fresh", domain: "example.com" }));
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);
    expect(deltas.map((delta) => delta.domain)).toEqual(["example.com"]);

    observer.dispose();
  });

  it("coalesces separately per registrable domain", async () => {
    const source = new FakeCookieChangeSource();
    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    source.set(makeCookie({ name: "sid", domain: "example.com" }));
    source.set(makeCookie({ name: "sid", domain: "other.test" }));

    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(2);
    expect(deltas.map((delta) => delta.domain).sort()).toEqual([
      "example.com",
      "other.test",
    ]);

    observer.dispose();
  });
});

describe("BrowserCookieChangeObserver unrepresentable cookies", () => {
  it("still emits the scope's delta when the jar holds a cookie it cannot normalise", async () => {
    const source = new FakeCookieChangeSource();
    // A domain the URL parser cannot place at all. It used to be enough for
    // the domain merely to need normalising (an IDN, a trailing root dot, a
    // capital); H11 made `readCookieDomain` normalise those the way Chromium's
    // own jar does, so only a genuinely malformed one refuses now.
    source.seed(
      makeCookie({ name: "malformed", domain: "ex ample.example.com" }),
    );
    const gone = makeCookie({ name: "gone", domain: "example.com" });
    source.seed(gone);

    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    source.remove(gone);
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    // One unrepresentable cookie used to throw inside the read and take the
    // whole delta with it - including the removedKeys that are this path's
    // only logout evidence, so a sign-out went unreported.
    expect(deltas).toHaveLength(1);
    const delta = deltas[0];
    if (delta === undefined) throw new Error("expected a flushed delta");
    expect(delta.cookies).toEqual([]);
    expect(delta.removedKeys).toEqual([
      { domain: "example.com", name: "gone", path: "/" },
    ]);

    observer.dispose();
  });
});

describe("BrowserCookieChangeObserver suppression across an in-flight read", () => {
  it("drops a slice whose read spanned a whole suppression - one that opened AND closed inside the await", async () => {
    const source = new GatedCookieChangeSource();
    const cookie = makeCookie({ name: "sid", domain: "example.com" });
    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    source.set(cookie);
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);
    // The flush is parked inside `cookies.get()`, holding a slice that still
    // has the cookie the clear is about to shred.
    expect(source.readIsParked()).toBe(true);
    expect(deltas).toEqual([]);

    // The forget the user asked for, in full: the window this suppression
    // drops is already gone (the flush deleted it), and the suppression both
    // starts and finishes before the read resolves - so the check before the
    // await and the check after it BOTH see an unsuppressed observer.
    await observer.suppressAll(() => {
      source.remove(cookie);
      return Promise.resolve();
    });

    source.releaseRead();
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    // Emitting that slice now would re-create for the host the login it just
    // shredded, from a read that predates the shredding.
    expect(deltas).toEqual([]);

    // Muted for that one read, not broken: the next change still coalesces.
    source.set(makeCookie({ name: "fresh", domain: "example.com" }));
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);
    source.releaseRead();
    await vi.advanceTimersByTimeAsync(0);
    expect(deltas.map((delta) => delta.domain)).toEqual(["example.com"]);
    expect(deltas[0]?.cookies.map((entry) => entry.name)).toEqual(["fresh"]);

    observer.dispose();
  });

  it("stays silent when the observer is disposed while the read is still parked", async () => {
    const source = new GatedCookieChangeSource();
    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    source.set(makeCookie({ name: "sid", domain: "example.com" }));
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);
    expect(source.readIsParked()).toBe(true);
    expect(deltas).toEqual([]);

    // Torn down mid-read. Dropping the open windows cannot reach this flush -
    // it took its window out of the map before it awaited - so only the epoch
    // can tell the resumed read that nobody is listening any more.
    observer.dispose();

    source.releaseRead();
    await vi.advanceTimersByTimeAsync(0);

    expect(deltas).toEqual([]);
  });
});

describe("BrowserCookieChangeObserver removedKeys (ticket 14)", () => {
  it("names a cookie the jar genuinely dropped in removedKeys", async () => {
    const source = new FakeCookieChangeSource();
    const goneCookie = makeCookie({ name: "sid", domain: "example.com" });
    source.seed(goneCookie);

    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    source.remove(goneCookie);
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(1);
    const delta = deltas[0];
    if (delta === undefined) throw new Error("expected a flushed delta");
    // The cookie is genuinely absent from the re-read slice, so its key
    // survives as logout evidence.
    expect(delta.cookies).toEqual([]);
    expect(delta.removedKeys).toEqual([
      { domain: "example.com", name: "sid", path: "/" },
    ]);

    observer.dispose();
  });

  it("carries an empty removedKeys for a plain set/refresh - the host signs live sessions out on exactly this field", async () => {
    const source = new FakeCookieChangeSource();
    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    source.set(makeCookie({ name: "sid", domain: "example.com" }));
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    // Pin a positive count too: if the set had not coalesced into a delta at
    // all, an empty removedKeys would prove nothing about this behaviour.
    expect(deltas).toHaveLength(1);
    const delta = deltas[0];
    if (delta === undefined) throw new Error("expected a flushed delta");
    expect(delta.cookies.map((cookie) => cookie.name)).toEqual(["sid"]);
    expect(delta.removedKeys).toEqual([]);

    observer.dispose();
  });

  it("drops a remove-then-re-set of the same key within one window (Chromium's overwrite cause)", async () => {
    const source = new FakeCookieChangeSource();
    const cookie = makeCookie({ name: "sid", domain: "example.com" });
    source.seed(cookie);

    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    source.remove(cookie);
    source.set(cookie);
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(1);
    const delta = deltas[0];
    if (delta === undefined) throw new Error("expected a flushed delta");
    // The key is present in the flushed slice, so a `removed=true` event
    // having fired during the window must not survive as a removal claim.
    expect(delta.cookies.map((cookie) => cookie.name)).toEqual(["sid"]);
    expect(delta.removedKeys).toEqual([]);

    observer.dispose();
  });

  it("dedupes repeated removals of the same key within one window to a single entry", async () => {
    const source = new FakeCookieChangeSource();
    const cookie = makeCookie({ name: "sid", domain: "example.com" });
    source.seed(cookie);

    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    source.remove(cookie);
    // Chromium can fire `changed` more than once for the same removal within
    // a burst; the key must still land as one entry, not one per event.
    source.remove(cookie);
    source.remove(cookie);
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(1);
    const delta = deltas[0];
    if (delta === undefined) throw new Error("expected a flushed delta");
    expect(delta.removedKeys).toEqual([
      { domain: "example.com", name: "sid", path: "/" },
    ]);

    observer.dispose();
  });

  it("keys removedKeys entries through the same normalisation as the capture path, byte-identical to what the host stores", async () => {
    const source = new FakeCookieChangeSource();
    // A leading-dot domain cookie (a non-host-only cookie set on the parent
    // domain) exercises the normalisation path `cookieKeyOf` shares with
    // `browserStorageCookies` - the capture routine the host's own store
    // reads. If the two ever diverged, a removal could never match a stored
    // key.
    const cookie = makeCookie({ name: "sid", domain: ".example.com" });
    const [expectedCapturedCookie] = browserStorageCookies([cookie]);
    if (expectedCapturedCookie === undefined) {
      throw new Error("expected the fixture cookie to normalise");
    }
    source.seed(cookie);

    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    source.remove(cookie);
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(1);
    const delta = deltas[0];
    if (delta === undefined) throw new Error("expected a flushed delta");
    expect(delta.removedKeys).toEqual([
      {
        domain: expectedCapturedCookie.domain,
        name: expectedCapturedCookie.name,
        path: expectedCapturedCookie.path,
      },
    ]);
    expect(Object.keys(delta.removedKeys[0] ?? {}).sort()).toEqual([
      "domain",
      "name",
      "path",
    ]);

    observer.dispose();
  });
});

/**
 * Universal-sign-in decision 7. `removedKeys` is the only field on this frame
 * that can sign a live remote session out, so what is allowed onto it is
 * narrower than what the jar actually did.
 *
 * The host end of that is a single chokepoint, which is what makes an empty
 * `removedKeys` sufficient here: `handlePrimaryProfileDelta` is the only delta
 * path that reaches `evictPrimaryProfileDomains`, it passes it exactly
 * `loggedOutDomains(frame.removedKeys, ...)`, and that returns `[]` for an
 * empty `removedKeys` before it looks at anything else. The merge still
 * reconciles the host's cache from `cookies`; it evicts nothing.
 */
describe("BrowserCookieChangeObserver witnessed-removal hardening", () => {
  it("never witnesses a session cookie's removal, inside the grace window or long after it", async () => {
    const source = new FakeCookieChangeSource();
    const sessionCookie = makeSessionCookie({
      name: "sid",
      domain: "example.com",
    });
    source.seed(sessionCookie);

    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserverAtAttach(source, deltas);

    // Inside the window - where the grace rule would suppress it anyway.
    source.remove(sessionCookie);
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.removedKeys).toEqual([]);

    // Hours later, with the grace window long spent: still not a logout. A
    // session cookie dies with the process, so its removal is what a restart
    // looks like.
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_REMOVAL_GRACE_MS * 60);
    source.seed(sessionCookie);
    source.remove(sessionCookie);
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(2);
    expect(deltas[1]?.removedKeys).toEqual([]);
    // The desktop's own view still tracked the change: the slice was re-read
    // and the cookie is gone from it. Only the logout claim was withheld.
    expect(deltas[1]?.cookies).toEqual([]);
    // Suppression is traceable, which is how the next forensic pass tells
    // "nothing was removed" apart from "a removal was not believed". At DEBUG,
    // because a session cookie dying is ordinary traffic and INFO would write
    // a line per domain per window for the life of the process.
    expect(log.debug).toHaveBeenCalledWith(
      "[browser-view] withheld cookie removals from a delta",
      {
        domain: "example.com",
        reason: "session-cookie",
        cause: "explicit",
        removals: 1,
      },
    );

    observer.dispose();
  });

  it("witnesses a persistent cookie's removal only once the startup grace window has passed", async () => {
    const source = new FakeCookieChangeSource();
    const early = makeCookie({ name: "early", domain: "example.com" });
    const late = makeCookie({ name: "late", domain: "example.com" });
    source.seed(early);
    source.seed(late);

    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserverAtAttach(source, deltas);

    // The incident's own timing: 18 s after attach, well inside the window.
    await vi.advanceTimersByTimeAsync(18_000);
    source.remove(early);
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.removedKeys).toEqual([]);
    expect(deltas[0]?.cookies.map((cookie) => cookie.name)).toEqual(["late"]);

    // Past the window, the same shape of removal is the user signing out.
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_REMOVAL_GRACE_MS);
    source.remove(late);
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(2);
    expect(deltas[1]?.removedKeys).toEqual([
      { domain: "example.com", name: "late", path: "/" },
    ]);

    observer.dispose();
  });

  it("leaves additions untouched throughout - only removals are untrusted at startup", async () => {
    const source = new FakeCookieChangeSource();
    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserverAtAttach(source, deltas);

    // A sign-in one second into the run, session cookie and all: the whole
    // point of the epic is that this still reaches the host.
    source.set(makeSessionCookie({ name: "sid", domain: "example.com" }));
    await vi.advanceTimersByTimeAsync(1_000);
    source.set(makeCookie({ name: "remember", domain: "example.com" }));
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.cookies.map((cookie) => cookie.name).sort()).toEqual([
      "remember",
      "sid",
    ]);
    expect(deltas[0]?.removedKeys).toEqual([]);

    observer.dispose();
  });

  it("still reports a remove-then-re-set inside the grace window as no removal, and the re-set cookie as present", async () => {
    const source = new FakeCookieChangeSource();
    const cookie = makeCookie({ name: "sid", domain: "example.com" });
    source.seed(cookie);

    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserverAtAttach(source, deltas);

    // Chromium's `overwrite` cause, during the window: the suppression must not
    // have disturbed the machinery that already handles this.
    source.remove(cookie);
    source.set(cookie);
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.cookies.map((entry) => entry.name)).toEqual(["sid"]);
    expect(deltas[0]?.removedKeys).toEqual([]);

    observer.dispose();
  });

  it("reports zero removedKeys for the 2026-09-01 boot drop: four keys vanish 18 s after attach", async () => {
    const source = new FakeCookieChangeSource();
    const dropped = [
      makeCookie({ name: "sid", domain: "github.com" }),
      makeCookie({ name: "user_session", domain: "github.com" }),
      makeCookie({ name: "device", domain: "www.github.com" }),
      makeCookie({ name: "prefs", domain: "github.com" }),
    ];
    dropped.forEach((cookie) => {
      source.seed(cookie);
    });

    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserverAtAttach(source, deltas);

    // Chromium's boot-time housekeeping, as the forensics recorded it: no user
    // touched the browser, and four persistent keys left the jar at once.
    await vi.advanceTimersByTimeAsync(18_000);
    dropped.forEach((cookie) => {
      source.remove(cookie);
    });
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    // The delta still goes out - the jar really did change, and the host's
    // cache converges on it - but it carries no logout evidence, and the empty
    // list is what makes `loggedOutDomains` return `[]` and the evict fan-out
    // never run. Before this ticket these four keys signed live remote
    // sessions out of GitHub.
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.domain).toBe("github.com");
    expect(deltas[0]?.cookies).toEqual([]);
    expect(deltas[0]?.removedKeys).toEqual([]);
    // Counted, not one line per cookie, and carrying the CAUSE string: that is
    // the evidence ticket 07's live pass needs to decide whether boot cleanup
    // ever announces itself outside `expired`/`evicted` - the one open
    // question keeping this window alive.
    // The DOMAIN is browsing history and this log lands in the support bundle,
    // so it stays on the debug line; the INFO line carries the counted reason
    // and nothing that names a site.
    expect(log.info).toHaveBeenCalledWith(
      "[browser-view] withheld cookie removals from a delta",
      { reason: "grace-window", cause: "explicit", removals: 4 },
    );
    expect(log.debug).toHaveBeenCalledWith(
      "[browser-view] withheld cookie removals from a delta",
      {
        domain: "github.com",
        reason: "grace-window",
        cause: "explicit",
        removals: 4,
      },
    );

    observer.dispose();
  });

  it("never witnesses a capacity eviction, hours into a run where no startup window could see it", async () => {
    const source = new FakeCookieChangeSource();
    const evicted = makeCookie({ name: "user_session", domain: "github.com" });
    const kept = makeCookie({ name: "prefs", domain: "github.com" });
    source.seed(evicted);
    source.seed(kept);

    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);
    // Ten minutes in: the grace window is long spent and the cookie is
    // persistent, so the CAUSE is the only thing standing between Chromium's
    // per-host capacity GC and a witnessed logout - which is the 2026-08-31
    // bug verbatim. (It broadcast a `primaryProfileEvict` back then; ticket 08
    // retired that frame, and what a witnessed removal now reaches is this
    // host's own live headless contexts.)
    await vi.advanceTimersByTimeAsync(600_000);

    source.removeWithCause(evicted, "evicted");
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.removedKeys).toEqual([]);
    expect(deltas[0]?.cookies.map((cookie) => cookie.name)).toEqual(["prefs"]);
    expect(log.info).toHaveBeenCalledWith(
      "[browser-view] withheld cookie removals from a delta",
      { reason: "housekeeping-cause", cause: "evicted", removals: 1 },
    );
    expect(log.debug).toHaveBeenCalledWith(
      "[browser-view] withheld cookie removals from a delta",
      {
        domain: "github.com",
        reason: "housekeeping-cause",
        cause: "evicted",
        removals: 1,
      },
    );

    observer.dispose();
  });

  it("never witnesses the expiry sweep, and still witnesses a server-side sign-out", async () => {
    const source = new FakeCookieChangeSource();
    const swept = makeCookie({ name: "stale", domain: "example.com" });
    const signedOut = makeCookie({ name: "sid", domain: "example.com" });
    source.seed(swept);
    source.seed(signedOut);

    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    source.removeWithCause(swept, "expired");
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.removedKeys).toEqual([]);

    // `expired-overwrite` is a `Set-Cookie` with a date in the past: the
    // canonical server-side logout, and the removal this whole path exists to
    // carry. The cause filter must not be so broad that it eats this one.
    source.removeWithCause(signedOut, "expired-overwrite");
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(2);
    expect(deltas[1]?.removedKeys).toEqual([
      { domain: "example.com", name: "sid", path: "/" },
    ]);

    observer.dispose();
  });

  it("counts no suppression for a session cookie the server merely re-set", async () => {
    const source = new FakeCookieChangeSource();
    const cookie = makeSessionCookie({ name: "sid", domain: "example.com" });
    source.seed(cookie);

    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    // Chromium's overwrite pair, which is what a silent refresh looks like -
    // the single most common thing that happens to a session cookie. Counting
    // the removal half as a suppression would trace ordinary churn forever.
    source.remove(cookie);
    source.set(cookie);
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.cookies.map((entry) => entry.name)).toEqual(["sid"]);
    expect(deltas[0]?.removedKeys).toEqual([]);
    expect(log.debug).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();

    observer.dispose();
  });
});

describe("BrowserCookieChangeObserver write attribution", () => {
  const sid: BrowserCookieKey = {
    domain: "example.com",
    name: "sid",
    path: "/",
  };

  it("reports a write nobody announced as this machine's own", () => {
    const source = new FakeCookieChangeSource();
    const observer = makeObserver(source, []);

    source.set(makeCookie({ name: "sid", domain: "example.com" }));

    expect(localWrites).toEqual([sid]);
    observer.dispose();
  });

  it("spends an announced applier write instead of claiming the key back", () => {
    const source = new FakeCookieChangeSource();
    const observer = makeObserver(source, []);

    observer.noteAppliedKeys([sid]);
    source.set(makeCookie({ name: "sid", domain: "example.com" }));
    expect(localWrites).toEqual([]);

    // One mark, one write. The next write of the same key is the desktop's,
    // which is what makes a host's contribution lose its update right the
    // moment the user signs in here themselves.
    source.set(makeCookie({ name: "sid", domain: "example.com" }));
    expect(localWrites).toEqual([sid]);

    observer.dispose();
  });

  it("attributes a removal to nobody: only a write transfers ownership", async () => {
    const source = new FakeCookieChangeSource();
    const cookie = makeCookie({ name: "sid", domain: "example.com" });
    const observer = makeObserver(source, []);
    source.set(cookie);
    localWrites.length = 0;

    source.remove(cookie);
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);

    expect(localWrites).toEqual([]);
    observer.dispose();
  });
});
