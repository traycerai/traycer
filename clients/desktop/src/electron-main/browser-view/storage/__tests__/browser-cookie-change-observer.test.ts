import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cookie } from "electron";
import type { BrowserPrimaryProfileDelta } from "@traycer/protocol/host/browser/contracts";
import {
  BROWSER_COOKIE_DELTA_WINDOW_MS,
  BrowserCookieChangeObserver,
  type BrowserCookieChangeSource,
} from "../browser-cookie-change-observer";

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

type CookieChangeListener = (
  event: unknown,
  cookie: Cookie,
  cause: string,
  removed: boolean,
) => void;

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

function matchesDomainFilter(
  cookieDomain: string,
  filterDomain: string,
): boolean {
  const normalized = cookieDomain.startsWith(".")
    ? cookieDomain.slice(1)
    : cookieDomain;
  return normalized === filterDomain || normalized.endsWith(`.${filterDomain}`);
}

interface CookieFixtureInput {
  readonly name: string;
  readonly domain: string;
}

function makeCookie(input: CookieFixtureInput): Cookie {
  return {
    name: input.name,
    value: `${input.name}-value`,
    domain: input.domain,
    hostOnly: false,
    path: "/",
    secure: false,
    httpOnly: false,
    session: true,
    sameSite: "lax",
    expirationDate: 4_102_444_800,
  };
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
    expect(delta.scope).toEqual({ kind: "domain", domain: "example.com" });
    // issuedAt is when the window opened (the first change), not the later
    // flush time - the host uses it to order captures, so a flush-time stamp
    // would misorder a burst that straddled the window boundary.
    expect(delta.issuedAt).toBe(openedAt);
    expect(delta.cookies.map((cookie) => cookie.name).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(delta.removedKeys).toEqual([]);

    observer.dispose();
  });

  it("reports a genuine removal in removedKeys but drops a remove-then-reset within the same window", async () => {
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
    expect(delta.removedKeys).toEqual([
      { domain: "example.com", name: "gone", path: "/" },
    ]);
    expect(delta.cookies.map((cookie) => cookie.name)).toEqual(["reset"]);

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
    expect(deltas.map((delta) => delta.scope)).toEqual([
      { kind: "domain", domain: "example.com" },
    ]);

    observer.dispose();
  });

  it("lets emitDeltaNow speak through per-domain suppression but not through suppressAll", async () => {
    const source = new FakeCookieChangeSource();
    const deltas: BrowserPrimaryProfileDelta[] = [];
    const observer = makeObserver(source, deltas);
    source.seed(makeCookie({ name: "sid", domain: "example.com" }));

    // Ticket 07's clear-site holds the domain muted so its own removals cannot
    // echo, then says the one true thing about the slice. That has to get out.
    await observer.suppress("example.com", () =>
      observer.emitDeltaNow("example.com"),
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.scope).toEqual({ kind: "domain", domain: "example.com" });

    // Ticket 08's forget-all is shredding the whole slice. A clear-site racing
    // it must not put the site back on the host's side of the wire.
    await observer.suppressAll(() =>
      observer.suppress("example.com", () =>
        observer.emitDeltaNow("example.com"),
      ),
    );
    expect(deltas).toHaveLength(1);

    observer.dispose();
  });

  it("abandons an in-flight emitDeltaNow when a forget-all starts mid-read", async () => {
    const source = new FakeCookieChangeSource();
    const deltas: BrowserPrimaryProfileDelta[] = [];
    let releaseRead = (): void => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    // The jar read is asynchronous in Electron too, so the suppression state
    // can change under it. Only the gate is fake here.
    const gated: BrowserCookieChangeSource = {
      get: async (filter) => {
        await readGate;
        return await source.get(filter);
      },
      on: (event, listener) => source.on(event, listener),
      off: (event, listener) => source.off(event, listener),
    };
    const observer = new BrowserCookieChangeObserver({
      cookies: gated,
      emit: (delta) => deltas.push(delta),
      now: () => Date.now(),
      coalesceWindowMs: BROWSER_COOKIE_DELTA_WINDOW_MS,
    });
    observer.attach();
    source.seed(makeCookie({ name: "sid", domain: "example.com" }));

    const emitting = observer.emitDeltaNow("example.com");
    let releaseForget = (): void => {};
    const forgetting = observer.suppressAll(
      () =>
        new Promise<void>((resolve) => {
          releaseForget = resolve;
        }),
    );
    releaseRead();
    await emitting;

    expect(deltas).toEqual([]);
    releaseForget();
    await forgetting;

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
    expect(deltas.map((delta) => delta.scope.domain).sort()).toEqual([
      "example.com",
      "other.test",
    ]);

    observer.dispose();
  });
});
