import type { MutationScope } from "@tanstack/react-query";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

const UNRESOLVED_HOST = "unresolved-host";

/**
 * The per-provider native-memory switch's queue, keyed by host AND harness
 * because the resource is one provider's entry in `provider-overrides.json`,
 * not the whole file - the same shape, and the same reason, as
 * `providerNativeSubagentsWriteScope`: without it two rapid flips on one row
 * sit in two coordinator queues and race, and the host can end up holding the
 * older choice while the `providers.list` invalidation faithfully reports it
 * back.
 *
 * A scope of its OWN rather than shared with the subagents switch: the two are
 * different fields of the same row, so serializing them against each other
 * would make one switch wait on the other's write for no ordering that
 * matters, while giving them one id would be a lie about what they contend
 * for.
 */
export function providerNativeMemoryWriteScope(
  hostId: string | null,
  harnessId: GuiHarnessId,
): MutationScope {
  return {
    id: `providers.setNativeMemory:${hostId ?? UNRESOLVED_HOST}:${harnessId}`,
  };
}
