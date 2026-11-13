import { setImmediate as nextImmediate } from "node:timers/promises";
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
import { HOST } from "@/lib/host/test-support/cloud-recovery-sweep-support";
import type {
  HeldTimer,
  HeldTimers,
} from "@/lib/host/test-support/held-timers";
import { isTransientCloudFailure } from "@/lib/host/transient-cloud-failure";
import { createAppQueryClient } from "@/lib/query-client";

/**
 * Every ordering of a bounded set of events against one stranded read, run on
 * the real client, the real sweep and the real invalidator. After each event
 * the invariants of the sweep's contract are checked, so every prefix of every
 * sequence is covered.
 *
 * A ring is owed to exactly one attempt, the one in flight on the read when it
 * arrived. A transient end of that attempt spends the ring only while that
 * attempt is the read's latest; a ring never cancels or restarts an attempt
 * that began after it, and never ends one the sweep started itself.
 *
 * Time is not waited for. Each event is followed by one event-loop barrier,
 * which runs every microtask the event set going. TanStack's own timers (gc,
 * observer staleness, retry backoff) are held and fire only as named events,
 * and anything it hands to `notifyManager`'s scheduler fails the sequence.
 */

export const ALL_EVENTS = [
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
  "unobserve",
  "gc",
  "backoffEnds",
] as const;
export type EventName = (typeof ALL_EVENTS)[number];

export interface Pass {
  readonly alphabet: readonly EventName[];
  readonly depth: number;
  /** The events the first step may take, or `null` for all: a slice of the walk. */
  readonly firstEvents: readonly EventName[] | null;
}

/**
 * A walk is split into slices by its first event, so each file walks only the
 * sequences that start with its slice and each sequence is walked once.
 */
export type Slice = "all" | "a" | "b";

export type PassKind = "full" | "core" | "lifecycle";

/**
 * The first events of slice `a`, balanced against slice `b`, which takes every
 * other event. The full pass can start with any of six events; the core and
 * lifecycle passes mostly with `ring` or `startElsewhere`.
 */
const SLICE_A_EVENTS: Record<PassKind, readonly EventName[]> = {
  full: ["ring", "startElsewhere", "remove"],
  core: ["ring"],
  lifecycle: ["ring"],
};

/** The first events of a slice, or `null` for the whole walk. */
export function firstEventsOf(
  slice: Slice,
  kind: PassKind,
): readonly EventName[] | null {
  if (slice === "all") return null;
  return slice === "a"
    ? SLICE_A_EVENTS[kind]
    : ALL_EVENTS.filter((event) => !SLICE_A_EVENTS[kind].includes(event));
}

export interface Variant {
  readonly label: string;
  readonly method: string;
  readonly holdsData: boolean;
}

export const VARIANTS: readonly Variant[] = [
  { label: "holds data", method: "bot.thread.list", holdsData: true },
  { label: "holds no data", method: "bot.list", holdsData: false },
];

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

const NOT_IN_FULL: readonly EventName[] = ["unobserve", "gc", "backoffEnds"];

/** Only a read under the app's retry policy has a backoff to end. */
function forPolicy(
  events: readonly EventName[],
  retry: RetryPolicy,
): EventName[] {
  return retry === "app" ? [...events, "backoffEnds"] : [...events];
}

/** The passes of the walk, each over its own events and depth. */
export function passFor(
  kind: PassKind,
  retry: RetryPolicy,
  slice: Slice,
): Pass {
  const firstEvents = firstEventsOf(slice, kind);
  if (kind === "full") {
    return {
      alphabet: forPolicy(
        ALL_EVENTS.filter((event) => !NOT_IN_FULL.includes(event)),
        retry,
      ),
      depth: 4,
      firstEvents,
    };
  }
  if (kind === "core") {
    return { alphabet: forPolicy(CORE_EVENTS, retry), depth: 5, firstEvents };
  }
  return {
    alphabet: forPolicy([...CORE_EVENTS, "unobserve", "gc"], retry),
    depth: 4,
    firstEvents,
  };
}

/** Whether a failed try waits out TanStack's backoff and tries again. */
export type RetryPolicy = "off" | "app";

/** The tries the app's policy allows an attempt: the first and one retry. */
const TRIES_UNDER: Record<RetryPolicy, number> = { off: 1, app: 2 };

const GC_MS = 300_000;
/**
 * The most an observer's staleness timer may wait: `staleTime` (60 s) + 1.
 * TanStack sets it to `staleTime - (now - dataUpdatedAt) + 1`, so it shrinks
 * with the wall-clock time since the data arrived; a loaded runner can make it
 * any smaller. It has no lower bound for that reason.
 */
const STALE_MS_MOST = 60_001;

type AnswerKind = "success" | "transient" | "nontransient";

interface AttemptEnd {
  readonly kind: AnswerKind | "aborted";
  readonly at: number;
  /** What was running when it ended. */
  readonly context: string;
}

interface HeldTry {
  readonly resolve: (value: string) => void;
  readonly reject: (error: Error) => void;
}

/** One attempt of the read: a first try, and under retries the tries after it. */
interface Attempt {
  readonly id: number;
  readonly readId: number;
  readonly start: number;
  /** `setup`, `test:<event>`, `ring:<n>` (inside that ring's call), or `spend`. */
  readonly context: string;
  readonly sweepStarted: boolean;
  tries: number;
  /** Failed a try that will be retried, and waits for its backoff. */
  backoff: boolean;
  end: AttemptEnd | null;
  /** The try asked and not yet answered. */
  current: HeldTry | null;
}

interface RingRecord {
  readonly n: number;
  readonly at: number;
  readonly readId: number | null;
  readonly arrival: "failed" | "flight" | "other" | "none";
  /** The attempt in flight when it arrived. */
  readonly attempt: number | null;
}

type Hook =
  | "startInsideError"
  | "startMicrotaskAfterError"
  | "ringMicrotaskAfterError";

type TimerSource = "gc" | "stale" | "backoff" | "unknown";

/** Which TanStack module set `timer`, read from where it was set. */
function sourceOf(timer: HeldTimer): TimerSource {
  if (/removable/.test(timer.stack)) return "gc";
  if (/queryObserver/.test(timer.stack)) return "stale";
  if (/retryer/.test(timer.stack)) return "backoff";
  return "unknown";
}

export class Rig {
  readonly client: QueryClient = createAppQueryClient();
  readonly attempts: Attempt[] = [];
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
  private readonly backoffTimers = new Map<HeldTimer, number>();
  private readonly bySignal = new WeakMap<AbortSignal, Attempt>();

  constructor(
    private readonly variant: Variant,
    private readonly retry: RetryPolicy,
    private readonly timers: HeldTimers,
  ) {
    this.timers.reset();
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

  /** Attempts with a try asked and not yet answered. */
  pending(): Attempt[] {
    return this.attempts.filter((attempt) => attempt.current !== null);
  }

  /** Attempts waiting out a backoff. */
  inBackoff(): Attempt[] {
    return this.attempts.filter(
      (attempt) => attempt.backoff && attempt.end === null,
    );
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

  private observed(): boolean {
    return this.unsubscribe !== null;
  }

  private mount(): void {
    const observer = new QueryObserver<string>(this.client, {
      queryKey: this.queryKey,
      ...(this.retry === "off" ? { retry: false } : {}),
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
    if (query === undefined) throw new Error("a try began on no read");
    const readId = this.readIdOf(query);
    // Tries of one attempt share its abort signal; a new fetch has its own.
    const retried = this.bySignal.get(signal);
    let attempt: Attempt;
    if (retried === undefined) {
      const context = this.context ?? "spend";
      attempt = {
        id: this.attempts.length,
        readId,
        start: ++this.clock,
        context,
        sweepStarted: context === "spend" || context.startsWith("ring:"),
        tries: 1,
        backoff: false,
        end: null,
        current: null,
      };
      this.attempts.push(attempt);
      this.bySignal.set(signal, attempt);
      const started = attempt;
      signal.addEventListener("abort", () => {
        this.abort(started);
      });
    } else {
      attempt = retried;
      attempt.tries += 1;
      attempt.backoff = false;
    }
    const asked = attempt;
    return new Promise<string>((resolve, reject) => {
      asked.current = { resolve, reject };
      const answer = this.autoAnswers.shift();
      if (answer !== undefined) this.settle(asked, answer);
    });
  }

  private abort(attempt: Attempt): void {
    if (attempt.end !== null) return;
    attempt.end = {
      kind: "aborted",
      at: ++this.clock,
      context: this.context ?? "spend",
    };
    attempt.backoff = false;
    const held = attempt.current;
    attempt.current = null;
    held?.reject(new Error("the attempt was aborted"));
  }

  /** Answers the try `attempt` has asked; a failed try before the last waits for its backoff. */
  private settle(attempt: Attempt, kind: AnswerKind): void {
    const held = attempt.current;
    if (held === null) return;
    attempt.current = null;
    if (kind === "success" || attempt.tries >= TRIES_UNDER[this.retry]) {
      attempt.end = {
        kind,
        at: ++this.clock,
        context: this.context ?? "spend",
      };
    } else {
      attempt.backoff = true;
    }
    if (kind === "success") held.resolve("ok");
    else {
      held.reject(
        hostFailure(
          kind === "transient" ? "E_CLOUD_REQUEST_REFUSED" : "FORBIDDEN",
          this.variant.method,
        ),
      );
    }
  }

  private async barrier(): Promise<void> {
    await nextImmediate();
    for (const timer of this.timers.timers) {
      if (this.backoffTimers.has(timer) || sourceOf(timer) !== "backoff") {
        continue;
      }
      const waiting = this.inBackoff();
      this.backoffTimers.set(timer, waiting.length === 1 ? waiting[0].id : -1);
    }
  }

  /** The stranded read: observed, transiently failed, no try asked. */
  async strand(): Promise<void> {
    const failures: AnswerKind[] =
      this.retry === "app" ? ["transient", "transient"] : ["transient"];
    this.autoAnswers = this.variant.holdsData
      ? ["success", ...failures]
      : failures;
    this.context = "setup";
    this.mount();
    await this.barrier();
    if (this.variant.holdsData) {
      void this.client.refetchQueries({ queryKey: this.queryKey, exact: true });
      await this.barrier();
    }
    if (this.retry === "app") {
      this.fireBackoff();
      await this.barrier();
    }
    this.context = null;
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
        const inFlight = this.attempts.findLast(
          (a) => a.readId === readId && a.end === null,
        );
        // A read that holds data and whose attempt, which no sweep started, has
        // already failed a try, in backoff or on its retry, still shows its
        // failure: the sweep treats it as a failed read, cancels it and asks
        // again. A read with no data shows pending, and an attempt a sweep
        // started is claimed: a ring is owed to each.
        const failing =
          inFlight !== undefined &&
          !inFlight.sweepStarted &&
          (inFlight.backoff || inFlight.tries > 1) &&
          state.status === "error";
        arrival = failing ? "failed" : "flight";
        attempt = failing ? null : (inFlight?.id ?? null);
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

  /** The held backoff of the attempt that waits for it, if any. */
  private liveBackoff(): HeldTimer | undefined {
    const waiting = this.inBackoff().map((attempt) => attempt.id);
    return this.timers.pending().find((timer) => {
      const owner = this.backoffTimers.get(timer);
      return owner !== undefined && waiting.includes(owner);
    });
  }

  private fireBackoff(): void {
    const timer = this.liveBackoff();
    if (timer === undefined) throw new Error("no backoff is held");
    this.timers.fire(timer);
  }

  private pendingGc(): HeldTimer[] {
    return this.timers.pending().filter((timer) => sourceOf(timer) === "gc");
  }

  enabled(alphabet: readonly EventName[]): EventName[] {
    return alphabet.filter((event) => this.isEnabled(event));
  }

  private isEnabled(event: EventName): boolean {
    const pending = this.pending().length > 0;
    switch (event) {
      case "ring":
      case "replace":
        return true;
      case "startInsideError":
      case "startMicrotaskAfterError":
      case "ringMicrotaskAfterError":
        return pending && !this.armed.includes(event);
      case "endTransient":
      case "endNonTransient":
      case "endSuccess":
        return pending;
      default:
        return this.isEnabledByState(event);
    }
  }

  private isEnabledByState(event: EventName): boolean {
    switch (event) {
      case "cancelRevert":
        return this.client.isFetching() > 0;
      case "clear":
        return this.client.getQueryCache().getAll().length > 0;
      case "unobserve":
        return this.current() !== undefined && this.observed();
      case "gc":
        return this.pendingGc().length > 0;
      case "backoffEnds":
        return this.liveBackoff() !== undefined;
      default:
        // startElsewhere, remove and reset act on a read in the cache.
        return this.current() !== undefined;
    }
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
        this.answerOldest(event, "transient");
        break;
      case "endNonTransient":
        this.answerOldest(event, "nontransient");
        break;
      case "endSuccess":
        this.answerOldest(event, "success");
        break;
      case "cancelRevert":
        await this.cancelRevert();
        break;
      default:
        this.within(`test:${event}`, () => {
          this.runLifecycle(event);
        });
    }
    await this.barrier();
  }

  private async cancelRevert(): Promise<void> {
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
  }

  /** The events that remove, replace, reset or clear the read, drop its observer, or fire a held timer. */
  private runLifecycle(event: EventName): void {
    const exact = { queryKey: this.queryKey, exact: true };
    switch (event) {
      case "remove":
        this.unmount();
        this.client.removeQueries(exact);
        break;
      case "replace":
        this.unmount();
        this.client.removeQueries(exact);
        this.mount();
        break;
      case "reset":
        void this.client.resetQueries(exact);
        break;
      case "clear":
        this.unmount();
        this.client.clear();
        break;
      case "unobserve":
        this.unmount();
        break;
      case "gc":
        for (const timer of this.pendingGc()) this.timers.fire(timer);
        break;
      case "backoffEnds":
        this.fireBackoff();
        break;
      default:
        throw new Error(`${event} is not a lifecycle event`);
    }
  }

  private answerOldest(event: EventName, kind: AnswerKind): void {
    this.within(`test:${event}`, () => {
      const oldest = this.pending().at(0);
      if (oldest !== undefined) this.settle(oldest, kind);
    });
  }

  /** Ends every try still pending, and every backoff, as a transient failure, checking after each. */
  async settleAll(check: () => string | null): Promise<string | null> {
    for (let step = 0; step < 24; step += 1) {
      const oldest = this.pending().at(0);
      if (oldest !== undefined) {
        this.trace.push("endTransient");
        this.within("test:endTransient", () => {
          this.settle(oldest, "transient");
        });
      } else if (this.liveBackoff() !== undefined) {
        this.trace.push("backoffEnds");
        this.within("test:backoffEnds", () => {
          this.fireBackoff();
        });
      } else {
        return null;
      }
      await this.barrier();
      const found = check();
      if (found !== null) return found;
    }
    return null;
  }

  /** Each attempt and ring in order, for a failure message. */
  describe(): string {
    const standing = (a: Attempt): string => {
      if (a.end !== null)
        return `${a.end.kind} by ${a.end.context} @${a.end.at}`;
      return a.backoff ? "in backoff" : "pending";
    };
    const attempts = this.attempts.map(
      (a) =>
        `attempt${a.id}(read ${a.readId}, ${a.context}, @${a.start}, ${a.tries} tries, ${standing(a)})`,
    );
    const rings = this.rings.map(
      (r) =>
        `ring${r.n}(${r.arrival}, @${r.at}, attempt ${r.attempt ?? "none"})`,
    );
    return `${attempts.join(" ")} ${rings.join(" ")}`;
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
      this.observed() &&
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

  async dBarrier(): Promise<void> {
    await this.barrier();
  }

  /** Settles what the check just asked, as a transient failure, until nothing waits. */
  async finishTransiently(): Promise<void> {
    await this.settleAll(() => null);
  }

  /**
   * A backoff is expected while its attempt waits for it, and after that
   * attempt was cancelled: a retryer already settled has nothing left to
   * retry, so firing it does nothing and it is never fired.
   */
  private backoffIsExpected(timer: HeldTimer): boolean {
    const owner = this.attempts.at(this.backoffTimers.get(timer) ?? -1);
    if (owner === undefined) return false;
    return (
      (owner.backoff && owner.end === null) || owner.end?.kind === "aborted"
    );
  }

  /** (G) Nothing is held or scheduled that the harness does not expect. */
  unexpectedHold(): string | null {
    if (this.timers.scheduled.length > 0) {
      return `(G) notifyManager was handed ${this.timers.scheduled.length} callbacks`;
    }
    for (const timer of this.timers.pending()) {
      const source = sourceOf(timer);
      if (source === "gc" && timer.delay === GC_MS) continue;
      if (
        source === "stale" &&
        timer.kind === "timeout" &&
        timer.delay >= 0 &&
        timer.delay <= STALE_MS_MOST
      ) {
        continue;
      }
      if (source === "backoff" && this.backoffIsExpected(timer)) continue;
      return `(G) an unexpected ${timer.kind} (${source}, ${timer.delay} ms) is held`;
    }
    return null;
  }
}

/**
 * (A) No attempt is aborted outside a test cancel or a ring call, and a ring
 * aborts only an attempt that began before it.
 */
function checkAborts({ attempts, rings }: Rig): string | null {
  for (const attempt of attempts) {
    const end = attempt.end;
    if (end === null || end.kind !== "aborted") continue;
    if (end.context.startsWith("test:")) continue;
    if (end.context.startsWith("ring:")) {
      const ring = rings.at(Number(end.context.slice("ring:".length)));
      if (ring !== undefined && attempt.start < ring.at) continue;
      return `(A) attempt ${attempt.id} was aborted inside ${end.context}, which began before it`;
    }
    return `(A) attempt ${attempt.id} was aborted from a ${end.context} step`;
  }
  return null;
}

/**
 * (F) A ring never ends an attempt the sweep started itself, in flight or in
 * its retry backoff, and a ring that met one is owed to it.
 */
function checkOwnAttempts({ attempts }: Rig): string | null {
  for (const attempt of attempts) {
    const end = attempt.end;
    if (
      attempt.sweepStarted &&
      end !== null &&
      end.kind === "aborted" &&
      end.context.startsWith("ring:")
    ) {
      return `(F) ${end.context} ended attempt ${attempt.id}, which the sweep started`;
    }
  }
  return null;
}

/** (C) Attempts the sweep started for a read number at most the rings that reached it. */
function checkAskCounts({ attempts, rings }: Rig): string | null {
  const sweepAsks = new Map<number, number>();
  for (const attempt of attempts) {
    if (attempt.sweepStarted) {
      sweepAsks.set(attempt.readId, (sweepAsks.get(attempt.readId) ?? 0) + 1);
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

/**
 * (E) An attempt the sweep starts after its ring is legal only for an unspent
 * ring: one that arrived on a failed read, with no attempt started on that
 * read since; or one whose in-flight attempt ended transiently, with no
 * attempt started on that read between that end and this one.
 */
function checkSpends({ attempts, rings }: Rig): string | null {
  const spent = new Set<number>();
  for (const spend of attempts.filter((a) => a.context === "spend")) {
    const none = (since: number): boolean =>
      !attempts.some(
        (a) =>
          a.readId === spend.readId && a.start > since && a.start < spend.start,
      );
    const ring =
      rings.find((r) => {
        if (spent.has(r.n) || r.attempt === null) return false;
        const attempt = attempts.at(r.attempt);
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
      return `(E) sweep attempt ${spend.id} has no unspent ring it may spend`;
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
    if (rig.attempts.some((a) => a.readId === readId && a.start > ring.at)) {
      continue;
    }
    const attempt =
      ring.attempt === null ? undefined : rig.attempts[ring.attempt];
    if (ring.arrival === "flight") {
      if (attempt?.end?.kind !== "transient") continue;
    }
    return `(B) ring ${ring.n} (arrived ${ring.arrival}) is stranded: nothing was asked after it`;
  }
  return null;
}

export function checkAll(rig: Rig): string | null {
  return (
    rig.unexpectedHold() ??
    checkAborts(rig) ??
    checkOwnAttempts(rig) ??
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

export interface Counts {
  sequences: number;
  failures: Map<string, { first: Failure; total: number; sequences: string[] }>;
  skippedD: number;
}

interface Setting {
  readonly variant: Variant;
  readonly retry: RetryPolicy;
  readonly timers: HeldTimers;
}

async function runSequence(
  setting: Setting,
  choices: readonly number[],
  pass: Pass,
  counts: Counts,
): Promise<number[]> {
  const rig = new Rig(setting.variant, setting.retry, setting.timers);
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
      const options = rig
        .enabled(pass.alphabet)
        .filter(
          (event) => step > 0 || pass.firstEvents?.includes(event) !== false,
        );
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
  const before = rig.attempts.length;
  rig.dRing();
  await rig.dBarrier();
  if (rig.attempts.length !== before + 1) {
    return `(D1) a fresh ring made ${rig.attempts.length - before} asks, not 1`;
  }
  await rig.finishTransiently();
  if (rig.attempts.length !== before + 1) {
    return `(D1) the fresh ring's ask failed and ${rig.attempts.length - before - 1} more asks followed`;
  }
  rig.dStartElsewhere();
  await rig.dBarrier();
  await rig.finishTransiently();
  if (rig.attempts.length !== before + 2) {
    return `(D2) a refetch that failed with no ring was followed by ${rig.attempts.length - before - 2} asks`;
  }
  return null;
}

export async function explore(setting: Setting, pass: Pass): Promise<Counts> {
  const counts: Counts = { sequences: 0, failures: new Map(), skippedD: 0 };
  let choices: number[] = [];
  for (;;) {
    const widths = await runSequence(setting, choices, pass, counts);
    const taken = widths.map((_, step) => choices[step] ?? 0);
    let step = widths.length - 1;
    while (step >= 0 && (taken[step] ?? 0) + 1 >= (widths[step] ?? 0)) {
      step -= 1;
    }
    if (step < 0) return counts;
    choices = [...taken.slice(0, step), (taken[step] ?? 0) + 1];
  }
}

export function describeFailures(counts: Counts): string {
  return [...counts.failures.values()]
    .map(
      ({ first, total, sequences }) =>
        `${first.detail}\n    first sequence: ${first.sequence}\n    failing sequences: ${total} of ${counts.sequences}\n      ${sequences.slice(0, 400).join("\n      ")}`,
    )
    .join("\n");
}
