import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cookie, CookiesSetDetails } from "electron";
import {
  BROWSER_FORGET_LEDGER_MAX_DOMAINS,
  type BrowserStorageCookie,
} from "@traycer/protocol/host/browser/contracts";
import {
  bracketUnclearedForgets,
  browserForgetLedgerDigestForHost,
  browserForgetLedgerPendingClears,
  browserForgetLedgerUnclearedForgets,
  deferBrowserForgetLedgerNotifications,
  initBrowserForgetLedger,
  markBrowserForgetLedgerCleared,
  markBrowserForgetLedgerClearedMany,
  isBrowserForgetLedgerPendingAck,
  isHeadlessOriginCookieKey,
  releaseHeadlessOriginCookieKeys,
  onBrowserForgetLedgerChanged,
  recordForgetAllBrowserLogins,
  recordForgetLedgerAck,
  recordForgottenBrowserSite,
  recordForgottenBrowserSites,
  recordHeadlessOriginCookieKeys,
  releaseBrowserForgetLedgerConnection,
  unionUnclearedForgets,
  withoutUnclearedForgets,
} from "../browser-forget-ledger";
import { applyBrowserObservedProfile } from "../browser-observed-profile";
import { BrowserObservedConnectionGovernor } from "../browser-observed-profile";
import { BrowserJarSerializer } from "../browser-jar-serializer";
import {
  cookieKeyId,
  type BrowserPrimaryProfileCaptureResult,
} from "../browser-storage-state";
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
      sentRevision: 1,
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

describe("forget ledger loaded-domain normalization", () => {
  it("normalizes a loaded row to its registrable domain", async () => {
    const file = pathIn("normalize-single.json");
    await writeFile(
      file,
      JSON.stringify({
        revision: 1,
        clearedThrough: 0,
        forgetAll: null,
        domains: [{ domain: "login.example.com", forgottenAt: 5, revision: 1 }],
        ackedByHost: [],
        headlessOriginKeys: [],
      }),
      "utf8",
    );

    await initBrowserForgetLedger(file);

    expect(
      browserForgetLedgerDigestForHost(HOST).domains.map(
        (entry) => entry.domain,
      ),
    ).toEqual(["example.com"]);
  });

  it("keeps the higher-revision row when two loaded rows collapse to the same scope", async () => {
    const file = pathIn("normalize-collapse.json");
    await writeFile(
      file,
      JSON.stringify({
        revision: 3,
        clearedThrough: 0,
        forgetAll: null,
        domains: [
          { domain: "login.example.com", forgottenAt: 5, revision: 1 },
          { domain: "app.example.com", forgottenAt: 9, revision: 3 },
        ],
        ackedByHost: [],
        headlessOriginKeys: [],
      }),
      "utf8",
    );

    await initBrowserForgetLedger(file);

    // One row survives under the shared scope, carrying the newer row's
    // data - the same collapse a re-forget performs on the write path.
    expect(browserForgetLedgerDigestForHost(HOST).domains).toEqual([
      { domain: "example.com", forgottenAt: 9 },
    ]);
  });

  it("drops a loaded row whose domain collapses to nothing", async () => {
    const file = pathIn("normalize-drop.json");
    await writeFile(
      file,
      JSON.stringify({
        revision: 1,
        clearedThrough: 0,
        forgetAll: null,
        domains: [{ domain: "not a domain", forgottenAt: 5, revision: 1 }],
        ackedByHost: [],
        headlessOriginKeys: [],
      }),
      "utf8",
    );

    await initBrowserForgetLedger(file);

    // A row nothing can match would be a forget that never fires - the same
    // rule the write path applies, applied here to a row a build that
    // predates it could still have written.
    expect(browserForgetLedgerDigestForHost(HOST).domains).toEqual([]);
  });

  it("makes a normalized loaded domain match a capture's uncleared-forget filter", async () => {
    const file = pathIn("normalize-uncleared.json");
    await writeFile(
      file,
      JSON.stringify({
        revision: 1,
        clearedThrough: 0,
        forgetAll: null,
        domains: [{ domain: "login.example.com", forgottenAt: 5, revision: 1 }],
        ackedByHost: [],
        headlessOriginKeys: [],
      }),
      "utf8",
    );

    await initBrowserForgetLedger(file);

    const uncleared = browserForgetLedgerUnclearedForgets();
    expect(uncleared.domains.has("example.com")).toBe(true);

    const cookie: BrowserStorageCookie = {
      name: "sid",
      value: "v",
      domain: "login.example.com",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
      partitionKey: null,
    };
    const result: BrowserPrimaryProfileCaptureResult = {
      status: "captured",
      storageState: { cookies: [cookie], origins: [] },
      reason: null,
    };

    const filtered = withoutUnclearedForgets(result, uncleared);
    if (filtered.status !== "captured") {
      throw new Error("expected a captured result");
    }
    // The normalized scope is what the filter matches against, so the
    // login's own cookie - still spelled under the subdomain - is caught.
    expect(filtered.storageState.cookies).toEqual([]);
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
    // Each stream now reads its own digest off a bare edge, so the pin is a
    // call count, not a payload.
    let notifications = 0;
    const subscription = onBrowserForgetLedgerChanged(() => {
      notifications += 1;
    });

    await recordForgottenBrowserSite("example.com");
    await recordForgetAllBrowserLogins();
    // An ack changes what a host is OWED, not what any host must be told, so
    // it deliberately does not notify.
    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 2,
      sentRevision: 2,
    });

    expect(notifications).toBe(2);
    subscription.dispose();
  });
});

describe("forget ledger batch forgets", () => {
  beforeEach(loadEmptyLedger);

  it("records several sites under one revision", async () => {
    const sid = { domain: "example.com", name: "sid", path: "/" };
    const other = { domain: "other.test", name: "sid", path: "/" };
    await recordHeadlessOriginCookieKeys([sid, other]);
    const previous = browserForgetLedgerDigestForHost(HOST).revision;

    const revision = await recordForgottenBrowserSites([
      "a.example.com",
      "www.b.example.org",
      "b.example.org",
      "not a domain",
    ]);

    // One revision for the whole batch, not one per site.
    expect(revision).toBe(previous + 1);
    const digest = browserForgetLedgerDigestForHost(HOST);
    expect(digest.revision).toBe(revision);
    expect([...digest.domains.map((entry) => entry.domain)].sort()).toEqual([
      "example.com",
      "example.org",
    ]);
    // The custody marks under the forgotten scopes go with them.
    expect(isHeadlessOriginCookieKey(cookieKeyId(sid))).toBe(false);
    expect(isHeadlessOriginCookieKey(cookieKeyId(other))).toBe(true);
    expect(
      isBrowserForgetLedgerPendingAck({
        connectionId: CONNECTION,
        domain: "sub.example.org",
      }),
    ).toBe(true);
  });

  it("answers the current revision for a list with no derivable domain", async () => {
    const previous = browserForgetLedgerDigestForHost(HOST).revision;

    const revision = await recordForgottenBrowserSites(["not a domain"]);

    // Nothing was left to record, so nothing was recorded: the ledger's own
    // revision is unchanged, and the caller is told `null` rather than a
    // revision it could go on to mark as cleared - one that would actually
    // belong to whatever the ledger's top happens to be.
    expect(revision).toBeNull();
    const digest = browserForgetLedgerDigestForHost(HOST);
    expect(digest.revision).toBe(previous);
    expect(digest.domains).toEqual([]);
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
      sentRevision: 1,
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
      sentRevision: 1,
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
      sentRevision: 1,
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
      sentRevision: 2,
    });
    // A replayed or out-of-order ack for an older revision must not re-open
    // what a later one closed.
    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 1,
      sentRevision: 1,
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
      sentRevision: 1,
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

  it("declines an ack no digest earned, on both watermarks", async () => {
    // The frame is unsolicited: nothing in it names a digest, so a host can
    // send one the instant the stream opens. Before ticket 09 that one frame
    // opened this connection's gate for good AND recorded the host as caught
    // up, which emptied every digest it would ever be sent.
    await recordForgottenBrowserSite("example.com");

    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 1,
      // Nothing has been pushed on this connection yet.
      sentRevision: 0,
    });

    // The in-memory gate still refuses the site.
    expect(
      isBrowserForgetLedgerPendingAck({
        connectionId: CONNECTION,
        domain: "example.com",
      }),
    ).toBe(true);
    // And the durable watermark did not move: the host is still owed the
    // forget it claimed to have pruned.
    expect(
      browserForgetLedgerDigestForHost(HOST).domains.map(
        (entry) => entry.domain,
      ),
    ).toEqual(["example.com"]);
  });

  it("clamps an ack to what this connection was actually sent", async () => {
    // Two forgets, one digest. The host acks past what it was told, which is
    // the same overreach as the ledger-top clamp but one the ledger's own top
    // cannot catch - revision 2 exists here, it just never reached this
    // connection.
    await recordForgottenBrowserSite("first.test");
    await recordForgottenBrowserSite("second.test");

    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 2,
      sentRevision: 1,
    });

    // Worth exactly the digest that earned it: the site named at revision 1
    // is through, the one at revision 2 is not.
    expect(
      isBrowserForgetLedgerPendingAck({
        connectionId: CONNECTION,
        domain: "first.test",
      }),
    ).toBe(false);
    expect(
      isBrowserForgetLedgerPendingAck({
        connectionId: CONNECTION,
        domain: "second.test",
      }),
    ).toBe(true);
    expect(
      browserForgetLedgerDigestForHost(HOST).domains.map(
        (entry) => entry.domain,
      ),
    ).toEqual(["second.test"]);

    // The digest that does cover it is sent, and the same ack now lands in
    // full - on the gate and on the durable watermark together.
    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 2,
      sentRevision: 2,
    });

    expect(
      isBrowserForgetLedgerPendingAck({
        connectionId: CONNECTION,
        domain: "second.test",
      }),
    ).toBe(false);
    expect(browserForgetLedgerDigestForHost(HOST)).toEqual({
      forgetAllAt: null,
      domains: [],
      revision: 2,
    });
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
      forgetAll: null,
      domains: [{ domain: "example.com", revision: 1 }],
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
      { domain: "first.test", revision: 1 },
      { domain: "second.test", revision: 2 },
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
    expect(pending.forgetAll).toBeNull();
    expect(pending.domains).toEqual([{ domain: "example.com", revision: 2 }]);
  });

  it("survives a restart with the pending set intact", async () => {
    const path = pathIn("pending.json");
    await initBrowserForgetLedger(path);
    await recordForgottenBrowserSite("crashed.test");

    await initBrowserForgetLedger(path);

    expect(browserForgetLedgerPendingClears().domains).toEqual([
      { domain: "crashed.test", revision: 1 },
    ]);
  });

  it("reports each pending domain with its own revision, and drains each on its own mark", async () => {
    // RULE: browserForgetLedgerPendingClears carries the ENTRY's revision,
    // not the ledger's top - marking one entry's revision must drain only
    // that entry, leaving a later one still pending.
    await recordForgottenBrowserSite("first.test");
    await recordForgottenBrowserSite("second.test");

    expect(browserForgetLedgerPendingClears().domains).toEqual([
      { domain: "first.test", revision: 1 },
      { domain: "second.test", revision: 2 },
    ]);

    await markBrowserForgetLedgerCleared(1);
    expect(browserForgetLedgerPendingClears().domains).toEqual([
      { domain: "second.test", revision: 2 },
    ]);

    await markBrowserForgetLedgerCleared(2);
    expect(browserForgetLedgerPendingClears().domains).toEqual([]);
  });

  it("drains past a revision whose row a re-forget of the same site replaced", async () => {
    // RULE: the contiguous watermark must step over a revision the ledger no
    // longer represents. Forgetting the same site twice before the first jar
    // clear finishes replaces revision 1's row with revision 2's, so nothing
    // can ever complete revision 1 - and a watermark that waits for it leaves
    // the surviving row pending at every launch, re-clearing the site and
    // deleting whatever login the user created in between.
    await recordForgottenBrowserSite("example.com");
    await recordForgottenBrowserSite("example.com");

    expect(browserForgetLedgerPendingClears().domains).toEqual([
      { domain: "example.com", revision: 2 },
    ]);

    await markBrowserForgetLedgerCleared(2);
    expect(browserForgetLedgerPendingClears().domains).toEqual([]);

    // And a LATER forget still drains on its own mark, rather than inheriting
    // the hole the replaced row left behind.
    await recordForgottenBrowserSite("other.test");
    expect(browserForgetLedgerPendingClears().domains).toEqual([
      { domain: "other.test", revision: 3 },
    ]);
    await markBrowserForgetLedgerCleared(3);
    expect(browserForgetLedgerPendingClears().domains).toEqual([]);
  });

  it("V-1: carries clearedThrough across the gap a forget-all's own deletes create", async () => {
    // RULE: recordForgetAllBrowserLogins must set clearedThrough to
    // revision - 1, not leave it below a gap made by rows it just deleted -
    // otherwise the CONTIGUOUS drain in markBrowserForgetLedgerCleared can
    // never advance past that gap, and browserForgetLedgerPendingClears
    // reports the forget-all as pending forever, even after it is marked
    // cleared.
    const path = pathIn("wedge.json");
    await initBrowserForgetLedger(path);

    // A clear-site is recorded (revision 1) but its local jar clear is never
    // marked - this models a crash between the ledger write and the clear
    // finishing.
    await recordForgottenBrowserSite("a.example");

    // The forget-all (revision 2) deletes the per-domain row above, so if
    // clearedThrough were left at 0 (below the gap at revision 1), nothing
    // could ever close it: revision 1's row is gone and can never be marked.
    const forgetAllRevision = await recordForgetAllBrowserLogins();
    expect(forgetAllRevision).toBe(2);

    await markBrowserForgetLedgerCleared(forgetAllRevision);

    expect(browserForgetLedgerPendingClears()).toEqual({
      forgetAll: null,
      domains: [],
    });

    // Durable, not just in-memory: a reload must still report nothing
    // pending - the wedge, if it existed, would resurface as a permanent
    // forget-all replay on every boot.
    await initBrowserForgetLedger(path);
    expect(browserForgetLedgerPendingClears()).toEqual({
      forgetAll: null,
      domains: [],
    });
  });

  it("R3-11: drains a SPARSE ledger without walking the gap to its top revision", async () => {
    // RULE: the watermark is derived from the rows the ledger holds, never
    // scanned one revision at a time toward `ledger.revision`. The gap
    // between them is unbounded - the revision counter outlives the rows,
    // and a restored file can name any number at all - and a per-revision
    // scan runs that many iterations on the Electron MAIN thread, freezing
    // the whole app on an operation whose real work is one row.
    const path = pathIn("sparse.json");
    await writeFile(
      path,
      JSON.stringify({
        revision: 1_000_000_000_000_000,
        clearedThrough: 0,
        forgetAll: null,
        domains: [{ domain: "example.com", forgottenAt: 5, revision: 1 }],
        ackedByHost: [],
      }),
      "utf8",
    );
    await initBrowserForgetLedger(path);

    expect(browserForgetLedgerPendingClears().domains).toEqual([
      { domain: "example.com", revision: 1 },
    ]);

    await markBrowserForgetLedgerCleared(1);

    // Nothing is represented above revision 1, so the watermark lands on the
    // ledger's own top - reached, not walked to.
    expect(browserForgetLedgerPendingClears()).toEqual({
      forgetAll: null,
      domains: [],
    });
    const persisted: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(persisted).toMatchObject({ clearedThrough: 1_000_000_000_000_000 });
  }, 5_000);
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
      sentRevision: 1,
    });
    expect(isBrowserForgetLedgerPendingAck(gate)).toBe(true);

    await recordForgetLedgerAck({
      hostId: HOST,
      connectionId: CONNECTION,
      revision: 1,
      sentRevision: 1,
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
      sentRevision: 1,
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
      sentRevision: 1,
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

describe("forget ledger notification deferral", () => {
  beforeEach(loadEmptyLedger);

  it("holds the digest edge open across several deferred records, then fires once", async () => {
    let notifications = 0;
    const subscription = onBrowserForgetLedgerChanged(() => {
      notifications += 1;
    });

    const scope = deferBrowserForgetLedgerNotifications();
    await recordForgottenBrowserSites(["first.test"]);
    await recordForgottenBrowserSites(["second.test"]);
    await recordForgottenBrowserSites(["third.test"]);
    // Each record lands in memory and bumps the revision, but the "tell every
    // stream" edge is held until the scope ends.
    expect(notifications).toBe(0);
    expect(browserForgetLedgerDigestForHost(HOST).revision).toBe(3);

    scope.end();

    expect(notifications).toBe(1);
    subscription.dispose();
  });

  it("persists every deferred record though only the notification is held", async () => {
    const file = pathIn("deferred-persist.json");
    await initBrowserForgetLedger(file);

    const scope = deferBrowserForgetLedgerNotifications();
    await recordForgottenBrowserSites(["first.test"]);
    await recordForgottenBrowserSites(["second.test"]);
    await recordForgottenBrowserSites(["third.test"]);
    scope.end();

    const persisted: unknown = JSON.parse(await readFile(file, "utf8"));
    expect(persisted).toMatchObject({
      revision: 3,
      domains: expect.arrayContaining([
        expect.objectContaining({ domain: "first.test" }),
        expect.objectContaining({ domain: "second.test" }),
        expect.objectContaining({ domain: "third.test" }),
      ]),
    });
  });

  it("closes idempotently: a second end() call notifies no further", async () => {
    let notifications = 0;
    const subscription = onBrowserForgetLedgerChanged(() => {
      notifications += 1;
    });

    const scope = deferBrowserForgetLedgerNotifications();
    await recordForgottenBrowserSites(["only.test"]);
    scope.end();
    scope.end();

    expect(notifications).toBe(1);
    subscription.dispose();
  });

  it("only releases on the outermost end(), leaving an inner end() a no-op", async () => {
    let notifications = 0;
    const subscription = onBrowserForgetLedgerChanged(() => {
      notifications += 1;
    });

    const outer = deferBrowserForgetLedgerNotifications();
    const inner = deferBrowserForgetLedgerNotifications();
    await recordForgottenBrowserSites(["nested.test"]);

    inner.end();
    expect(notifications).toBe(0);

    outer.end();
    expect(notifications).toBe(1);
    subscription.dispose();
  });

  it("notifies immediately when no scope is open, as the control", async () => {
    let notifications = 0;
    const subscription = onBrowserForgetLedgerChanged(() => {
      notifications += 1;
    });

    await recordForgottenBrowserSites(["immediate.test"]);

    expect(notifications).toBe(1);
    subscription.dispose();
  });
});

describe("forget ledger clear reconciliation, several revisions at once", () => {
  beforeEach(loadEmptyLedger);

  it("advances the watermark to the newest of several revisions marked together", async () => {
    await recordForgottenBrowserSite("first.test");
    await recordForgottenBrowserSite("second.test");
    await recordForgottenBrowserSite("third.test");

    await markBrowserForgetLedgerClearedMany([1, 2, 3]);

    expect(browserForgetLedgerPendingClears()).toEqual({
      forgetAll: null,
      domains: [],
    });
  });

  it("ignores a revision already cleared or above the ledger's top, without throwing", async () => {
    await recordForgottenBrowserSite("example.com");
    await markBrowserForgetLedgerCleared(1);

    await expect(
      markBrowserForgetLedgerClearedMany([1, 999]),
    ).resolves.toBeUndefined();

    expect(browserForgetLedgerPendingClears()).toEqual({
      forgetAll: null,
      domains: [],
    });
  });

  it("holds the watermark back on an out-of-order older pending revision, the same contiguity rule the single-clear function enforces", async () => {
    await recordForgottenBrowserSite("first.test");
    await recordForgottenBrowserSite("second.test");
    await recordForgottenBrowserSite("third.test");

    // Only the newer two are marked; the oldest (revision 1) is still
    // pending, so the watermark must not step past it.
    await markBrowserForgetLedgerClearedMany([2, 3]);

    expect(browserForgetLedgerPendingClears().domains).toEqual([
      { domain: "first.test", revision: 1 },
      { domain: "second.test", revision: 2 },
      { domain: "third.test", revision: 3 },
    ]);

    await markBrowserForgetLedgerClearedMany([1]);
    expect(browserForgetLedgerPendingClears().domains).toEqual([]);
  });
});

describe("forget ledger uncleared forgets", () => {
  beforeEach(loadEmptyLedger);

  it("reports a domain uncleared once forgotten, and clear once its jar clear is marked", async () => {
    expect(
      browserForgetLedgerUnclearedForgets().domains.has("example.com"),
    ).toBe(false);

    const revision = await recordForgottenBrowserSite("example.com");
    expect(
      browserForgetLedgerUnclearedForgets().domains.has("example.com"),
    ).toBe(true);

    await markBrowserForgetLedgerCleared(revision);
    expect(
      browserForgetLedgerUnclearedForgets().domains.has("example.com"),
    ).toBe(false);
  });

  it("tells a completed out-of-order clear apart from the CONTIGUOUS watermark pendingClears reads", async () => {
    // Two sites, two revisions. Only the newer one's clear finishes - the
    // older one's is still queued behind it, the same race the jar
    // serializer allows between two different domains.
    await recordForgottenBrowserSite("a.test");
    const revisionB = await recordForgottenBrowserSite("b.test");

    await markBrowserForgetLedgerCleared(revisionB);

    // The in-memory completion set already knows B's clear finished, even
    // though the CONTIGUOUS watermark cannot step past A yet - this is
    // exactly what distinguishes this function from the durable,
    // boot-time-only read below.
    const uncleared = browserForgetLedgerUnclearedForgets();
    expect(uncleared.domains.has("b.test")).toBe(false);
    expect(uncleared.domains.has("a.test")).toBe(true);

    // `browserForgetLedgerPendingClears` has no memory of the completion -
    // it still lists B as pending, because `clearedThrough` itself never
    // moved past the gap A left open (it stayed at 0).
    expect(
      browserForgetLedgerPendingClears().domains.map((entry) => entry.domain),
    ).toEqual(["a.test", "b.test"]);
  });

  it("reports forgetAll true once recorded, false once its clear is marked", async () => {
    expect(browserForgetLedgerUnclearedForgets().forgetAll).toBe(false);

    const revision = await recordForgetAllBrowserLogins();
    expect(browserForgetLedgerUnclearedForgets().forgetAll).toBe(true);

    await markBrowserForgetLedgerCleared(revision);
    expect(browserForgetLedgerUnclearedForgets().forgetAll).toBe(false);
  });
});

describe("unionUnclearedForgets", () => {
  it("ORs forgetAll and unions the two domain sets", () => {
    const a = {
      forgetAll: false,
      domains: new Set(["a.test", "shared.test"]),
    };
    const b = {
      forgetAll: true,
      domains: new Set(["b.test", "shared.test"]),
    };

    expect(unionUnclearedForgets(a, b)).toEqual({
      forgetAll: true,
      domains: new Set(["a.test", "shared.test", "b.test"]),
    });
    // Order must not matter - the mask is symmetric in its two operands.
    expect(unionUnclearedForgets(b, a)).toEqual({
      forgetAll: true,
      domains: new Set(["a.test", "shared.test", "b.test"]),
    });
  });

  it("stays false and empty when neither side has anything", () => {
    const empty = { forgetAll: false, domains: new Set<string>() };

    expect(unionUnclearedForgets(empty, empty)).toEqual(empty);
  });
});

describe("bracketUnclearedForgets", () => {
  beforeEach(loadEmptyLedger);

  it("keeps a site recorded and cleared while the bracket is open in close().domains, though the plain answer no longer lists it", async () => {
    const bracket = bracketUnclearedForgets();
    const revision = await recordForgottenBrowserSite("example.com");
    await markBrowserForgetLedgerCleared(revision);

    expect(
      browserForgetLedgerUnclearedForgets().domains.has("example.com"),
    ).toBe(false);
    expect(bracket.close().domains.has("example.com")).toBe(true);
  });

  it("excludes a site recorded and cleared before the bracket opened", async () => {
    const revision = await recordForgottenBrowserSite("before.test");
    await markBrowserForgetLedgerCleared(revision);

    const bracket = bracketUnclearedForgets();

    expect(bracket.close().domains.has("before.test")).toBe(false);
  });

  it("keeps a forget-all recorded while the bracket is open in close().forgetAll, even once its clear is marked", async () => {
    const bracket = bracketUnclearedForgets();
    const revision = await recordForgetAllBrowserLogins();
    await markBrowserForgetLedgerCleared(revision);

    expect(browserForgetLedgerUnclearedForgets().forgetAll).toBe(false);
    expect(bracket.close().forgetAll).toBe(true);
  });

  // CodeRabbit regression: the ledger's own domains list is bounded to
  // BROWSER_FORGET_LEDGER_MAX_DOMAINS for the wire, but the bracket's
  // accumulator is not - it exists precisely so a burst of forgets during a
  // read cannot lose one to that bound. Recorded one at a time, the shape a
  // real caller (a login import) actually forgets in.
  it("holds every site recorded while open past the ledger's own MAX_DOMAINS bound, is idempotent, and stops accumulating once closed", async () => {
    const bracket = bracketUnclearedForgets();
    const total = BROWSER_FORGET_LEDGER_MAX_DOMAINS + 5;
    const domains: string[] = [];
    const revisions: number[] = [];
    for (let i = 0; i < total; i += 1) {
      const domain = `site-${i}.example`;
      domains.push(domain);
      revisions.push(await recordForgottenBrowserSite(domain));
    }
    await markBrowserForgetLedgerClearedMany(revisions);

    // The ledger's own rows stay bounded...
    expect(
      browserForgetLedgerDigestForHost("some-host").domains.length,
    ).toBeLessThanOrEqual(BROWSER_FORGET_LEDGER_MAX_DOMAINS);

    const closed = bracket.close();
    // ...but the bracket saw every one of them, including the first five the
    // ledger's own bound already dropped.
    for (const domain of domains) {
      expect(closed.domains.has(domain)).toBe(true);
    }
    expect(closed.domains.size).toBe(total);

    // Idempotent: a second close() answers the SAME object.
    expect(bracket.close()).toBe(closed);

    // A closed bracket no longer accumulates: a record made afterwards is
    // not folded into a later close() answer.
    const afterRevision = await recordForgottenBrowserSite("after-close.test");
    await markBrowserForgetLedgerCleared(afterRevision);
    expect(bracket.close().domains.has("after-close.test")).toBe(false);
  }, 20_000);
});

describe("withoutUnclearedForgets", () => {
  function cookie(domain: string): BrowserStorageCookie {
    return {
      name: "sid",
      value: "v",
      domain,
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
      partitionKey: null,
    };
  }

  it("drops a dotted or subdomain cookie and origin under a forgotten domain, keeping the rest", () => {
    const result: BrowserPrimaryProfileCaptureResult = {
      status: "captured",
      storageState: {
        cookies: [
          cookie(".example.com"),
          cookie("app.example.com"),
          cookie("kept.test"),
        ],
        origins: [
          { origin: "https://app.example.com", localStorage: [] },
          { origin: "https://kept.test", localStorage: [] },
        ],
      },
      reason: null,
    };

    const filtered = withoutUnclearedForgets(result, {
      forgetAll: false,
      domains: new Set(["example.com"]),
    });

    if (filtered.status !== "captured") {
      throw new Error("expected a captured result");
    }
    expect(filtered.storageState.cookies.map((entry) => entry.domain)).toEqual([
      "kept.test",
    ]);
    expect(filtered.storageState.origins.map((entry) => entry.origin)).toEqual([
      "https://kept.test",
    ]);
  });

  it("empties a captured result under an uncleared forget-all", () => {
    const result: BrowserPrimaryProfileCaptureResult = {
      status: "captured",
      storageState: {
        cookies: [cookie("example.com")],
        origins: [{ origin: "https://example.com", localStorage: [] }],
      },
      reason: null,
    };

    const filtered = withoutUnclearedForgets(result, {
      forgetAll: true,
      domains: new Set(),
    });

    expect(filtered).toEqual({
      status: "captured",
      storageState: { cookies: [], origins: [] },
      reason: null,
    });
  });

  it("passes an unavailable result through untouched", () => {
    const result: BrowserPrimaryProfileCaptureResult = {
      status: "unavailable",
      storageState: null,
      reason: "no-window",
    };

    const filtered = withoutUnclearedForgets(result, {
      forgetAll: true,
      domains: new Set(["example.com"]),
    });

    expect(filtered).toBe(result);
  });

  it("returns the SAME object when nothing is uncleared", () => {
    const result: BrowserPrimaryProfileCaptureResult = {
      status: "captured",
      storageState: { cookies: [cookie("example.com")], origins: [] },
      reason: null,
    };

    const filtered = withoutUnclearedForgets(result, {
      forgetAll: false,
      domains: new Set(),
    });

    expect(filtered).toBe(result);
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
      source: "observed" as const,
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
      sentRevision: 1,
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
