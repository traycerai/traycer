import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A service controller has many platform-specific actuator edges. Command
 * facades establish this scope once, while platform code consumes it again
 * immediately before each write, deletion, subprocess, or signal. Legacy
 * callers intentionally run without a scope; they retain the pre-cutover
 * execution path and cannot accidentally receive a stale contender token.
 */
const mutationAuthority = new AsyncLocalStorage<() => Promise<void>>();
const authorityFailures = new WeakSet<object>();

export class ServiceMutationAuthorityError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("service mutation authority was lost");
    this.name = "ServiceMutationAuthorityError";
    this.cause = cause;
  }
}

export function isServiceMutationAuthorityError(cause: unknown): boolean {
  return (
    cause instanceof ServiceMutationAuthorityError ||
    (typeof cause === "object" &&
      cause !== null &&
      authorityFailures.has(cause))
  );
}

export async function withServiceMutationAuthority<T>(
  verify: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  return mutationAuthority.run(verify, async () => {
    await verifyServiceMutationAuthority();
    try {
      return await run();
    } catch (cause) {
      // A composite may fail inside a publisher, retry hook, or platform
      // controller after its first verifier but before the next explicit
      // actuator check. Re-probe before surfacing the original error: if the
      // capability disappeared, callers must park/abort rather than swallow
      // it as an ordinary post-swap warning and continue a stale sequence.
      await verifyServiceMutationAuthority();
      throw cause;
    }
  });
}

export async function verifyServiceMutationAuthority(): Promise<void> {
  const verify = mutationAuthority.getStore();
  if (verify === undefined) return;
  try {
    await verify();
  } catch (cause) {
    if (typeof cause === "object" && cause !== null) {
      authorityFailures.add(cause);
      throw cause;
    }
    throw new ServiceMutationAuthorityError(cause);
  }
}
