import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cookie } from "electron";
import type { BrowserPrimaryProfileDelta } from "@traycer/protocol/host/browser/contracts";
import {
  BROWSER_COOKIE_DELTA_WINDOW_MS,
  BrowserCookieChangeObserver,
  type BrowserCookieChangeSource,
} from "../browser-cookie-change-observer";
import { browserStorageCookies } from "../browser-storage-state";
import {
  makeCookie,
  matchesDomainFilter,
  type CookieChangeListener,
} from "./cookie-jar-fixture";

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
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
    this.emit(cookie, false);
  }

  /** Removes a cookie from the jar and fires the matching removal event. */
  remove(cookie: Cookie): void {
    const index = this.indexOf(cookie);
    if (index !== -1) this.jar.splice(index, 1);
    this.emit(cookie, true);
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

  private emit(cookie: Cookie, removed: boolean): void {
    if (this.listener === null) {
      throw new Error("FakeCookieChangeSource fired before attach()");
    }
    this.listener({}, cookie, "explicit", removed);
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

function makeObserver(
  source: BrowserCookieChangeSource,
  deltas: BrowserPrimaryProfileDelta[],
): BrowserCookieChangeObserver {
  const observer = new BrowserCookieChangeObserver({
    cookies: source,
    emit: (delta) => deltas.push(delta),
    now: () => Date.now(),
    coalesceWindowMs: BROWSER_COOKIE_DELTA_WINDOW_MS,
  });
  observer.attach();
  return observer;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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

  it("suppresses a domain's changes during the callback and drops an already-open window rather than flushing it", async () => {
    const source = new FakeCookieChangeSource();
    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    // Opens a window that suppress() must drop, not flush, on entry.
    source.set(makeCookie({ name: "sid", domain: "example.com" }));

    await observer.suppress("example.com", async () => {
      source.set(makeCookie({ name: "other", domain: "example.com" }));
      await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);
      // Neither the pre-existing window nor the in-callback change surfaced,
      // even though the window would ordinarily have flushed by now.
      expect(deltas).toHaveLength(0);
    });

    // Nothing was left running after suppress() returned either.
    await vi.advanceTimersByTimeAsync(BROWSER_COOKIE_DELTA_WINDOW_MS);
    expect(deltas).toHaveLength(0);

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
    // An IDN domain punycodes in the domain check and throws there - a cookie
    // Chromium hands over for any such site the user visits.
    source.seed(makeCookie({ name: "idn", domain: "exämple.example.com" }));
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

    // The evict the host asked for, in full: the window this suppression drops
    // is already gone (the flush deleted it), and the suppression both starts
    // and finishes before the read resolves - so the check before the await
    // and the check after it BOTH see an unsuppressed observer.
    await observer.suppress("example.com", () => {
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
 * The receive-side read of the same suppression (universal-sign-in ticket 03):
 * while this jar is being cleared, an incoming `primaryProfileObserved` frame
 * for that scope is refused rather than merged.
 *
 * Strictly point-in-time - there is deliberately no window on either side of
 * the clear. A clock cannot tell a capture taken BEFORE a forget from one taken
 * after it, so the frame already in flight is refused by the forget ledger's
 * acked revision (ticket 04), not guessed at here. What makes this read
 * meaningful is ordering, not duration: the applier and every clear path run
 * through one keyed serial queue, so the answer cannot change under the caller.
 */
describe("BrowserCookieChangeObserver clear-in-progress read", () => {
  it("refuses the scope being cleared, and only while the clear is running", async () => {
    const source = new FakeCookieChangeSource();
    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    expect(observer.clearInProgress("example.com")).toBe(false);

    let refusedDuringClear = false;
    let refusedOtherSite = true;
    await observer.suppress("www.example.com", () => {
      // The scope is the registrable domain the clear actually empties, so a
      // frame naming any host under it is refused - and nothing wider is.
      refusedDuringClear = observer.clearInProgress("app.example.com");
      refusedOtherSite = observer.clearInProgress("notexample.com");
      return Promise.resolve();
    });

    expect(refusedDuringClear).toBe(true);
    expect(refusedOtherSite).toBe(false);
    // No tail: once the clear is done this read says nothing about frames that
    // were captured before it. That question belongs to the ledger revision.
    expect(observer.clearInProgress("example.com")).toBe(false);

    observer.dispose();
  });

  it("refuses every scope while a forget-all is running", async () => {
    const source = new FakeCookieChangeSource();
    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);

    let refusedUnrelated = false;
    await observer.suppressAll(() => {
      // A forget names no site, so nothing may be written to any of them while
      // it runs.
      refusedUnrelated = observer.clearInProgress("unrelated.test");
      return Promise.resolve();
    });

    expect(refusedUnrelated).toBe(true);
    expect(observer.clearInProgress("unrelated.test")).toBe(false);

    observer.dispose();
  });
});
