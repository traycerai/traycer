export type StartConfirmation =
  | { readonly kind: "running" }
  | { readonly kind: "stopped" }
  | { readonly kind: "unknown" }
  | { readonly kind: "supervisor-relaunching"; readonly supervisorPid: number };

export type ServiceStartOutcome =
  | { readonly kind: "started" }
  | Extract<StartConfirmation, { readonly kind: "supervisor-relaunching" }>;

/**
 * A request without a successful observation can be retried once, and only
 * with positive evidence that the old instance has left and nothing started.
 */
export async function confirmStartOrRetry(
  observation: StartConfirmation,
  retry: () => Promise<void>,
  failure: unknown,
): Promise<ServiceStartOutcome> {
  switch (observation.kind) {
    case "running":
      return { kind: "started" };
    case "stopped":
      await retry();
      return { kind: "started" };
    case "supervisor-relaunching":
      return observation;
    case "unknown":
      throw failure;
  }
}
