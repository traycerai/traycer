import type { MutationScope } from "@tanstack/react-query";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

const UNRESOLVED_HOST = "unresolved-host";

/**
 * The per-provider native-subagents switch's queue, keyed by host AND harness
 * because the resource is one provider's entry in `provider-overrides.json`,
 * not the whole file - the same shape, and the same reason, as
 * `providerAutoJudgeWriteScope`: without it two rapid flips on one row sit in
 * two coordinator queues and race, and the host can end up holding the older
 * choice while the `providers.list` invalidation faithfully reports it back.
 */
export function providerNativeSubagentsWriteScope(
  hostId: string | null,
  harnessId: GuiHarnessId,
): MutationScope {
  return {
    id: `providers.setNativeSubagents:${hostId ?? UNRESOLVED_HOST}:${harnessId}`,
  };
}
