import { readHostLoginItemStatus } from "../app/host-login-item";
import { readHostServiceOwner } from "./host-owner";
import type { HostFsLayout } from "./host-paths";
import {
  withDesktopUpdateContender,
  type DesktopUpdateContenderOutcome,
} from "./update-contender";
import { writeSubstrateOwnerWithAttempt } from "./update-mutation";

/**
 * Unconditional healthy-launch ownership backfill (technical plan §3.1;
 * synthesis, "Desktop must backfill `smappservice` on every healthy launch
 * with an enabled or requires-approval login item, not only after
 * registration").
 *
 * ## Why it cannot wait for a successful register
 *
 * `substrate.json` has a schema, a path and a total decoder, but on the
 * installed base **nothing has ever written it** - the only `writeSubstrate`
 * in the tree belongs to the parked transition store. So absent is the
 * universal case, and a machine that has been happily SMAppService-owned for
 * months reports `unknown` until something commits the fact. Tying the write
 * to a register cycle would never fire on exactly those machines: the routine
 * healthy launch does not re-register.
 *
 * ## Why `requires-approval` commits the same value as `enabled`
 *
 * The agent IS registered in both; `requires-approval` only means the user
 * has the login item toggled off in System Settings. Desktop is still the
 * owner, and activation simply cannot finish until they re-enable it. Reading
 * that state as "not owned" would let a contender conclude the CLI owns
 * launchd and bootstrap a second job beside the SMAppService record.
 *
 * Every other status writes NOTHING and leaves the previous valid owner
 * standing: `not-registered`, `not-found`, `not-supported` are failures to
 * register, not evidence of raw ownership, and `deferred-busy` /
 * `removed-by-user` never ran a cycle at all.
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

  // Read BEFORE taking the lock only to skip the common no-op cheaply. The
  // decision that matters is re-made under the capability below: a contender
  // that won the lock in between may have committed a takeover, and this
  // pre-read must never be what authorizes the write.
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
        // Already `smappservice` - nothing to do. Already `raw-fallback` -
        // do NOT overwrite: the CLI writes that only after a positively
        // attested takeover, and a live login item can coexist with it
        // (`hostManagesHostLoginItem()` stays true on a machine the CLI took
        // over, which is the whole reason capability is not the owner fact).
        // Retiring a raw substrate is the register cycle's job, under its own
        // attestation, not a launch-time backfill's.
        return owner.substrate === "smappservice"
          ? { kind: "already-recorded" }
          : { kind: "deferred", cause: "raw-fallback-recorded" };
      }
      // Fail closed BY CONSTRUCTION: `substrate-absent` is the only cause
      // that authorizes a write (the installed-base migration case). A
      // faulted or contradicted record is diagnosable evidence — silently
      // replacing it with a fresh claim would destroy the only trace of how
      // the machine got into that state — and a cause added later to
      // `HostServiceOwnerUnknownCause` defers instead of falling through an
      // enumerated deferral list into the commit.
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
