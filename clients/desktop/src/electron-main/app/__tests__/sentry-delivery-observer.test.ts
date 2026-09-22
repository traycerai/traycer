import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { EventEnvelope, TransportMakeRequestResponse } from "@sentry/core";
import {
  createSentryRateLimitWindow,
  sentryOfflineQueuePath,
  wasEventQueuedOffline,
} from "../sentry-delivery-observer";

/**
 * The headers shape `TransportMakeRequestResponse` actually declares: an
 * index signature PLUS both named keys, REQUIRED and `string | null`
 * (`@sentry/core@10.70.0` `types/transport.d.ts`). A looser
 * `Record<string, string | null>` does not satisfy it, and a literal naming
 * only one of the two is a type error rather than a partial header set.
 *
 * So every fake response here is built through {@link responseHeaders}, which
 * always carries both. That is also what the transport really hands the
 * observer - Sentry's own response normalization fills both keys, `null` when
 * the server sent neither - so the fixture is more honest for it, not less:
 * `updateRateLimits` reads a `null` value and an absent header identically.
 */
interface FakeSentryResponseHeaders {
  [key: string]: string | null;
  "x-sentry-rate-limits": string | null;
  "retry-after": string | null;
}

function responseHeaders(values: {
  readonly rateLimits: string | null;
  readonly retryAfter: string | null;
}): FakeSentryResponseHeaders {
  return {
    "x-sentry-rate-limits": values.rateLimits,
    "retry-after": values.retryAfter,
  };
}

// ---------------------------------------------------------------------------
// Rate-limit window
// ---------------------------------------------------------------------------
// Against the FACTORY, not the process-wide `sentryReportRateLimitWindow`
// singleton: the singleton's state is real, shared module state with no
// reset hook, so a test that fed it a rate limit would leak that limit into
// every other test in the process. The factory is what the production
// singleton is built from (`createSentryRateLimitWindow()`), so exercising it
// directly proves the same rule with no shared-state risk.
describe("createSentryRateLimitWindow", () => {
  function response(
    statusCode: number,
    headers: FakeSentryResponseHeaders | undefined,
  ): TransportMakeRequestResponse {
    return { statusCode, headers };
  }

  it("a 429 with retry-after: 120 reports limited with 120 seconds remaining", () => {
    const window = createSentryRateLimitWindow();
    const t0 = 1_000_000;
    window.observe(
      response(429, responseHeaders({ rateLimits: null, retryAfter: "120" })),
      t0,
    );

    const current = window.current(t0);
    expect(current.limited).toBe(true);
    // Math.ceil against the injected clock: observed at t0, read at t0, so
    // the full 120s window remains.
    expect(current.retryAfterSeconds).toBe(120);
  });

  it("a bare 429 with no headers falls back to core's 60-second default", () => {
    const window = createSentryRateLimitWindow();
    const t0 = 2_000_000;
    window.observe(response(429, undefined), t0);

    const current = window.current(t0);
    expect(current.limited).toBe(true);
    expect(current.retryAfterSeconds).toBe(60);
  });

  it("an x-sentry-rate-limits naming only 'error' does not limit a report (feedback category)", () => {
    const window = createSentryRateLimitWindow();
    const t0 = 3_000_000;
    window.observe(
      response(
        429,
        responseHeaders({
          rateLimits: "60:error:organization",
          retryAfter: null,
        }),
      ),
      t0,
    );

    // A limit naming only `error` must NOT stop a `feedback`-category report -
    // claiming otherwise would tell a user to wait for nothing.
    expect(window.current(t0)).toEqual({
      limited: false,
      retryAfterSeconds: null,
    });
  });

  it("an x-sentry-rate-limits with empty categories (blanket 'all') limits every category", () => {
    const window = createSentryRateLimitWindow();
    const t0 = 4_000_000;
    window.observe(
      response(
        429,
        responseHeaders({ rateLimits: "60::organization", retryAfter: null }),
      ),
      t0,
    );

    const current = window.current(t0);
    expect(current.limited).toBe(true);
    expect(current.retryAfterSeconds).toBe(60);
  });

  it("a 200 response leaves the window unlimited", () => {
    const window = createSentryRateLimitWindow();
    const t0 = 5_000_000;
    window.observe(response(200, undefined), t0);

    expect(window.current(t0)).toEqual({
      limited: false,
      retryAfterSeconds: null,
    });
  });

  it("a limit that has already expired against a later nowMs reads as not limited", () => {
    const window = createSentryRateLimitWindow();
    const t0 = 6_000_000;
    window.observe(
      response(429, responseHeaders({ rateLimits: null, retryAfter: "10" })),
      t0,
    );

    // Still inside the window.
    expect(window.current(t0 + 5_000).limited).toBe(true);
    // Past the 10s window.
    expect(window.current(t0 + 10_001)).toEqual({
      limited: false,
      retryAfterSeconds: null,
    });
  });
});

// ---------------------------------------------------------------------------
// sentryOfflineQueuePath
// ---------------------------------------------------------------------------
describe("sentryOfflineQueuePath", () => {
  it("is <userData>/sentry/queue", () => {
    expect(sentryOfflineQueuePath("/x/y")).toBe(
      join("/x/y", "sentry", "queue"),
    );
    expect(sentryOfflineQueuePath("/x/y").split("/")).toEqual(
      expect.arrayContaining(["x", "y", "sentry", "queue"]),
    );
  });

  it("equals the SDK's own default queue path (join(getSentryCachePath(), 'queue'), where getSentryCachePath() is <userData>/sentry)", () => {
    // `crash-reporter.ts` passes this same value as `transportOptions.queuePath`
    // specifically so the reader and the writer look at one directory - a
    // divergent path here would strand every envelope the SDK's own default
    // would have queued (see `main/electron-normalize.js`'s
    // `getSentryCachePath`, and `main/transports/offline-store.js`'s
    // `options.queuePath || path.join(getSentryCachePath(), 'queue')`).
    const userDataPath = "/Users/example/Library/Application Support/Traycer";
    const sdkDefault = join(join(userDataPath, "sentry"), "queue");
    expect(sentryOfflineQueuePath(userDataPath)).toBe(sdkDefault);
  });
});

// ---------------------------------------------------------------------------
// wasEventQueuedOffline - hand-crafted queue-v2.json + body fixtures
// ---------------------------------------------------------------------------
describe("wasEventQueuedOffline (hand-crafted fixtures)", () => {
  let queuePath = "";

  async function writeIndex(
    entries: ReadonlyArray<{ readonly id: string }>,
  ): Promise<void> {
    await mkdir(queuePath, { recursive: true });
    await writeFile(
      join(queuePath, "queue-v2.json"),
      JSON.stringify(
        entries.map((e) => ({ id: e.id, date: new Date().toISOString() })),
      ),
      "utf8",
    );
  }

  /** A minimal event envelope body: header line, then one JSON item line. */
  function eventEnvelopeBody(eventId: string): Buffer {
    const header = JSON.stringify({
      event_id: eventId,
      sent_at: new Date().toISOString(),
    });
    const itemHeader = JSON.stringify({ type: "event" });
    const payload = JSON.stringify({ event_id: eventId });
    return Buffer.from(`${header}\n${itemHeader}\n${payload}\n`, "utf8");
  }

  it("returns true when a queued entry's body header carries the matching event_id", async () => {
    queuePath = await mkdtemp(join(tmpdir(), "sentry-queue-"));
    try {
      await writeIndex([{ id: "entry-a" }]);
      await writeFile(
        join(queuePath, "entry-a"),
        eventEnvelopeBody("target-event"),
      );

      expect(await wasEventQueuedOffline(queuePath, "target-event")).toBe(true);
      expect(await wasEventQueuedOffline(queuePath, "some-other-event")).toBe(
        false,
      );
    } finally {
      await rm(queuePath, { recursive: true, force: true });
    }
  });

  it("reads the header correctly even when later envelope items carry binary (non-UTF8) bytes - an image attachment", async () => {
    queuePath = await mkdtemp(join(tmpdir(), "sentry-queue-"));
    try {
      const eventId = "binary-attachment-event";
      const header = JSON.stringify({
        event_id: eventId,
        sent_at: new Date().toISOString(),
      });
      const itemHeader = JSON.stringify({
        type: "attachment",
        filename: "screenshot.png",
        length: 4,
      });
      // Bytes that are not valid UTF-8 on their own (a PNG magic number plus
      // a lone continuation byte) - a naive whole-file JSON.parse would choke
      // on this; only the first line must ever be decoded as text.
      const binaryPayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x80]);
      const body = Buffer.concat([
        Buffer.from(`${header}\n${itemHeader}\n`, "utf8"),
        binaryPayload,
      ]);
      await writeIndex([{ id: "entry-bin" }]);
      await writeFile(join(queuePath, "entry-bin"), body);

      expect(await wasEventQueuedOffline(queuePath, eventId)).toBe(true);
    } finally {
      await rm(queuePath, { recursive: true, force: true });
    }
  });

  it("returns false when queue-v2.json is missing entirely - the ordinary 'nothing queued yet' case", async () => {
    queuePath = await mkdtemp(join(tmpdir(), "sentry-queue-"));
    try {
      expect(await wasEventQueuedOffline(queuePath, "anything")).toBe(false);
    } finally {
      await rm(queuePath, { recursive: true, force: true });
    }
  });

  it("returns false when the index lists an entry but its body file is missing (never delivered)", async () => {
    queuePath = await mkdtemp(join(tmpdir(), "sentry-queue-"));
    try {
      await writeIndex([{ id: "ghost-entry" }]);
      // No body file written for "ghost-entry".
      expect(await wasEventQueuedOffline(queuePath, "target-event")).toBe(
        false,
      );
    } finally {
      await rm(queuePath, { recursive: true, force: true });
    }
  });

  it("returns false, without throwing, for a malformed queue-v2.json (not JSON)", async () => {
    queuePath = await mkdtemp(join(tmpdir(), "sentry-queue-"));
    try {
      await mkdir(queuePath, { recursive: true });
      await writeFile(join(queuePath, "queue-v2.json"), "{not json", "utf8");
      await expect(wasEventQueuedOffline(queuePath, "anything")).resolves.toBe(
        false,
      );
    } finally {
      await rm(queuePath, { recursive: true, force: true });
    }
  });

  it("returns false, without throwing, when queue-v2.json is not an array", async () => {
    queuePath = await mkdtemp(join(tmpdir(), "sentry-queue-"));
    try {
      await mkdir(queuePath, { recursive: true });
      await writeFile(
        join(queuePath, "queue-v2.json"),
        JSON.stringify({ id: "not-an-array" }),
        "utf8",
      );
      await expect(wasEventQueuedOffline(queuePath, "anything")).resolves.toBe(
        false,
      );
    } finally {
      await rm(queuePath, { recursive: true, force: true });
    }
  });

  it("returns false, without throwing, when entries lack a string id", async () => {
    queuePath = await mkdtemp(join(tmpdir(), "sentry-queue-"));
    try {
      await mkdir(queuePath, { recursive: true });
      await writeFile(
        join(queuePath, "queue-v2.json"),
        JSON.stringify([{ notAnId: 1 }, { id: 42 }, { id: "" }, null, "x"]),
        "utf8",
      );
      await expect(wasEventQueuedOffline(queuePath, "anything")).resolves.toBe(
        false,
      );
    } finally {
      await rm(queuePath, { recursive: true, force: true });
    }
  });

  it("returns true when the match is the LAST of several queued entries", async () => {
    queuePath = await mkdtemp(join(tmpdir(), "sentry-queue-"));
    try {
      await writeIndex([
        { id: "entry-1" },
        { id: "entry-2" },
        { id: "entry-3" },
      ]);
      await writeFile(join(queuePath, "entry-1"), eventEnvelopeBody("event-1"));
      await writeFile(join(queuePath, "entry-2"), eventEnvelopeBody("event-2"));
      await writeFile(
        join(queuePath, "entry-3"),
        eventEnvelopeBody("target-event"),
      );

      expect(await wasEventQueuedOffline(queuePath, "target-event")).toBe(true);
    } finally {
      await rm(queuePath, { recursive: true, force: true });
    }
  });

  // --- Addendum (a): a queue entry that exists but does not identify OUR
  // envelope must read as not queued - this is what keeps the mechanism from
  // degenerating into "some new entry appeared" (a length/set-difference
  // compare), which cannot tell a concurrent push of a DIFFERENT report from
  // ours.
  it("returns false when a queued entry's body carries a DIFFERENT event_id (a foreign/stale envelope, never ours)", async () => {
    queuePath = await mkdtemp(join(tmpdir(), "sentry-queue-"));
    try {
      await writeIndex([{ id: "entry-foreign" }]);
      await writeFile(
        join(queuePath, "entry-foreign"),
        eventEnvelopeBody("someone-elses-event"),
      );

      expect(await wasEventQueuedOffline(queuePath, "target-event")).toBe(
        false,
      );
    } finally {
      await rm(queuePath, { recursive: true, force: true });
    }
  });

  it("returns false when a queued entry's header parses but carries no event_id key at all (e.g. a session/client-report envelope)", async () => {
    queuePath = await mkdtemp(join(tmpdir(), "sentry-queue-"));
    try {
      const header = JSON.stringify({ sent_at: new Date().toISOString() });
      const itemHeader = JSON.stringify({ type: "client_report" });
      const payload = JSON.stringify({ discarded_events: [] });
      await writeIndex([{ id: "entry-no-event-id" }]);
      await writeFile(
        join(queuePath, "entry-no-event-id"),
        Buffer.from(`${header}\n${itemHeader}\n${payload}\n`, "utf8"),
      );

      expect(await wasEventQueuedOffline(queuePath, "target-event")).toBe(
        false,
      );
    } finally {
      await rm(queuePath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// wasEventQueuedOffline against the REAL @sentry/electron offline store
// ---------------------------------------------------------------------------
//
// Route taken: the real store, loaded by ABSOLUTE path.
//
// `createOfflineStore` cannot be imported by bare specifier - `@sentry/
// electron`'s package `exports` map does not expose
// `./main/transports/offline-store.js` (verified: a bare
// `require("@sentry/electron/main/transports/offline-store.js")` throws
// MODULE_NOT_FOUND). An `exports` map only gates bare specifiers, though, so
// importing the SAME file by its absolute path under `node_modules/.bun/...`
// works. Two things had to be satisfied to make that import not throw here:
//
// 1. The file's own module graph reaches `main/electron-normalize.js`, which
//    does `require("electron")` at module load. Mocking `electron` (below)
//    is enough - `getSentryCachePath()` itself is never called because every
//    test passes an explicit `queuePath`.
// 2. `electron-normalize.js` also calls `core.parseSemver(process.versions.
//    electron)` at load time, which throws under plain Node/vitest because
//    `process.versions.electron` is undefined there. Stubbing that one
//    field on `process.versions` (a real Electron process would have it
//    already) is enough for the module to load without needing anything
//    else Electron-specific.
//
// With both satisfied, driving the real store proves the exact on-disk
// format `wasEventQueuedOffline` depends on - the `queue-v2` index shape,
// the per-id body path, and (via a real `push`) that the body write and the
// index write happen in that order - rather than assuming it.
vi.mock("electron", () => ({
  app: { getPath: (): string => "/tmp/unused-fake-userdata" },
}));

Object.defineProperty(process, "versions", {
  value: { ...process.versions, electron: "30.0.0" },
  configurable: true,
});

// Resolved via `require.resolve` on the PACKAGE's own subpath export
// (`@sentry/electron/main`, which IS in the package's `exports` map) rather
// than by walking `../..` from this test file: that keeps this path correct
// under bun's `.bun/<name>@<version>+<hash>` install layout without this
// test having to know how many directories deep it happens to sit, and
// avoids relying on `import.meta.url`, which resolves to a `/@fs/`-prefixed
// virtual path under Vite/vitest's SSR module graph - fine for `import()`,
// but not a real filesystem path `node:fs` can open.
const offlineStoreRequire = createRequire(import.meta.url);
const OFFLINE_STORE_ABSOLUTE_PATH = join(
  dirname(offlineStoreRequire.resolve("@sentry/electron/main")),
  "transports",
  "offline-store.js",
);

interface RealOfflineStore {
  readonly push: (envelope: unknown) => Promise<void>;
}

interface RealOfflineStoreModule {
  readonly createOfflineStore: (options: {
    readonly queuePath: string;
    readonly maxQueueSize?: number;
    readonly maxAgeDays?: number;
  }) => RealOfflineStore;
}

/**
 * Loads the real store, or FAILS loudly naming the path it tried.
 *
 * Deliberately not a null-returning probe guarded by `if (store === null)
 * return;` at each call site: that is a silent skip, and it would leave the
 * three tests below passing while proving nothing the moment the resolved
 * path or the two stubs above stop working - which is precisely the
 * environment change worth hearing about, since the whole `queued` verdict
 * rests on the on-disk format these tests confirm. The source-format pin at
 * the bottom of this file is defence in depth for that case, not a licence
 * for these three to go quiet.
 */
async function loadRealOfflineStore(): Promise<RealOfflineStoreModule> {
  let mod: unknown;
  try {
    mod = await import(OFFLINE_STORE_ABSOLUTE_PATH);
  } catch (error) {
    throw new Error(
      `could not import the real @sentry/electron offline store at ${OFFLINE_STORE_ABSOLUTE_PATH}: ${String(error)}`,
    );
  }
  if (
    mod === null ||
    typeof mod !== "object" ||
    !("createOfflineStore" in mod) ||
    typeof Reflect.get(mod, "createOfflineStore") !== "function"
  ) {
    throw new Error(
      `${OFFLINE_STORE_ABSOLUTE_PATH} imported but exports no createOfflineStore function`,
    );
  }
  return mod as RealOfflineStoreModule;
}

async function realEventEnvelope(
  eventId: string,
  sentAt: Date | undefined,
): Promise<EventEnvelope> {
  const core = await import("@sentry/core");
  // The generic is supplied EXPLICITLY, as `createEnvelope`'s own doc comment
  // instructs ("Make sure to always explicitly provide the generic to this
  // function so that the envelope types resolve correctly"). Its signature is
  // `createEnvelope<E extends Envelope>(headers: E[0], items?: E[1])`, and
  // `Envelope` is a UNION of tuple types - so with both parameters being
  // indexed accesses into `E`, inference from these literals has nothing to
  // pin `E` to and falls back to the union.
  return core.createEnvelope<EventEnvelope>(
    { event_id: eventId, sent_at: (sentAt ?? new Date()).toISOString() },
    [[{ type: "event" }, { event_id: eventId }]],
  );
}

describe("wasEventQueuedOffline against the real @sentry/electron offline store", () => {
  it("a real push, then wasEventQueuedOffline, answers true - proving body-then-index write order and the header's position in one shot", async () => {
    const realStore = await loadRealOfflineStore();
    const queuePath = await mkdtemp(join(tmpdir(), "sentry-real-queue-"));
    try {
      const store = realStore.createOfflineStore({ queuePath });
      const eventId = "real-store-event";
      await store.push(await realEventEnvelope(eventId, undefined));

      // The read happens in the same tick `Sentry.flush` resolves, while the
      // offline transport's own replay is still 5s away (`START_DELAY` on the
      // queue-on-error path in `@sentry/core`'s offline transport) - there is
      // no clock to race here, so this test needs no fake-timer control.
      expect(await wasEventQueuedOffline(queuePath, eventId)).toBe(true);
      expect(await wasEventQueuedOffline(queuePath, "not-this-one")).toBe(
        false,
      );
    } finally {
      await rm(queuePath, { recursive: true, force: true });
    }
  });

  it("a push that hits maxQueueSize is dropped at the cap and reads as not queued", async () => {
    const realStore = await loadRealOfflineStore();
    const queuePath = await mkdtemp(join(tmpdir(), "sentry-real-queue-"));
    try {
      const store = realStore.createOfflineStore({
        queuePath,
        maxQueueSize: 1,
      });
      await store.push(await realEventEnvelope("first-event", undefined));
      const droppedEventId = "second-event-dropped-at-cap";
      await store.push(await realEventEnvelope(droppedEventId, undefined));

      expect(await wasEventQueuedOffline(queuePath, droppedEventId)).toBe(
        false,
      );
    } finally {
      await rm(queuePath, { recursive: true, force: true });
    }
  });

  it("a push that prunes a stale entry still keeps (and reports queued for) the new envelope", async () => {
    const realStore = await loadRealOfflineStore();
    const queuePath = await mkdtemp(join(tmpdir(), "sentry-real-queue-"));
    try {
      // `maxAgeDays: 0` does NOT mean "immediately stale" - the store's own
      // `userOptions.maxAgeDays || 30` falls back to its 30-day default for
      // a falsy 0, so a real back-dated `sent_at` (which `insert` reads via
      // `getSentAtFromEnvelope` for the entry's `date`) plus a small nonzero
      // `maxAgeDays` is what actually exercises `removeStaleRequests`.
      const store = realStore.createOfflineStore({
        queuePath,
        maxAgeDays: 1,
        maxQueueSize: 30,
      });
      const staleEventId = "stale-event";
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await store.push(await realEventEnvelope(staleEventId, twoDaysAgo));

      const newEventId = "kept-after-prune-event";
      await store.push(await realEventEnvelope(newEventId, undefined));

      expect(await wasEventQueuedOffline(queuePath, staleEventId)).toBe(false);
      expect(await wasEventQueuedOffline(queuePath, newEventId)).toBe(true);
    } finally {
      await rm(queuePath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fallback: source-format pin. Always runs (not gated on the real store
// loading) so the on-disk format contract stays checked even if a future
// environment change stops the real-store route above from loading. Each
// assertion names the exact marker it looked for - a regex that silently
// matched nothing would be a test that passes while proving nothing.
// ---------------------------------------------------------------------------
describe("offline-store.js source format pin (defense in depth, independent of whether the real store loads)", () => {
  it("still declares the four markers wasEventQueuedOffline's reader depends on", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(OFFLINE_STORE_ABSOLUTE_PATH, "utf8");

    expect(source, "the store id must still be 'queue-v2'").toContain(
      "'queue-v2'",
    );
    expect(
      source,
      "the body must still be written per-id under queuePath",
    ).toContain("path.join(options.queuePath, id)");
    expect(
      source,
      "the body write must still be awaited before the index update",
    ).toMatch(
      /await fs\.promises\.writeFile\(path\.join\(options\.queuePath, id\), data\);[\s\S]*?await queue\.update/,
    );
    expect(
      source,
      "the maxQueueSize cap arm must still drop the body and return the queue unchanged",
    ).toMatch(
      /queue\.length >= options\.maxQueueSize\)\s*\{\s*removeBody\(id\);\s*return queue;/,
    );
  });
});
