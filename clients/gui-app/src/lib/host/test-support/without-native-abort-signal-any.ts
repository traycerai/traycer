/**
 * Runs `run` on a platform whose `AbortSignal` has no native `any` (iOS before
 * 17.4), then puts the descriptor back whatever `run` does. No constructor is
 * spoofed: only the one static is hidden.
 */
export async function withoutNativeAbortSignalAny<T>(
  run: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  Object.defineProperty(AbortSignal, "any", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    return await run();
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(AbortSignal, "any");
    else Object.defineProperty(AbortSignal, "any", descriptor);
  }
}
