import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cookie, CookiesSetDetails } from "electron";
import type { BrowserStorageCookie } from "@traycer/protocol/host/browser/contracts";
import {
  browserForgetLedgerDigestForHost,
  browserForgetLedgerPendingClears,
  initBrowserForgetLedger,
  markBrowserForgetLedgerCleared,
  isBrowserForgetLedgerPendingAck,
  isHeadlessOriginCookieKey,
  releaseHeadlessOriginCookieKeys,
  onBrowserForgetLedgerChanged,
  recordForgetAllBrowserLogins,
  recordForgetLedgerAck,
  recordForgottenBrowserSite,
  recordHeadlessOriginCookieKeys,
  releaseBrowserForgetLedgerConnection,
  type BrowserForgetLedgerChange,
} from "../browser-forget-ledger";
import { applyBrowserObservedProfile } from "../browser-observed-profile";
import { BrowserObservedConnectionGovernor } from "../browser-observed-profile";
import { BrowserJarSerializer } from "../browser-jar-serializer";
import { cookieKeyId } from "../browser-storage-state";
import { matchesDomainFilter } from "./cookie-jar-fixture";

/**
 * The desktop's forget ledger (universal-sign-in ticket 04): the durable record
 * of what the user asked to be gone, the digest each host is still owed, and
 * the acked-revision gate that decides which observations may touch the jar.
 *
 * The gate is the interesting half, so the last describe drives it through the
 * REAL applier rather than asserting the predicate on its own: what the ticket
 * promises is that a frame captured before a host pruned does not reach the
 * cookie jar, and only the applier can be asked that question.
 */

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
}));

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  sanitizeLogFields: (fields: Record<string, unknown>) => fields,
  describeLogError: (error: unknown) => String(error),
}));

const HOST = "host-1";
const OTHER_HOST = "host-2";
const CONNECTION = "connection-1";

let directory = "";

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), "forget-ledger-"));
  releaseBrowserForgetLedgerConnection(CONNECTION);
});

afterEach(async () => {
  releaseBrowserForgetLedgerConnection(CONNECTION);
  await rm(directory, { recursive: true, force: true });
});

function pathIn(name: string): string {
  return join(directory, name);
}

async function loadEmptyLedger(): Promise<void> {
  await initBrowserForgetLedger(pathIn(`${crypto.randomUUID()}.json`));
}

describe("headless-origin cookie custody", () => {
  const sid = { domain: "example.com", name: "sid", path: "/" };

  it("survives a restart, so a host keeps the right to update what it contributed", async () => {
    const file = pathIn("custody.json");
    await initBrowserForgetLedger(file);
    expect(isHeadlessOriginCookieKey(cookieKeyId(sid))).toBe(false);

    await recordHeadlessOriginCookieKeys([sid]);
    await initBrowserForgetLedger(file);

    expect(isHeadlessOriginCookieKey(cookieKeyId(sid))).toBe(true);
  });

  it("hands a key back the moment this machine's own browsing writes it", async () => {
    await loadEmptyLedger();
    await recordHeadlessOriginCookieKeys([sid]);

    await releaseHeadlessOriginCookieKeys([sid]);

    expect(isHeadlessOriginCookieKey(cookieKeyId(sid))).toBe(false);
  });

  it("makes a release durable, so a crash cannot re-read a released key as the host's", async () => {
    // The asymmetry that makes this the one write in the file worth pinning:
    // a lost RECORD costs a host a right, while a lost RELEASE grants one -
    // over a cookie the user's own browsing owns.
    const file = pathIn("release-durability.json");
    await initBrowserForgetLedger(file);
    await recordHeadlessOriginCookieKeys([sid]);

    await releaseHeadlessOriginCookieKeys([sid]);
    await initBrowserForgetLedger(file);

    expect(isHeadlessOriginCookieKey(cookieKeyId(sid))).toBe(false);
  });

  it("drops a site's keys with the site, on a forget and on a forget-all", async () => {
    await loadEmptyLedger();
    const other = { domain: "other.test", name: "sid", path: "/" };
    await recordHeadlessOriginCookieKeys([sid, other]);

    // Registrable-domain scoped, like every other jar path: a forget of
    // `example.com` must take `app.example.com`'s keys with it, and leave a
    // different site alone.
    await recordForgottenBrowserSite("app.example.com");
    expect(isHeadlessOriginCookieKey(cookieKeyId(sid))).toBe(false);
    expect(isHeadlessOriginCookieKey(cookieKeyId(other))).toBe(true);

    await recordForgetAllBrowserLogins();
    expect(isHeadlessOriginCookieKey(cookieKeyId(other))).toBe(false);
  });

  it("reads a ledger file written before the set existed as owning nothing", async () => {
    const file = pathIn("legacy.json");
    await writeFile(
      file,
      JSON.stringify({
        revision: 2,
        clearedThrough: 2,
        forgetAll: null,
        domains: [{ domain: "example.com", forgottenAt: 5, revision: 2 }],
        ackedByHost: [],
      }),
      "utf8",
    );

    await initBrowserForgetLedger(file);

    // The rest of the ledger still parses - the field is a `.default([])`, not
    // a break - and nothing in that jar is known to be host-contributed, which
    // is the honest answer for a file a build without the rule wrote.
    expect(browserForgetLedgerDigestForHost(HOST).revision).toBe(2);
    expect(isHeadlessOriginCookieKey(cookieKeyId(sid))).toBe(false);
  });
});

describe("forget ledger durability", () => {
  it("reads a missing file as an empty ledger at revision 0", async () => {
    await initBrowserForgetLedger(pathIn("absent.json"));

    expect(browserForgetLedgerDigestForHost(HOST)).toEqual({
      forgetAllAt: null,
      domains: [],
      revision: 0,
    });
    // Nothing recorded means nothing refused: a ledger that cannot be read
    // must not be able to stop the user signing in.
    expect(
      isBrowserForgetLedgerPendingAck({
        connectionId: CONNECTION,
        domain: "example.com",
      }),
    ).toBe(false);
  });

  it("reads well-formed JSON of the wrong shape as an empty ledger too", async () => {
    // A different branch from a file that will not parse at all: the store
    // catches a `JSON.parse` throw before the validator is reached, so only
    // readable JSON that fails the schema exercises this one. Loaded after a
    // real ledger so the empty answer is the fallback being applied, not the
    // module's initial value never having moved.
    const real = pathIn("real.json");
    await initBrowserForgetLedger(real);
    await recordForgottenBrowserSite("example.com");
    expect(browserForgetLedgerDigestForHost(HOST).revision).toBe(1);

    const wrongShape = pathIn("wrong-shape.json");
    await writeFile(wrongShape, '{"revision":"seven"}', "utf8");
    await initBrowserForgetLedger(wrongShape);

    expect(browserForgetLedgerDigestForHost(HOST).revision).toBe(0);
  });

  it("survives a restart: the file is what the next launch answers from", async () => {
    const path = pathIn("durable.json");
    await initBrowserForgetLedger(path);
    await recordForgottenBrowserSite("example.com");
    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 1,
    });
    // The ack is persisted through the same chain as the forget, so the read
    // below has to wait for it rather than race it.
    await recordForgottenBrowserSite("other.test");

    await initBrowserForgetLedger(path);

    const digest = browserForgetLedgerDigestForHost(HOST);
    expect(digest.revision).toBe(2);
    // Only what this host has not acked. The point of persisting the ack: a
    // restart that re-asserted `example.com` would re-clear a site the user
    // may have signed back into.
    expect(digest.domains.map((entry) => entry.domain)).toEqual(["other.test"]);
    const stored: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(stored).toMatchObject({ revision: 2 });
  });
});

describe("forget ledger mutations", () => {
  beforeEach(loadEmptyLedger);

  it("bumps a monotonic revision on every forget action", async () => {
    await recordForgottenBrowserSite("example.com");
    expect(browserForgetLedgerDigestForHost(HOST).revision).toBe(1);
    await recordForgottenBrowserSite("other.test");
    expect(browserForgetLedgerDigestForHost(HOST).revision).toBe(2);
    await recordForgetAllBrowserLogins();
    expect(browserForgetLedgerDigestForHost(HOST).revision).toBe(3);
  });

  it("collapses a re-forget of the same site onto one row", async () => {
    await recordForgottenBrowserSite("example.com");
    await recordForgottenBrowserSite("www.example.com");

    const digest = browserForgetLedgerDigestForHost(HOST);
    // Collapsed to the registrable domain, which is the blast radius a clear
    // actually has - two rows would be two clears of the same site.
    expect(digest.domains.map((entry) => entry.domain)).toEqual([
      "example.com",
    ]);
    expect(digest.revision).toBe(2);
  });

  it("drops the per-domain rows on a forget-all, which already covers them", async () => {
    await recordForgottenBrowserSite("example.com");
    await recordForgetAllBrowserLogins();

    const digest = browserForgetLedgerDigestForHost(HOST);
    expect(digest.domains).toEqual([]);
    expect(digest.forgetAllAt).not.toBeNull();
  });

  it("records a site the HOST said was cleared elsewhere", async () => {
    // The evict path. Recording it is what makes this ledger the machine's
    // complete record - a host that hears about the forget only from here
    // still prunes - and what starts refusing in-flight observations for it.
    await recordForgottenBrowserSite("evicted.test");

    expect(
      browserForgetLedgerDigestForHost(HOST).domains.map(
        (entry) => entry.domain,
      ),
    ).toEqual(["evicted.test"]);
  });

  it("notifies once per forget so every host stream can push", async () => {
    const changes: BrowserForgetLedgerChange[] = [];
    const subscription = onBrowserForgetLedgerChanged((change) => {
      changes.push(change);
    });

    await recordForgottenBrowserSite("example.com");
    await recordForgetAllBrowserLogins();
    // An ack changes what a host is OWED, not what any host must be told, so
    // it deliberately does not notify.
    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 2,
    });

    expect(changes).toEqual([{ revision: 1 }, { revision: 2 }]);
    subscription.dispose();
  });
});

describe("forget ledger digests", () => {
  beforeEach(loadEmptyLedger);

  it("sends a host everything until it acks, then only what came after", async () => {
    await recordForgottenBrowserSite("example.com");

    expect(
      browserForgetLedgerDigestForHost(HOST).domains.map(
        (entry) => entry.domain,
      ),
    ).toEqual(["example.com"]);

    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 1,
    });

    // Empty, but still carrying the current revision - that is what a
    // caught-up host's fresh attach acks to reopen its own gate.
    expect(browserForgetLedgerDigestForHost(HOST)).toEqual({
      forgetAllAt: null,
      domains: [],
      revision: 1,
    });

    await recordForgottenBrowserSite("other.test");
    expect(
      browserForgetLedgerDigestForHost(HOST).domains.map(
        (entry) => entry.domain,
      ),
    ).toEqual(["other.test"]);
  });

  it("never re-asserts a forget a host has acked, so a re-login is not re-cleared", async () => {
    // The whole reason the digest is filtered rather than sent whole. The user
    // forgets a site, the host prunes it, the user signs back in, and then
    // clears something else entirely - which must not take the fresh login
    // with it.
    await recordForgottenBrowserSite("example.com");
    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 1,
    });
    await recordForgottenBrowserSite("unrelated.test");

    const digest = browserForgetLedgerDigestForHost(HOST);
    expect(digest.domains.map((entry) => entry.domain)).toEqual([
      "unrelated.test",
    ]);
    expect(digest.forgetAllAt).toBeNull();
  });

  it("tracks each host separately, so one host's ack does not speak for another", async () => {
    await recordForgetAllBrowserLogins();
    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 1,
    });

    expect(browserForgetLedgerDigestForHost(HOST).forgetAllAt).toBeNull();
    // The one that was disconnected still owes the forget-all, which is the
    // offline-host case this ledger exists for.
    expect(
      browserForgetLedgerDigestForHost(OTHER_HOST).forgetAllAt,
    ).not.toBeNull();
  });

  it("only ever advances a host's watermark", async () => {
    await recordForgottenBrowserSite("example.com");
    await recordForgottenBrowserSite("other.test");
    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 2,
    });
    // A replayed or out-of-order ack for an older revision must not re-open
    // what a later one closed.
    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 1,
    });

    expect(browserForgetLedgerDigestForHost(HOST).domains).toEqual([]);
  });
});

describe("forget ledger ack bounds", () => {
  beforeEach(loadEmptyLedger);

  it("clamps an ack to this machine's own revision", async () => {
    // The revision is minted HERE and merely echoed by the host, so an ack
    // above the current one is meaningless by construction. Taken at face
    // value it is a permanent poison: recorded as "pruned through here" for a
    // ledger that does not exist yet, it makes every future entry compare
    // below the watermark - the gate never refuses again and every future
    // digest to that host is empty.
    await recordForgottenBrowserSite("example.com");
    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: Number.MAX_SAFE_INTEGER,
    });

    // Clamped to 1, so it counts as having pruned what it was actually told.
    expect(
      isBrowserForgetLedgerPendingAck({
        connectionId: CONNECTION,
        domain: "example.com",
      }),
    ).toBe(false);

    // And the poison did not stick: the NEXT forget is refused again, and is
    // still owed to that host.
    await recordForgottenBrowserSite("other.test");
    expect(
      isBrowserForgetLedgerPendingAck({
        connectionId: CONNECTION,
        domain: "other.test",
      }),
    ).toBe(true);
    expect(
      browserForgetLedgerDigestForHost(HOST).domains.map(
        (entry) => entry.domain,
      ),
    ).toEqual(["other.test"]);
  });
});

describe("forget ledger clear reconciliation", () => {
  beforeEach(loadEmptyLedger);

  it("reports a recorded forget whose jar clear never completed", async () => {
    // The ledger is written BEFORE the jar is touched - that is what refuses
    // an in-flight observation - so a crash in between leaves the ledger
    // claiming a login is gone while the jar still serves it. The jar is the
    // master, so the next whole-jar capture would teach every host the login
    // back.
    await recordForgottenBrowserSite("example.com");

    expect(browserForgetLedgerPendingClears()).toEqual({
      forgetAll: false,
      domains: ["example.com"],
      revision: 1,
    });

    await markBrowserForgetLedgerCleared(1);
    expect(browserForgetLedgerPendingClears().domains).toEqual([]);
  });

  it("does not step over an older clear that failed", async () => {
    // Two clears of different sites run in parallel through the jar
    // serializer and can finish out of order. A high-water mark would record
    // the newer one and hide the older - the exact gap this closes.
    await recordForgottenBrowserSite("first.test");
    await recordForgottenBrowserSite("second.test");
    await markBrowserForgetLedgerCleared(2);

    // The watermark does not advance across the gap, so the site whose clear
    // failed is still pending - and the one that succeeded is re-run with it,
    // which is free: emptying a site twice is emptying it. Recording 2 alone
    // is what would lose `first.test` for good.
    expect(browserForgetLedgerPendingClears().domains).toEqual([
      "first.test",
      "second.test",
    ]);

    await markBrowserForgetLedgerCleared(1);
    expect(browserForgetLedgerPendingClears().domains).toEqual([]);
  });

  it("does not re-run a completed forget-all because a later clear-site failed", async () => {
    await recordForgetAllBrowserLogins();
    await markBrowserForgetLedgerCleared(1);
    await recordForgottenBrowserSite("example.com");

    const pending = browserForgetLedgerPendingClears();
    // Emptying the whole jar again because one site clear crashed would sign
    // the user out of everything they signed back into since.
    expect(pending.forgetAll).toBe(false);
    expect(pending.domains).toEqual(["example.com"]);
  });

  it("survives a restart with the pending set intact", async () => {
    const path = pathIn("pending.json");
    await initBrowserForgetLedger(path);
    await recordForgottenBrowserSite("crashed.test");

    await initBrowserForgetLedger(path);

    expect(browserForgetLedgerPendingClears().domains).toEqual([
      "crashed.test",
    ]);
  });
});

describe("forget ledger acked-revision gate", () => {
  beforeEach(loadEmptyLedger);

  it("refuses a forgotten site until this connection acks the covering revision", async () => {
    await recordForgottenBrowserSite("example.com");
    const gate = { connectionId: CONNECTION, domain: "example.com" };

    expect(isBrowserForgetLedgerPendingAck(gate)).toBe(true);
    // An ack BELOW the covering revision is not the one: it says the host
    // pruned an earlier ledger, which never named this site.
    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 0,
    });
    expect(isBrowserForgetLedgerPendingAck(gate)).toBe(true);

    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 1,
    });
    expect(isBrowserForgetLedgerPendingAck(gate)).toBe(false);
  });

  it("refuses every site while a forget-all is unacked, and none the ledger never named", async () => {
    await recordForgetAllBrowserLogins();

    expect(
      isBrowserForgetLedgerPendingAck({
        connectionId: CONNECTION,
        domain: "never-forgotten.test",
      }),
    ).toBe(true);

    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 1,
    });
    expect(
      isBrowserForgetLedgerPendingAck({
        connectionId: CONNECTION,
        domain: "never-forgotten.test",
      }),
    ).toBe(false);
  });

  it("refuses a subdomain of a forgotten site", async () => {
    await recordForgottenBrowserSite("example.com");

    expect(
      isBrowserForgetLedgerPendingAck({
        connectionId: CONNECTION,
        domain: "app.example.com",
      }),
    ).toBe(true);
  });

  it("makes a reconnect re-earn the gate, whatever the host acked before", async () => {
    await recordForgottenBrowserSite("example.com");
    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 1,
    });
    releaseBrowserForgetLedgerConnection(CONNECTION);

    // Same host, new stream incarnation. The durable watermark says the host
    // is caught up, but this connection has established no happens-before, so
    // it is refused until its attach digest is acked.
    expect(
      isBrowserForgetLedgerPendingAck({
        connectionId: "connection-2",
        domain: "example.com",
      }),
    ).toBe(true);
  });
});

/**
 * The in-flight scenario the ticket names, end to end through the real applier:
 * a host captures a sign-in, the user clears that site locally while the frame
 * is travelling, and the frame arrives after the clear finished.
 *
 * Nothing in the frame says when it was captured, and no timer can tell -
 * which is why the ack, not a window, is what decides.
 */
describe("in-flight observation across a local clear", () => {
  it("drops the frame on an unacked revision, and applies the SAME frame once the ack lands", async () => {
    await loadEmptyLedger();
    const jar = new FakeJar();
    const serializer = new BrowserJarSerializer();
    const governor = new BrowserObservedConnectionGovernor(() => Date.now());
    const observed = {
      connectionId: CONNECTION,
      hostId: HOST,
      domain: "example.com",
      cookies: [
        {
          name: "sid",
          value: "sid-value",
          domain: "example.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: "Lax",
          partitionKey: null,
        } satisfies BrowserStorageCookie,
      ],
    };
    const apply = (): Promise<{ readonly outcome: string }> =>
      applyBrowserObservedProfile(observed, {
        now: () => Date.now(),
        isForgottenPendingAck: isBrowserForgetLedgerPendingAck,
        isHeadlessOriginKey: isHeadlessOriginCookieKey,
        claimHeadlessOriginKeys: recordHeadlessOriginCookieKeys,
        releaseHeadlessOriginKeys: releaseHeadlessOriginCookieKeys,
        getTargetJar: () => ({ session: { cookies: jar }, durableJar: true }),
        serializeOnDomain: (domain, action) =>
          serializer.runOnDomain(domain, action),
        governor,
      });

    // The user clears the site. The frame was captured before this, but it is
    // delivered after - the case a suppression window cannot see.
    await recordForgottenBrowserSite("example.com");

    const refused = await apply();
    expect(refused.outcome).toBe("ledger-unacked");
    expect(jar.names()).toEqual([]);

    // The host prunes and says so. Everything it emits after this point was
    // captured after the prune, so the very same frame is now a legitimate
    // sign-in rather than a resurrection.
    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 1,
    });

    const applied = await apply();
    expect(applied.outcome).toBe("applied");
    expect(jar.names()).toEqual(["sid"]);
  });
});

/** The narrowest jar the applier needs: set, get, flush. */
class FakeJar {
  private readonly jar: Cookie[] = [];

  set(details: CookiesSetDetails): Promise<void> {
    this.jar.push({
      name: details.name ?? "",
      value: details.value ?? "",
      domain: details.domain ?? new URL(details.url).hostname,
      hostOnly: details.domain === undefined,
      path: details.path ?? "/",
      secure: details.secure === true,
      httpOnly: details.httpOnly === true,
      session: details.expirationDate === undefined,
      sameSite: details.sameSite ?? "no_restriction",
      expirationDate: details.expirationDate,
    });
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
    return Promise.resolve();
  }

  names(): readonly string[] {
    return this.jar.map((cookie) => cookie.name).sort();
  }
}
