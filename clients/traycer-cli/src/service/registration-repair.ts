import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whether a service install runs as the EXPLICIT REPAIR a person asked for -
 * `traycer host service install`, typed at a terminal or pressed as Doctor's
 * Register service - rather than as part of something else.
 *
 * Only that repair may turn a registration its owner switched off back on
 * (Windows: write `<Settings><Enabled>true</Enabled>` over a task disabled in
 * Task Scheduler). Every other install - the re-registration inside
 * `host install`, `host apply`, `host update` and `host ensure` - carries the
 * owner's setting over and starts nothing, because the setting is theirs.
 *
 * Request-scoped, the same shape as `mutation-authority.ts` and
 * `spawn-edge.ts`: the command arms it around its own controller call, and
 * outside that scope the answer is `false`. So the safe behaviour is the
 * default, and a new caller has to opt in to the repair rather than remember
 * to opt out of it.
 */
const explicitRepairScope = new AsyncLocalStorage<true>();

export function runAsExplicitRegistrationRepair<T>(
  fn: () => Promise<T>,
): Promise<T> {
  return explicitRepairScope.run(true, fn);
}

export function isExplicitRegistrationRepair(): boolean {
  return explicitRepairScope.getStore() === true;
}

/**
 * What a service install learned from its OWN ownership read, for the caller
 * that reports on it: whether it carried a registration its owner disabled
 * over (Windows: re-registered the task disabled and started nothing). Carried
 * out of the install rather than read again afterwards, so the report is the
 * fact the install acted on and costs no second `/Query /XML`.
 */
export interface ServiceInstallReport {
  readonly keptDisabled: boolean;
}

interface ServiceInstallReportSlot {
  keptDisabled: boolean;
}

const installReportScope = new AsyncLocalStorage<ServiceInstallReportSlot>();

export async function withServiceInstallReport(
  fn: () => Promise<void>,
): Promise<ServiceInstallReport> {
  const slot: ServiceInstallReportSlot = { keptDisabled: false };
  await installReportScope.run(slot, fn);
  return { keptDisabled: slot.keptDisabled };
}

/** Called by an install that kept its owner's disabled registration. */
export function reportServiceInstallKeptDisabled(): void {
  const slot = installReportScope.getStore();
  if (slot !== undefined) slot.keptDisabled = true;
}
