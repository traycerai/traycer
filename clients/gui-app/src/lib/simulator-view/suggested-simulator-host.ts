/**
 * The machine a surface that opens simulators starts on: this one while it
 * can serve and run simulators, so the tile streams from the person's own
 * machine, else the task's host, else this one anyway.
 */
export function suggestedSimulatorHostId(args: {
  readonly servingLocalHostId: string | null;
  readonly localHostRunsSimulators: boolean;
  readonly taskHostId: string | null;
}): string | null {
  if (args.servingLocalHostId !== null && args.localHostRunsSimulators)
    return args.servingLocalHostId;
  return args.taskHostId ?? args.servingLocalHostId;
}
