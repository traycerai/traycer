import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExternalAction } from "@traycer/protocol/config/data-migration-contracts";
import {
  withCliUpdateContender,
  type WithCliUpdateContenderOptions,
} from "../../host/update-contender";
import { stopHostServiceWithAttempt } from "../../host/update-mutation";
import { isErrnoException } from "../../runner/errors";
import { createServiceController, type ServiceController } from "../../service";
import {
  devServiceLabelForSlot,
  serviceLabelFor,
  serviceManifestPath,
  type ServiceLabel,
} from "../../service/label";
import { DEV_DESKTOP_SLOT_ENV } from "../../store/dev-desktop-slot";
import { hostHomeDir } from "../../store/paths";
import type {
  ExternalActionBlocker,
  ExternalActionPlan,
} from "../external-actions/ledger";
import type { DataRootPair } from "../external-actions/windows-task-actions";
import {
  planWindowsTaskQuiesce,
  planWindowsTaskRelocation,
} from "../external-actions/windows-task-actions";
import { planWindowsUserPathRelocation } from "../external-actions/windows-user-path-action";
import { engineBlocker, type EngineBlocker } from "./engine-types";

/**
 * Everything outside the copied data root that names it and that the
 * migration owns: service registrations, the user PATH entry of the CLI, and
 * the running hosts those registrations start.
 *
 * Windows (the v1 product) plans through the reversible ledger adapters of
 * ticket 718-5: disable each owned enabled task while quiescing, retarget
 * each task and its launcher plus the CLI's PATH entry while preparing, and
 * re-enable only tasks the migration disabled after activation.
 *
 * POSIX has no relocation adapter for launchd/systemd registrations, whose
 * launcher lives inside the data root: an existing registration blocks the
 * migration before any effect. With none, there is nothing outside the root
 * to move (this is what lets isolated fixtures run on a POSIX machine).
 */
export interface ServiceRelocationPort {
  planQuiesce(roots: DataRootPair): Promise<ExternalActionPlan>;
  planRelocation(
    roots: DataRootPair,
    ledger: readonly ExternalAction[],
  ): Promise<ExternalActionPlan>;
  /**
   * Ask every running CLI-managed host to stop cooperatively (never forced:
   * a busy host refuses and the migration waits). Returns what could not be
   * stopped; the admitted-process survey decides whether anything still runs.
   */
  stopRunningHosts(roots: DataRootPair): Promise<readonly EngineBlocker[]>;
}

const STAGING_LABEL: ServiceLabel = {
  id: "ai.traycer.host.staging",
  displayName: "Traycer Host (Staging)",
  environment: "staging",
  devSlot: null,
};

/** Every label whose registration could name the source root. */
export async function migrationServiceLabels(
  sourceRoot: string,
): Promise<readonly ServiceLabel[]> {
  const labels: ServiceLabel[] = [
    serviceLabelFor("production"),
    STAGING_LABEL,
    devServiceLabelForSlot(null),
  ];
  let slots: string[] = [];
  try {
    slots = (await readdir(join(sourceRoot, "host", "dev-runs"))).sort();
  } catch (error) {
    if (
      !isErrnoException(error) ||
      (error.code !== "ENOENT" && error.code !== "ENOTDIR")
    )
      throw error;
  }
  for (const slot of slots) labels.push(devServiceLabelForSlot(slot));
  return labels;
}

function mergePlans(plans: readonly ExternalActionPlan[]): ExternalActionPlan {
  return {
    actions: plans.flatMap((plan) => plan.actions),
    blockers: plans.flatMap((plan) => plan.blockers),
  };
}

/**
 * The label's own host home, derived from the label alone: `hostHomeDir`
 * for an environment honours this process's `DEV_DESKTOP_SLOT`, which names
 * the coordinator's slot, not the one being stopped.
 */
export function labelHostHomeDir(label: ServiceLabel): string {
  const hostRoot = hostHomeDir(undefined);
  if (label.devSlot !== null) return join(hostRoot, "dev-runs", label.devSlot);
  return label.environment === "production"
    ? hostRoot
    : join(hostRoot, label.environment);
}

function setDevSlotEnv(slot: string | null): void {
  if (slot === null) Reflect.deleteProperty(process.env, DEV_DESKTOP_SLOT_ENV);
  else process.env[DEV_DESKTOP_SLOT_ENV] = slot;
}

/**
 * Runs `run` as the label's dev slot. Every slot-aware path the stop reaches
 * (the CLI lock, the stop intent, the controller's pid and process records)
 * reads `DEV_DESKTOP_SLOT` at use time, so this is what makes all of them
 * follow the label rather than the coordinator. The stops run one at a time
 * and nothing else in the coordinator runs alongside them.
 */
async function asLabelSlot<T>(
  label: ServiceLabel,
  run: () => Promise<T>,
): Promise<T> {
  const prior = process.env[DEV_DESKTOP_SLOT_ENV];
  setDevSlotEnv(label.devSlot);
  try {
    return await run();
  } finally {
    setDevSlotEnv(prior ?? null);
  }
}

/** The host-update contender a stop of `label`'s host takes, as `host stop` does. */
function stopContenderOptions(
  label: ServiceLabel,
): WithCliUpdateContenderOptions {
  return {
    environment: label.environment,
    hostHomeDir: labelHostHomeDir(label),
    reason: "data-migration-stop-host",
    waitMs: 30_000,
    pollIntervalMs: 100,
    admission: "service-maintenance",
  };
}

/**
 * Stops each running host through the service-stop facade under the
 * host-update contender, so the stop never races a host update. Runs before
 * the source inventory is frozen, so the contender's records in the source
 * root are content like any other.
 */
async function stopHosts(
  controller: ServiceController,
  labels: readonly ServiceLabel[],
): Promise<readonly EngineBlocker[]> {
  const blockers: EngineBlocker[] = [];
  for (const label of labels) {
    try {
      await asLabelSlot(label, async () => {
        const status = await controller.status(label);
        if (status.state !== "running") return;
        const contenderOptions = stopContenderOptions(label);
        await withCliUpdateContender(contenderOptions, (capability) =>
          stopHostServiceWithAttempt(
            capability,
            contenderOptions,
            controller,
            label,
            { force: false },
            "unconditional",
          ),
        );
      });
    } catch (error) {
      blockers.push(
        engineBlocker(
          "host-stop-refused",
          label.id,
          `a running Traycer host could not be stopped (${error instanceof Error ? error.message : String(error)}); finish or stop its work, then retry`,
        ),
      );
    }
  }
  return blockers;
}

export function windowsServiceRelocationPort(): ServiceRelocationPort {
  return {
    planQuiesce: async (roots) =>
      planWindowsTaskQuiesce({
        labels: await migrationServiceLabels(roots.sourceRoot),
      }),
    planRelocation: async (roots, ledger) => {
      const labels = await migrationServiceLabels(roots.sourceRoot);
      return mergePlans([
        await planWindowsTaskRelocation({ labels, roots, ledger }),
        await planWindowsUserPathRelocation({ labels, roots }),
      ]);
    },
    stopRunningHosts: async (roots) =>
      stopHosts(
        createServiceController(),
        await migrationServiceLabels(roots.sourceRoot),
      ),
  };
}

export function posixServiceRelocationPort(input: {
  readonly controller: ServiceController | null;
  readonly manifestPathFor: (label: ServiceLabel) => string;
}): ServiceRelocationPort {
  return {
    planQuiesce: async (roots) => {
      const blockers: ExternalActionBlocker[] = [];
      for (const label of await migrationServiceLabels(roots.sourceRoot)) {
        const manifest = input.manifestPathFor(label);
        try {
          await lstat(manifest);
        } catch (error) {
          if (
            isErrnoException(error) &&
            (error.code === "ENOENT" || error.code === "ENOTDIR")
          )
            continue;
          throw error;
        }
        blockers.push({
          code: "service-registration-unsupported",
          object: manifest,
          message:
            "a login service registration points into the data folder, and relocating it is not supported on this platform",
        });
      }
      return { actions: [], blockers };
    },
    planRelocation: () => Promise.resolve({ actions: [], blockers: [] }),
    stopRunningHosts: async (roots) =>
      input.controller === null
        ? []
        : stopHosts(
            input.controller,
            await migrationServiceLabels(roots.sourceRoot),
          ),
  };
}

export function defaultPosixServiceRelocationPort(): ServiceRelocationPort {
  return posixServiceRelocationPort({
    controller: createServiceController(),
    manifestPathFor: serviceManifestPath,
  });
}
