const sentTo = Symbol.for("traycer.hostRpcFailurePeer");

/** Records the peer that refused the request or was the target of a local refusal. */
export function recordHostOfFailedCall(error: unknown, hostId: string): void {
  if (typeof error !== "object" || error === null) return;
  try {
    Reflect.defineProperty(error, sentTo, {
      value: hostId,
      configurable: true,
    });
  } catch {
    // A proxy can refuse attribution. Preserve the original failure.
  }
}

export function hostOfFailedCall(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  try {
    const peer: unknown = Reflect.get(error, sentTo);
    return typeof peer === "string" ? peer : null;
  } catch {
    return null;
  }
}
