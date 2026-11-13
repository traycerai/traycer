import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  QueryObserver,
  type Query,
  type QueryClient,
} from "@tanstack/react-query";
import { sweepTransientCloudFailures } from "@/lib/host/cloud-recovery-sweep";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  hostFailure,
  hostReadKey,
} from "@/lib/host/test-support/cloud-failure-reads";
import { isTransientCloudFailure } from "@/lib/host/transient-cloud-failure";
import { appLogger } from "@/lib/logger";
import { createAppQueryClient } from "@/lib/query-client";
import { HOST } from "@/lib/host/test-support/cloud-recovery-sweep-support";

/**
 * Every ordering of a bounded set of events against one stranded read, run on
 * the real client, the real sweep and the real invalidator. After each event
 * the invariants of the sweep's contract are checked, so every prefix of every
 * sequence is covered.
 *
 * A ring is owed to exactly one attempt, the one in flight on the read when it
 * arrived. A transient end of that attempt spends the ring only while that
 * attempt is the read's latest; a ring never cancels or restarts an attempt
 * that began after it.
 */

/** Microtask turns drained after every event: far past the longest chain the sweep runs. */
const DRAIN_TURNS = 32;

const ALL_EVENTS = [
  "ring",
  "startElsewhere",
  "startInsideError",
  "startMicrotaskAfterError",
  "ringMicrotaskAfterError",
  "endTransient",
  "endNonTransient",
  "endSuccess",
  "cancelRevert",
  "remove",
  "replace",
  "reset",
  "clear",
] as const;
type EventName = (typeof ALL_EVENTS)[number];

/** The events every finding so far needs beyond depth 4. */
const CORE_EVENTS: readonly EventName[] = [
  "ring",
  "startElsewhere",
  "startInsideError",
  "startMicrotaskAfterError",
  "ringMicrotaskAfterError",
  "endTransient",
  "cancelRevert",
];

/**
 * Two passes: every event to depth 4, then the core events to depth 5. Each
 * finding so far fits one of them (V2 needs depth 5 and only core events; the
 * replacement, reset and cancel findings need depth 4 or less).
 */
interface Pass {
  readonly alphabet: readonly EventName[];
  readonly depth: number;
}

const PASSES: readonly Pass[] = [
  { alphabet: ALL_EVENTS, depth: 4 },
  { alphabet: CORE_EVENTS, depth: 5 },
];

type AnswerKind = "success" | "transient" | "nontransient";

interface AskEnd {
  readonly kind: AnswerKind | "aborted";
  readonly at: number;
  /** What was running when it ended. */
  readonly context: string;
}

interface Ask {
  readonly id: number;
  readonly readId: number;
  readonly start: number;
  /** `setup`, `test:<event>`, `ring:<n>` (inside that ring's call), or `spend`. */
  readonly context: string;
  end: AskEnd | null;
  settle: (kind: AnswerKind) => void;
}

interface RingRecord {
  readonly n: number;
  readonly at: number;
  readonly readId: number | null;
  readonly arrival: "failed" | "flight" | "other" | "none";
  /** The attempt in flight when it arrived. */
  readonly attempt: number | null;
}

interface Variant {
  readonly label: string;
  readonly method: string;
  readonly holdsData: boolean;
}

const VARIANTS: readonly Variant[] = [
  { label: "holds data", method: "bot.thread.list", holdsData: true },
  { label: "holds no data", method: "bot.list", holdsData: false },
];

type Hook =
  | "startInsideError"
  | "startMicrotaskAfterError"
  | "ringMicrotaskAfterError";

async function drain(): Promise<void> {
  for (let turn = 0; turn < DRAIN_TURNS; turn += 1) await Promise.resolve();
}

class Rig {
  readonly client: QueryClient = createAppQueryClient();
  readonly asks: Ask[] = [];
  readonly rings: RingRecord[] = [];
  readonly trace: EventName[] = [];
  private clock = 0;
  private context: string | null = null;
  private readonly queryKey: readonly unknown[];
  private readonly queryHash: string;
  private readonly readIds = new WeakMap<object, number>();
  private nextReadId = 0;
  private unsubscribe: (() => void) | null = null;
  private autoAnswers: AnswerKind[] = [];
  private armed: Hook[] = [];
  private readonly stopCache: () => void;

  constructor(private readonly variant: Variant) {
    this.queryKey = hostReadKey(HOST, variant.method, "i");
    this.queryHash = this.client.defaultQueryOptions({
      queryKey: this.queryKey,
    }).queryHash;
    this.stopCache = this.client.getQueryCache().subscribe((event) => {
      if (event.query.queryHash !== this.queryHash) return;
      if (event.type === "added") this.readIdOf(event.query);
      if (
        event.type === "updated" &&
        this.armed.length > 0 &&
        event.query.state.status === "error" &&
        event.query.state.fetchStatus === "idle" &&
        event.query === this.current()
      ) {
        this.fireHooks();
      }
    });
  }

  private readIdOf(query: object): number {
    const known = this.readIds.get(query);
    if (known !== undefined) return known;
    const id = this.nextReadId;
    this.nextReadId += 1;
    this.readIds.set(query, id);
    return id;
  }

  current(): Query | undefined {
    return this.client
      .getQueryCache()
      .find({ queryKey: this.queryKey, exact: true });
  }

  currentReadId(): number | null {
    const query = this.current();
    return query === undefined ? null : this.readIdOf(query);
  }

  pending(): Ask[] {
    return this.asks.filter((ask) => ask.end === null);
  }

  private within(context: string, run: () => void): void {
    const outer = this.context;
    this.context = context;
    try {
      run();
    } finally {
      this.context = outer;
    }
  }

  private mount(): void {
    const observer = new QueryObserver<string>(this.client, {
      queryKey: this.queryKey,
      retry: false,
      queryFn: ({ signal }) => this.ask(signal),
    });
    this.unsubscribe = observer.subscribe(() => undefined);
  }

  private unmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private ask(signal: AbortSignal): Promise<string> {
    const query = this.current();
    if (query === undefined) throw new Error("an ask began on no read");
    const ask: Ask = {
      id: this.asks.length,
      readId: this.readIdOf(query),
      start: ++this.clock,
      context: this.context ?? "spend",
      end: null,
      settle: () => undefined,
    };
    this.asks.push(ask);
    return new Promise<string>((resolve, reject) => {
      ask.settle = (kind) => {
        ask.end = { kind, at: ++this.clock, context: this.context ?? "spend" };
        if (kind === "success") resolve("ok");
        else {
          reject(
            hostFailure(
              kind === "transient" ? "E_CLOUD_REQUEST_REFUSED" : "FORBIDDEN",
              this.variant.method,
            ),
          );
        }
      };
      signal.addEventListener(
        "abort",
        () => {
          if (ask.end !== null) return;
          ask.end = {
            kind: "aborted",
            at: ++this.clock,
            context: this.context ?? "spend",
          };
          reject(new Error("the ask was aborted"));
        },
        { once: true },
      );
      const answer = this.autoAnswers.shift();
      if (answer !== undefined) ask.settle(answer);
    });
  }

  /** The stranded read: observed, transiently failed, no ask pending. */
  async strand(): Promise<void> {
    this.autoAnswers = this.variant.holdsData
      ? ["success", "transient"]
      : ["transient"];
    this.context = "setup";
    this.mount();
    await drain();
    if (this.variant.holdsData) {
      await this.client.refetchQueries({
        queryKey: this.queryKey,
        exact: true,
      });
    }
    this.context = null;
    await drain();
  }

  private fireHooks(): void {
    const hooks = this.armed.splice(0);
    for (const hook of hooks) {
      if (hook === "startInsideError") this.startElsewhere("startInsideError");
      else if (hook === "startMicrotaskAfterError") {
        queueMicrotask(() => {
          this.startElsewhere("startMicrotaskAfterError");
        });
      } else {
        queueMicrotask(() => {
          this.ringNow();
        });
      }
    }
  }

  private startElsewhere(event: EventName): void {
    this.within(`test:${event}`, () => {
      void this.client.refetchQueries({ queryKey: this.queryKey, exact: true });
    });
  }

  ringNow(): void {
    const query = this.current();
    const state = query?.state;
    const readId = query === undefined ? null : this.readIdOf(query);
    let arrival: RingRecord["arrival"] = "none";
    let attempt: number | null = null;
    if (query !== undefined && state !== undefined) {
      if (state.fetchStatus === "fetching") {
        arrival = "flight";
        attempt =
          this.asks.findLast((a) => a.readId === readId && a.end === null)
            ?.id ?? null;
      } else if (
        state.status === "error" &&
        isTransientCloudFailure(state.error)
      ) {
        arrival = "failed";
      } else arrival = "other";
    }
    const ring: RingRecord = {
      n: this.rings.length,
      at: ++this.clock,
      readId,
      arrival,
      attempt,
    };
    this.rings.push(ring);
    this.within(`ring:${ring.n}`, () => {
      void sweepTransientCloudFailures(this.client, HOST);
    });
  }

  enabled(): EventName[] {
    const read = this.current() !== undefined;
    const pending = this.pending().length > 0;
    const fetching = this.client.isFetching() > 0;
    const anything = this.client.getQueryCache().getAll().length > 0;
    return ALL_EVENTS.filter((event) => {
      switch (event) {
        case "ring":
          return true;
        case "startElsewhere":
        case "remove":
        case "replace":
        case "reset":
          return read;
        case "startInsideError":
        case "startMicrotaskAfterError":
        case "ringMicrotaskAfterError":
          return pending && !this.armed.includes(event);
        case "endTransient":
        case "endNonTransient":
        case "endSuccess":
          return pending;
        case "cancelRevert":
          return fetching;
        case "clear":
          return anything;
      }
    });
  }

  async run(event: EventName): Promise<void> {
    this.trace.push(event);
    switch (event) {
      case "ring":
        this.ringNow();
        break;
      case "startElsewhere":
        this.startElsewhere(event);
        break;
      case "startInsideError":
      case "startMicrotaskAfterError":
      case "ringMicrotaskAfterError":
        this.armed.push(event);
        break;
      case "endTransient":
        this.within(`test:${event}`, () => {
          this.pending()[0]?.settle("transient");
        });
        break;
      case "endNonTransient":
        this.within(`test:${event}`, () => {
          this.pending()[0]?.settle("nontransient");
        });
        break;
      case "endSuccess":
        this.within(`test:${event}`, () => {
          this.pending()[0]?.settle("success");
        });
        break;
      case "cancelRevert": {
        const port = createHostQueryInvalidator(this.client);
        if (port.cancelHostScope === undefined) {
          throw new Error("the invalidator has no cancel port");
        }
        const cancelHostScope = port.cancelHostScope;
        let cancelled: Promise<void> = Promise.resolve();
        this.within("test:cancelRevert", () => {
          cancelled = cancelHostScope(HOST);
        });
        await cancelled;
        break;
      }
      case "remove":
        this.within("test:remove", () => {
          this.unmount();
          this.client.removeQueries({ queryKey: this.queryKey, exact: true });
        });
        break;
      case "replace":
        this.within("test:replace", () => {
          this.unmount();
          this.client.removeQueries({ queryKey: this.queryKey, exact: true });
          this.mount();
        });
        break;
      case "reset":
        this.within("test:reset", () => {
          void this.client.resetQueries({
            queryKey: this.queryKey,
            exact: true,
          });
        });
        break;
      case "clear":
        this.within("test:clear", () => {
          this.unmount();
          this.client.clear();
        });
        break;
    }
    await drain();
  }

  /** Ends every ask still pending as a transient failure, checking after each. */
  async settleAll(check: () => string | null): Promise<string | null> {
    for (let step = 0; step < 24 && this.pending().length > 0; step += 1) {
      this.trace.push("endTransient");
      this.pending()[0]?.settle("transient");
      await drain();
      const found = check();
      if (found !== null) return found;
    }
    return null;
  }

  /** Each ask and ring in order, for a failure message. */
  describe(): string {
    const asks = this.asks.map(
      (a) =>
        `ask${a.id}(read ${a.readId}, ${a.context}, @${a.start}, ${a.end === null ? "pending" : `${a.end.kind} by ${a.end.context} @${a.end.at}`})`,
    );
    const rings = this.rings.map(
      (r) =>
        `ring${r.n}(${r.arrival}, @${r.at}, attempt ${r.attempt ?? "none"})`,
    );
    return `${asks.join(" ")} ${rings.join(" ")}`;
  }

  stopHooks(): void {
    this.armed = [];
    this.stopCache();
  }

  dispose(): void {
    this.unmount();
    this.stopCache();
    this.client.clear();
  }

  /** Whether the read present is observed and transiently failed with nothing in flight. */
  readStrandedNow(): boolean {
    const query = this.current();
    return (
      query !== undefined &&
      query.state.status === "error" &&
      query.state.fetchStatus === "idle" &&
      isTransientCloudFailure(query.state.error) &&
      this.pending().length === 0
    );
  }

  dRing(): void {
    this.trace.push("ring");
    this.ringNow();
  }

  dStartElsewhere(): void {
    this.trace.push("startElsewhere");
    this.startElsewhere("startElsewhere");
  }
}

/**
 * (A) No attempt is aborted outside a test cancel or a ring call, and a ring
 * aborts only an attempt that began before it.
 */
function checkAborts({ asks, rings }: Rig): string | null {
  for (const ask of asks) {
    const end = ask.end;
    if (end === null || end.kind !== "aborted") continue;
    if (end.context.startsWith("test:")) continue;
    if (end.context.startsWith("ring:")) {
      const ring = rings.at(Number(end.context.slice("ring:".length)));
      if (ring !== undefined && ask.start < ring.at) continue;
      return `(A) ask ${ask.id} was aborted inside ${end.context}, which began before it`;
    }
    return `(A) ask ${ask.id} was aborted from a ${end.context} step`;
  }

  return null;
}

/** (C) Asks the sweep started for a read number at most the rings that reached it. */
function checkAskCounts({ asks, rings }: Rig): string | null {
  const sweepAsks = new Map<number, number>();
  for (const ask of asks) {
    if (ask.context === "spend" || ask.context.startsWith("ring:")) {
      sweepAsks.set(ask.readId, (sweepAsks.get(ask.readId) ?? 0) + 1);
    }
  }
  for (const [readId, count] of sweepAsks) {
    const reached = rings.filter((r) => r.readId === readId).length;
    if (count > reached) {
      return `(C) read ${readId} had ${count} sweep asks for ${reached} rings`;
    }
  }

  return null;
}

/** (E) Every ask the sweep starts spends a ring it may. */
function checkSpends({ asks, rings }: Rig): string | null {
  // (E) An ask the sweep starts (outside any test event) is legal only for an
  // unspent ring: one that arrived on a failed read, with no attempt started on
  // that read since; or one whose in-flight attempt ended transiently, with no
  // attempt started on that read between that end and this ask.
  const spent = new Set<number>();
  for (const spend of asks.filter((a) => a.context === "spend")) {
    const none = (since: number): boolean =>
      !asks.some(
        (a) =>
          a.readId === spend.readId && a.start > since && a.start < spend.start,
      );
    const ring =
      rings.find((r) => {
        if (spent.has(r.n) || r.attempt === null) return false;
        const attempt = asks.at(r.attempt);
        return (
          attempt !== undefined &&
          attempt.readId === spend.readId &&
          attempt.end !== null &&
          attempt.end.kind === "transient" &&
          attempt.end.at < spend.start &&
          none(attempt.end.at)
        );
      }) ??
      rings.find(
        (r) =>
          !spent.has(r.n) &&
          r.arrival === "failed" &&
          r.readId === spend.readId &&
          none(r.at),
      );
    if (ring === undefined) {
      return `(E) sweep ask ${spend.id} has no unspent ring it may spend`;
    }
    spent.add(ring.n);
  }
  return null;
}

/** (B) At quiescence, a transiently failed read has no ring stranded. */
function checkQuiescence(rig: Rig): string | null {
  if (rig.pending().length > 0 || !rig.readStrandedNow()) return null;
  const readId = rig.currentReadId();
  for (const ring of rig.rings) {
    if (ring.readId !== readId) continue;
    if (ring.arrival !== "failed" && ring.arrival !== "flight") continue;
    if (rig.asks.some((a) => a.readId === readId && a.start > ring.at))
      continue;
    const attempt = ring.attempt === null ? undefined : rig.asks[ring.attempt];
    if (ring.arrival === "flight") {
      if (attempt?.end?.kind !== "transient") continue;
    }
    return `(B) ring ${ring.n} (arrived ${ring.arrival}) is stranded: nothing was asked after it`;
  }
  return null;
}

function checkAll(rig: Rig): string | null {
  return (
    checkAborts(rig) ??
    checkAskCounts(rig) ??
    checkSpends(rig) ??
    checkQuiescence(rig)
  );
}

interface Failure {
  readonly invariant: string;
  readonly sequence: string;
  readonly detail: string;
}

interface Counts {
  sequences: number;
  failures: Map<string, { first: Failure; total: number; sequences: string[] }>;
  skippedD: number;
}

async function runSequence(
  variant: Variant,
  choices: readonly number[],
  pass: Pass,
  counts: Counts,
): Promise<number[]> {
  const rig = new Rig(variant);
  const widths: number[] = [];
  const note = (found: string | null): void => {
    if (found === null) return;
    const invariant = found.slice(0, 3);
    const entry = counts.failures.get(invariant);
    if (entry !== undefined) {
      entry.total += 1;
      entry.sequences.push(rig.trace.join(" > "));
      return;
    }
    counts.failures.set(invariant, {
      first: {
        invariant,
        sequence: rig.trace.join(" > "),
        detail: `${found}\n    ${rig.describe()}`,
      },
      total: 1,
      sequences: [rig.trace.join(" > ")],
    });
  };
  try {
    await rig.strand();
    let failed = false;
    for (let step = 0; step < pass.depth && !failed; step += 1) {
      const options = rig.enabled().filter((e) => pass.alphabet.includes(e));
      widths.push(options.length);
      const event = options.at(choices[step] ?? 0);
      if (event === undefined) break;
      await rig.run(event);
      const found = checkAll(rig);
      if (found !== null) {
        note(found);
        failed = true;
      }
    }
    if (!failed) {
      rig.stopHooks();
      const tail = await rig.settleAll(() => checkAll(rig));
      if (tail !== null) {
        note(tail);
        failed = true;
      }
    }
    if (!failed) {
      note(await checkClean(rig, counts));
    }
  } finally {
    rig.dispose();
  }
  counts.sequences += 1;
  return widths;
}

/** (D) Nothing is left claimed and nothing is left owed. */
async function checkClean(rig: Rig, counts: Counts): Promise<string | null> {
  if (!rig.readStrandedNow()) {
    counts.skippedD += 1;
    return null;
  }
  const before = rig.asks.length;
  rig.dRing();
  await drain();
  if (rig.asks.length !== before + 1) {
    return `(D1) a fresh ring made ${rig.asks.length - before} asks, not 1`;
  }
  rig.pending()[0]?.settle("transient");
  await drain();
  if (rig.asks.length !== before + 1) {
    return `(D1) the fresh ring's ask failed and ${rig.asks.length - before - 1} more asks followed`;
  }
  rig.dStartElsewhere();
  await drain();
  rig.pending()[0]?.settle("transient");
  await drain();
  if (rig.asks.length !== before + 2) {
    return `(D2) a refetch that failed with no ring was followed by ${rig.asks.length - before - 2} asks`;
  }
  return null;
}

async function explore(variant: Variant, pass: Pass): Promise<Counts> {
  const counts: Counts = { sequences: 0, failures: new Map(), skippedD: 0 };
  let choices: number[] = [];
  for (;;) {
    const widths = await runSequence(variant, choices, pass, counts);
    const taken = widths.map((_, step) => choices[step] ?? 0);
    let step = widths.length - 1;
    while (step >= 0 && (taken[step] ?? 0) + 1 >= (widths[step] ?? 0)) {
      step -= 1;
    }
    if (step < 0) return counts;
    choices = [...taken.slice(0, step), (taken[step] ?? 0) + 1];
  }
}

function describeFailures(counts: Counts): string {
  return [...counts.failures.values()]
    .map(
      ({ first, total, sequences }) =>
        `${first.detail}\n    first sequence: ${first.sequence}\n    failing sequences: ${total} of ${counts.sequences}\n      ${sequences.slice(0, 400).join("\n      ")}`,
    )
    .join("\n");
}

describe("sweepTransientCloudFailures over every ordering of its events", () => {
  beforeAll(() => {
    vi.spyOn(appLogger, "warn").mockImplementation(() => undefined);
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it.each(VARIANTS)(
    "keeps every invariant for a stranded read that $label",
    async (variant) => {
      const report: string[] = [];
      for (const pass of PASSES) {
        const counts = await explore(variant, pass);
        report.push(describeFailures(counts));
        expect(counts.sequences).toBeGreaterThan(0);
      }

      expect(report.join("")).toBe("");
    },
    120_000,
  );
});
