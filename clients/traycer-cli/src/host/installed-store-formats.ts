/**
 * The INSTALLED side's operands for the store-format floor, from one read of
 * `install.json` and the tree it points at.
 *
 * Separate from `store-format-floor.ts` for two reasons that both matter.
 * `installer/install.ts` already imports the floor, so a sidecar read placed
 * there would close an import cycle. And the floor takes these as INPUTS
 * rather than fetching them, which is what lets its own suites run against a
 * temp host home without ever touching the developer's real `~/.traycer`.
 */
import { dirname, isAbsolute } from "node:path";
import type { HostStoreFormats } from "@traycer/protocol/host/store-formats";
import { readExtractedStoreFormats } from "../installer/version-sidecar";
import {
  readHostInstallRecord,
  type HostInstallRecord,
} from "../manifest/host-install";
import { errorFromUnknown, type ILogger } from "../logger";
import type { Environment } from "../runner/environment";

export interface InstalledFloorOperands {
  /** `install.json`'s version, or `null` when nothing is installed. */
  readonly version: string | null;
  /**
   * What the installed TREE declares it writes, from its runtime
   * `version.json`, or `null` when it declares nothing.
   *
   * This is the half that makes the floor's no-disk-walk shortcut work for a
   * build the release ladder cannot place. A locally packaged install is
   * stamped `<target>.<epochMs>.<sha>` and a `--from` install
   * `local-<basename>-<timestamp>`; the fixed table can place neither, so
   * without the declaration every convergence onto such a machine - forward
   * and sideways included - walks the disk, and one unreadable store there
   * turns a move that could not lose anything into a refusal.
   */
  readonly storeFormats: HostStoreFormats | null;
}

/**
 * Both operands, collapsing every unreadable state to "nothing known".
 *
 * `null` is the CONSERVATIVE answer, which is why the strict reader's throw is
 * swallowed rather than propagated: `storeFloorApplicability` treats a null
 * install as "evaluate", so a corrupt record walks the epics instead of
 * skipping the gate. Refusing the whole command over an unreadable record
 * would be the wrong trade in the other direction - a corrupt `install.json`
 * is exactly when someone is reinstalling.
 */
export async function readInstalledFloorOperands(
  environment: Environment,
  logger: ILogger,
): Promise<InstalledFloorOperands> {
  let record: HostInstallRecord | null;
  try {
    record = await readHostInstallRecord(environment);
  } catch (err) {
    logger.warn(
      "Host store-format floor could not read the install record; evaluating as if nothing were installed",
      {
        environment,
        errorName: errorFromUnknown(err).name,
        errorMessage: errorFromUnknown(err).message,
      },
    );
    return { version: null, storeFormats: null };
  }
  if (record === null) return { version: null, storeFormats: null };
  return {
    version: record.version,
    storeFormats: await readInstalledDeclaration(record, environment, logger),
  };
}

/**
 * The installed tree's own declaration, or `null` for every way of not getting
 * one.
 *
 * Guarded for the same reason the record read above is, and the guard belongs
 * here rather than at the caller: this function's whole contract is that it
 * answers with "nothing known" instead of failing, and a throw escaping it
 * would take down `host ensure` - a command whose entire job is to converge a
 * machine back to a working host. The conservative answer is `null`, which
 * costs a disk walk and never a wrong verdict.
 *
 * `readExtractedStoreFormats` does not throw by contract, but the path
 * derivation ahead of it can: a record whose `executablePath` is absent is
 * outside `HostInstallRecord`'s type, yet it is exactly what a truncated or
 * hand-edited `install.json` looks like on the machine that most needs this
 * command to work.
 */
export async function readInstalledDeclaration(
  record: HostInstallRecord,
  environment: Environment,
  logger: ILogger,
): Promise<HostStoreFormats | null> {
  // Only an ABSOLUTE executable path names a runtime directory. The record
  // schema admits any string, and `dirname("")` is `"."` - so a truncated or
  // hand-edited `install.json` would make this read `version.json` out of the
  // CLI's CURRENT WORKING DIRECTORY and report a stray file as what the
  // installed tree declares. That is not a missing declaration, it is an
  // invented one, and it is the operand the floor clears moves with: a
  // fabricated `chatDb: 8` clears a target the stores on disk would refuse.
  //
  // The host's own reader guards this identically (`host-status-install.ts`);
  // this is the CLI counterpart, and every installed-side read goes through
  // here so the two ends cannot diverge.
  try {
    // INSIDE the try, deliberately. A record whose `executablePath` is absent
    // is outside `HostInstallRecord`'s type but is exactly what a truncated
    // `install.json` looks like, and `isAbsolute(undefined)` throws - the
    // same throw the catch below already existed to absorb.
    if (!isAbsolute(record.executablePath)) {
      logger.warn(
        "Host store-format floor: the install record's executable path is not absolute, so the installed tree declares nothing",
        { environment },
      );
      return null;
    }
    return await readExtractedStoreFormats(
      dirname(record.executablePath),
      environment,
      logger,
    );
  } catch (err) {
    logger.warn(
      "Host store-format floor could not read the installed tree's declaration; resolving the installed side from the version table alone",
      {
        environment,
        errorName: errorFromUnknown(err).name,
        errorMessage: errorFromUnknown(err).message,
      },
    );
    return null;
  }
}
