import { readHostLoginItemStatus } from "../app/host-login-item";
import { readHostServiceOwner } from "./host-owner";
import type { HostFsLayout } from "./host-paths";
import {
  withDesktopUpdateContender,
  type DesktopUpdateContenderOutcome,
} from "./update-contender";
import { writeSubstrateOwnerWithAttempt } from "./update-mutation";

/**
 * Unconditional healthy-launch ownership backfill (technical plan §3.1.
 * Tying the write to a register cycle would never fire on exactly those machines: the routine healthy launch does not re-register.
 */
export type SubstrateBackfillOutcome =
  | { readonly kind: "committed" }
  /** A recognised owner is already recorded; nothing to do. */
  | { readonly kind: "already-recorded" }
  /** The login item is not in a state that attests Desktop ownership. */
  | { readonly kind: "not-attested"; readonly status: string }
  /** A takeover is in flight, or the record is faulted. Do not overwrite. */
  | { readonly kind: "deferred"; readonly cause: string }
  | {
      readonly kind: "refused";
      readonly outcome: Exclude<
        DesktopUpdateContenderOutcome<void>,
        { readonly kind: "acquired" }
      >;
    };

export interface SubstrateBackfillOptions {
  readonly layout: HostFsLayout;
  readonly lockPath: string;
  readonly waitMs: number;
  readonly pollIntervalMs: number;
  readonly agentLabelId: string;
  readonly cliLabelId: string;
}

export async function backfillSubstrateOwnerAtLaunch(
  options: SubstrateBackfillOptions,
): Promise<SubstrateBackfillOutcome> {
  const status = readHostLoginItemStatus();
  if (status !== "enabled" && status !== "requires-approval") {
    return { kind: "not-attested", status };
  }

  const preRead = await readHostServiceOwner(
    options.layout,
    { agentLabelId: options.agentLabelId, cliLabelId: options.cliLabelId },
    { kind: "unavailable" },
  );
  if (preRead.kind === "owned" && preRead.substrate === "smappservice") {
    return { kind: "already-recorded" };
  }

  const outcome = await withDesktopUpdateContender(
    {
      hostHomeDir: options.layout.rootDir,
      lockPath: options.lockPath,
      reason: "desktop-launch-substrate-backfill",
      waitMs: options.waitMs,
      pollIntervalMs: options.pollIntervalMs,
      admission: "desktop-activation-maintenance",
    },
    async (capability): Promise<SubstrateBackfillOutcome> => {
      const owner = await readHostServiceOwner(
        options.layout,
        { agentLabelId: options.agentLabelId, cliLabelId: options.cliLabelId },
        { kind: "unavailable" },
      );
      if (owner.kind === "owned") {
        // Already `raw-fallback` - do NOT overwrite: the CLI writes that only after a positively attested takeover, and a live login item can coexist with it (`hostManagesHostLoginItem()`.
        // Retiring a raw substrate is the register cycle's job, under its own attestation, not a launch-time backfill's.
        return owner.substrate === "smappservice"
          ? { kind: "already-recorded" }
          : { kind: "deferred", cause: "raw-fallback-recorded" };
      }
      if (owner.cause !== "substrate-absent") {
        return { kind: "deferred", cause: owner.cause };
      }
      await writeSubstrateOwnerWithAttempt(
        capability,
        options.layout,
        "smappservice",
        `healthy-launch-backfill:${status}`,
      );
      return { kind: "committed" };
    },
  );

  return outcome.kind === "acquired"
    ? outcome.result
    : { kind: "refused", outcome };
}
