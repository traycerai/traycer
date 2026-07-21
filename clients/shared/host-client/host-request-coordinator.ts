import {
  getLatestContract,
  type VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import type {
  HostRequestAuthority,
  RequestOfMethod,
  ResponseOfMethod,
} from "../host-transport/host-messenger";
import type {
  RpcSchedulingMode,
  RpcSchedulingPolicy,
} from "./rpc-scheduling-policy";

export type HostRequestControlFlowReason =
  "waiter-cancelled" | "authority-superseded" | "coordinator-disposed";

/** Expected local request control flow, deliberately distinct from HostRpcError. */
export class HostRequestControlFlowError extends Error {
  readonly reason: HostRequestControlFlowReason;

  constructor(reason: HostRequestControlFlowReason) {
    super(`Host request ${reason.replaceAll("-", " ")}`);
    this.name = "HostRequestControlFlowError";
    this.reason = reason;
  }
}

export function isHostRequestControlFlowError(
  error: unknown,
): error is HostRequestControlFlowError {
  return error instanceof HostRequestControlFlowError;
}

/** Exact GUI authority identity used for latest-tail replacement decisions. */
export interface HostRequestAuthorityDomain {
  readonly bindingToken: object;
  readonly requestContext: object;
}

export interface HostRequestCoordinatorOptions<
  Registry extends VersionedRpcRegistry,
> {
  readonly registry: Registry;
  readonly schedulingPolicy: RpcSchedulingPolicy<Registry>;
}

/** Opaque snapshot of read jobs superseded by one host/context transition. */
export interface HostTransitionAbortSnapshot {
  readonly token: object;
}

export interface HostRequestSubmission<
  Registry extends VersionedRpcRegistry,
  Method extends keyof Registry & string,
> {
  readonly hostId: string;
  readonly userId: string;
  readonly method: Method;
  readonly params: RequestOfMethod<Registry, Method>;
  readonly authority: HostRequestAuthority;
  readonly authorityDomain: HostRequestAuthorityDomain;
  readonly signal: AbortSignal | undefined;
  readonly execute: (
    authority: HostRequestAuthority,
  ) => Promise<ResponseOfMethod<Registry, Method>>;
}

interface HostRequestWaiter<Response> {
  readonly promise: Promise<Response>;
  readonly signal: AbortSignal | undefined;
  settled: boolean;
  resolve(value: Response): void;
  reject(reason: unknown): void;
  detachAbortListener(): void;
}

interface HostRequestJob {
  readonly mode: RpcSchedulingMode;
  readonly authority: HostRequestAuthority;
  readonly authorityDomain: HostRequestAuthorityDomain;
  readonly controller: AbortController;
  readonly execute: (authority: HostRequestAuthority) => Promise<unknown>;
  readonly waiters: Set<HostRequestWaiter<never>>;
  started: boolean;
}

interface HostRequestQueue {
  active: HostRequestJob | null;
  readonly queued: HostRequestJob[];
}

interface HostTransitionJobSnapshot {
  readonly key: string;
  readonly queue: HostRequestQueue;
  readonly job: HostRequestJob;
}

/**
 * Renderer-local coordinator for unary RPCs. It deliberately owns no cache,
 * directory, or transport state: callers capture authority and provide the
 * frozen raw dispatch closure for every submitted job.
 */
export class HostRequestCoordinator<Registry extends VersionedRpcRegistry> {
  private readonly registry: Registry;
  private readonly schedulingPolicy: RpcSchedulingPolicy<Registry>;
  private readonly queues = new Map<string, HostRequestQueue>();
  private readonly transitionSnapshots = new Map<
    object,
    readonly HostTransitionJobSnapshot[]
  >();
  private readonly disposalController = new AbortController();
  private disposed = false;

  constructor(options: HostRequestCoordinatorOptions<Registry>) {
    this.registry = options.registry;
    this.schedulingPolicy = options.schedulingPolicy;
  }

  request<Method extends keyof Registry & string>(
    submission: HostRequestSubmission<Registry, Method>,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    if (this.disposed) {
      return Promise.reject(
        new HostRequestControlFlowError("coordinator-disposed"),
      );
    }

    const key = this.keyFor(
      submission.method,
      submission.params,
      submission.hostId,
      submission.userId,
    );
    const mode = this.schedulingPolicy.modeFor(
      submission.method,
      submission.params,
    );
    const waiter = createWaiter<ResponseOfMethod<Registry, Method>>(
      submission.signal,
    );
    if (waiter.settled) {
      return waiter.promise;
    }

    const queue = this.queues.get(key) ?? { active: null, queued: [] };
    this.queues.set(key, queue);
    const job = this.selectJob(queue, mode, submission.authorityDomain);
    if (job !== null) {
      this.attachWaiter(key, queue, job, waiter);
      return waiter.promise;
    }

    const next = this.createJob(mode, submission);
    this.attachWaiter(key, queue, next, waiter);
    this.enqueue(queue, next);
    this.drain(key, queue);
    return waiter.promise;
  }

  /**
   * Captures the read jobs that existed when a host/context transition began.
   * The caller must later apply this snapshot after cancelling that host's
   * Query scope, so work submitted while cancellation is in flight is spared.
   */
  snapshotHostTransition(hostId: string): HostTransitionAbortSnapshot {
    const token = {};
    const jobs: HostTransitionJobSnapshot[] = [];
    for (const [key, queue] of this.queues) {
      if (!key.startsWith(`[${JSON.stringify(hostId)},`)) {
        continue;
      }
      if (queue.active !== null && queue.active.mode !== "fifo") {
        jobs.push({ key, queue, job: queue.active });
      }
      for (const job of queue.queued) {
        if (job.mode !== "fifo") {
          jobs.push({ key, queue, job });
        }
      }
    }
    this.transitionSnapshots.set(token, jobs);
    return { token };
  }

  /**
   * Settles only the transition snapshot: FIFO commands are never captured,
   * and reads submitted after the transition began cannot be aborted here.
   */
  abortHostTransition(snapshot: HostTransitionAbortSnapshot): void {
    const jobs = this.transitionSnapshots.get(snapshot.token);
    if (jobs === undefined) {
      return;
    }
    this.transitionSnapshots.delete(snapshot.token);
    for (const { key, queue, job } of jobs) {
      if (queue.active === job) {
        this.settleJobControlFlow(job, "authority-superseded");
        job.controller.abort("host-authority-replaced");
      } else if (queue.queued.includes(job)) {
        this.settleJobControlFlow(job, "authority-superseded");
        removeFromArray(queue.queued, job);
      }
      this.removeQueueWhenDrained(key, queue);
    }
  }

  /** Applies the safe transition behavior immediately for direct callers. */
  abortHost(hostId: string): void {
    this.abortHostTransition(this.snapshotHostTransition(hostId));
  }

  /**
   * Cancels one active read after its exact TanStack Query was cancelled.
   * Unlike a host transition, this deliberately frees the current key's raw
   * slot so a just-invalidated latest tail can issue fresh data.
   */
  cancelActiveRead<Method extends keyof Registry & string>(
    hostId: string,
    userId: string,
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): void {
    const key = this.keyFor(method, params, hostId, userId);
    const active = this.queues.get(key)?.active;
    if (active === null || active === undefined || active.mode === "fifo") {
      return;
    }
    this.settleJobControlFlow(active, "waiter-cancelled");
    active.controller.abort("query-read-cancelled");
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposalController.abort("host-request-coordinator-disposed");
    this.transitionSnapshots.clear();
    for (const queue of this.queues.values()) {
      if (queue.active !== null) {
        queue.active.controller.abort("host-request-coordinator-disposed");
        this.settleJobControlFlow(queue.active, "coordinator-disposed");
      }
      this.supersedeQueuedJobs(queue, "coordinator-disposed");
    }
    this.queues.clear();
  }

  /** Exposed for deterministic coordinator tests; no key content is logged. */
  schedulingKeyFor<Method extends keyof Registry & string>(
    hostId: string,
    userId: string,
    method: Method,
    params: RequestOfMethod<Registry, Method>,
  ): string {
    return this.keyFor(method, params, hostId, userId);
  }

  private keyFor<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    hostId: string,
    userId: string,
  ): string {
    const contract = getLatestContract(this.registry[method], undefined);
    const parsed = contract.requestSchema.parse(params);
    return JSON.stringify([hostId, userId, method, stableWireJson(parsed)]);
  }

  private selectJob(
    queue: HostRequestQueue,
    mode: RpcSchedulingMode,
    domain: HostRequestAuthorityDomain,
  ): HostRequestJob | null {
    if (mode === "fifo") {
      return null;
    }
    if (mode === "latest") {
      const tail = queue.queued[0];
      if (tail === undefined) {
        return null;
      }
      if (sameAuthorityDomain(tail.authorityDomain, domain)) {
        return tail;
      }
      this.settleJobControlFlow(tail, "authority-superseded");
      queue.queued.length = 0;
      return null;
    }

    if (
      queue.active !== null &&
      sameAuthorityDomain(queue.active.authorityDomain, domain)
    ) {
      return queue.active;
    }
    const tail = queue.queued.at(-1);
    return tail !== undefined &&
      sameAuthorityDomain(tail.authorityDomain, domain)
      ? tail
      : null;
  }

  private createJob<Method extends keyof Registry & string>(
    mode: RpcSchedulingMode,
    submission: HostRequestSubmission<Registry, Method>,
  ): HostRequestJob {
    return {
      mode,
      authority: submission.authority,
      authorityDomain: submission.authorityDomain,
      controller: new AbortController(),
      execute: submission.execute,
      waiters: new Set(),
      started: false,
    };
  }

  private enqueue(queue: HostRequestQueue, job: HostRequestJob): void {
    queue.queued.push(job);
  }

  private attachWaiter<Response>(
    key: string,
    queue: HostRequestQueue,
    job: HostRequestJob,
    waiter: HostRequestWaiter<Response>,
  ): void {
    const erasedWaiter = waiter as HostRequestWaiter<never>;
    job.waiters.add(erasedWaiter);
    if (waiter.signal === undefined) {
      return;
    }
    const abort = (): void => {
      this.settleWaiterControlFlow(erasedWaiter, "waiter-cancelled");
      job.waiters.delete(erasedWaiter);
      if (!job.started && job.waiters.size === 0 && job.mode !== "fifo") {
        removeFromArray(queue.queued, job);
        this.removeQueueWhenDrained(key, queue);
        return;
      }
      if (job.started && job.waiters.size === 0 && job.mode !== "fifo") {
        job.controller.abort("last-cancelable-waiter-detached");
      }
    };
    waiter.signal.addEventListener("abort", abort, { once: true });
    const detach = waiter.detachAbortListener;
    waiter.detachAbortListener = (): void => {
      waiter.signal?.removeEventListener("abort", abort);
      detach();
    };
    if (waiter.signal.aborted) {
      abort();
    }
  }

  private drain(key: string, queue: HostRequestQueue): void {
    if (this.disposed || queue.active !== null) {
      return;
    }
    const job = queue.queued.shift();
    if (job === undefined) {
      this.removeQueueWhenDrained(key, queue);
      return;
    }
    queue.active = job;
    job.started = true;
    const combined = combineAbortSignals([
      job.authority.abortSignal,
      this.disposalController.signal,
      job.controller.signal,
    ]);
    const authority: HostRequestAuthority = {
      ...job.authority,
      abortSignal: combined.signal,
    };
    void job
      .execute(authority)
      .then((value) => {
        for (const waiter of job.waiters) {
          this.settleWaiterSuccess(waiter, value as never);
        }
      })
      .catch((error: unknown) => {
        for (const waiter of job.waiters) {
          this.settleWaiterError(waiter, error);
        }
      })
      .finally(() => {
        combined.dispose();
        job.waiters.clear();
        if (queue.active === job) {
          queue.active = null;
        }
        this.drain(key, queue);
      });
  }

  private settleJobControlFlow(
    job: HostRequestJob,
    reason: HostRequestControlFlowReason,
  ): void {
    for (const waiter of job.waiters) {
      this.settleWaiterControlFlow(waiter, reason);
    }
    job.waiters.clear();
  }

  private supersedeQueuedJobs(
    queue: HostRequestQueue,
    reason: HostRequestControlFlowReason,
  ): void {
    for (const job of queue.queued) {
      this.settleJobControlFlow(job, reason);
    }
    queue.queued.length = 0;
  }

  private settleWaiterSuccess(
    waiter: HostRequestWaiter<never>,
    value: never,
  ): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    waiter.detachAbortListener();
    waiter.resolve(value);
  }

  private settleWaiterError(
    waiter: HostRequestWaiter<never>,
    error: unknown,
  ): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    waiter.detachAbortListener();
    waiter.reject(error);
  }

  private settleWaiterControlFlow(
    waiter: HostRequestWaiter<never>,
    reason: HostRequestControlFlowReason,
  ): void {
    this.settleWaiterError(waiter, new HostRequestControlFlowError(reason));
  }

  private removeQueueWhenDrained(key: string, queue: HostRequestQueue): void {
    if (queue.active === null && queue.queued.length === 0) {
      this.queues.delete(key);
    }
  }
}

function createWaiter<Response>(
  signal: AbortSignal | undefined,
): HostRequestWaiter<Response> {
  let resolvePromise: (value: Response) => void = () => undefined;
  let rejectPromise: (reason: unknown) => void = () => undefined;
  const waiter: HostRequestWaiter<Response> = {
    promise: new Promise<Response>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    signal,
    settled: false,
    resolve: (value) => resolvePromise(value),
    reject: (reason) => rejectPromise(reason),
    detachAbortListener: () => undefined,
  };
  if (signal?.aborted) {
    waiter.settled = true;
    waiter.reject(new HostRequestControlFlowError("waiter-cancelled"));
  }
  return waiter;
}

function stableWireJson(value: unknown): string {
  return JSON.stringify(normalizeWireValue(value, new Set()));
}

function normalizeWireValue(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "Host request params must contain finite JSON numbers",
      );
    }
    return value;
  }
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new TypeError("Host request params must be JSON wire values");
  }
  if (typeof value !== "object") {
    throw new TypeError("Host request params must be JSON wire values");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Host request params cannot contain cycles");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => {
        const normalized = normalizeWireValue(entry, ancestors);
        return normalized === undefined ? null : normalized;
      });
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new TypeError(
        "Host request params must contain plain JSON objects",
      );
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .flatMap((key) => {
          const normalized = normalizeWireValue(
            Reflect.get(value, key),
            ancestors,
          );
          return normalized === undefined ? [] : [[key, normalized]];
        }),
    );
  } finally {
    ancestors.delete(value);
  }
}

function sameAuthorityDomain(
  left: HostRequestAuthorityDomain,
  right: HostRequestAuthorityDomain,
): boolean {
  return (
    left.bindingToken === right.bindingToken &&
    left.requestContext === right.requestContext
  );
}

function removeFromArray<Value>(values: Value[], value: Value): void {
  const index = values.indexOf(value);
  if (index !== -1) {
    values.splice(index, 1);
  }
}

function combineAbortSignals(signals: readonly AbortSignal[]): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of signals) {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
