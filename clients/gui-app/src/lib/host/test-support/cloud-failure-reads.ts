import {
  QueryObserver,
  type QueryClient,
  type QueryObserverOptions,
} from "@tanstack/react-query";
import type { RpcErrorCode } from "@traycer/protocol/framework";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostQueryKeys } from "@/lib/query-keys";

export function hostFailure(code: RpcErrorCode, method: string): HostRpcError {
  return new HostRpcError({
    code,
    message: `${method} failed with ${code}`,
    requestId: "req-test",
    method,
    fatalDetails: null,
  });
}

/** `["host", hostId, method, { name }]`, the shape of every host RPC read. */
export function hostReadKey(
  hostId: string,
  method: string,
  name: string,
): readonly unknown[] {
  return [...hostQueryKeys.scope(hostId), method, { name }];
}

/**
 * One cached read with a scriptable answer and a count of how often it was
 * asked. Retries are off so one ask is one call, unless a subclass says
 * otherwise.
 */
export class ScriptedRead {
  calls = 0;
  private readonly observer: QueryObserver<string>;
  private unsubscribe: (() => void) | null;

  /** What the next ask answers. Swap it between asks. */
  answer: () => Promise<string>;

  constructor(
    private readonly client: QueryClient,
    readonly queryKey: readonly unknown[],
    firstAnswer: () => Promise<string>,
  ) {
    this.answer = firstAnswer;
    this.observer = new QueryObserver<string>(client, {
      queryKey: this.queryKey,
      ...this.retryOptions(),
      queryFn: () => {
        this.calls += 1;
        return this.answer();
      },
    });
    this.unsubscribe = this.observer.subscribe(() => undefined);
  }

  /** Retries are off, so one ask is one call. */
  protected retryOptions(): Pick<QueryObserverOptions<string>, "retry"> {
    return { retry: false };
  }

  /** Stops observing. The cached entry stays, inactive. */
  release(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  get state() {
    const query = this.client.getQueryCache().find({ queryKey: this.queryKey });
    if (query === undefined) throw new Error("read is not cached");
    return query.state;
  }
}

export const resolves =
  (value: string): (() => Promise<string>) =>
  () =>
    Promise.resolve(value);

export const rejects =
  (error: Error): (() => Promise<string>) =>
  () =>
    Promise.reject(error);

/** An answer that stays open until `release` is called. */
export function heldAnswer(value: string): {
  readonly answer: () => Promise<string>;
  readonly release: () => void;
} {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { answer: () => gate.then(() => value), release };
}

/** An answer that fails with `error` once `release` is called. */
export function heldFailure(error: Error): {
  readonly answer: () => Promise<string>;
  readonly release: () => void;
} {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { answer: () => gate.then(() => Promise.reject(error)), release };
}

/**
 * A `ScriptedRead` under the app's own retry policy: a failed try waits out
 * TanStack's backoff and tries once more, and each try is one call.
 */
export class RetryingRead extends ScriptedRead {
  protected override retryOptions(): Pick<
    QueryObserverOptions<string>,
    "retry"
  > {
    return {};
  }
}
