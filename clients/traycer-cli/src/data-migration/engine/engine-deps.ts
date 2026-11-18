import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rmdir,
  statfs,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { clientProcessIncarnationProbe } from "@traycer-clients/shared/host-lock/data-migration-admission";
import type { ProcessIncarnationProbe } from "@traycer/protocol/config/data-migration-admission";
import {
  currentComponentHandshake,
  type ComponentHandshake,
} from "@traycer/protocol/config/data-migration-contracts";
import {
  dataRootPathsOverlap,
  dataRootPlatformOf,
  traycerDataRoot,
  validateDataRootSelection,
  type DataRootPlatform,
} from "@traycer/protocol/config/data-root";
import {
  createWindowsDataRootCommands,
  ensurePrivateBootstrapDir,
  preparePrivateDataRoot,
  runWindowsPowerShell,
  type DataRootTargetResult,
  type WindowsDataRootCommands,
} from "@traycer/protocol/config/data-root-target";
import { hostInstallRecordPath } from "@traycer/protocol/config/installation";
import { LOCAL_CLI_VERSION } from "../../cli-version";
import { isErrnoException } from "../../runner/errors";
import { isPackagedRun } from "../../store/well-known-cli";
import { layoutUnderRoot } from "../external-actions/ledger";
import type { EngineCheckpoint, EngineProgress } from "./engine-types";
import {
  createMaintenanceClient,
  DEFAULT_MAINTENANCE_LIMITS,
  sourceRootHostLocator,
  type MaintenanceClient,
} from "./maintenance-client";
import {
  posixRootUserCensus,
  windowsRootUserCensus,
  type RootUserCensus,
} from "./root-user-census";
import {
  defaultPosixServiceRelocationPort,
  windowsServiceRelocationPort,
  type ServiceRelocationPort,
} from "./service-port";

/**
 * Everything the migration engine reads from or does to the machine, behind
 * one injectable record. Production wiring is `productionMigrationEngineDeps`;
 * isolated real-filesystem tests replace the maintenance child, the service
 * port, the process census and the clock, and use `checkpoint` to inject a
 * crash at any durable boundary.
 *
 * Not reachable from any command yet: ticket 718-7 exposes the engine.
 */
export type MigrationEngineDeps = {
  readonly homeDir: string;
  readonly platform: DataRootPlatform;
  readonly nodePlatform: NodeJS.Platform;
  readonly probe: ProcessIncarnationProbe;
  readonly coordinatorBuild: ComponentHandshake;
  /**
   * The running coordinator's own executable when it is a packaged binary,
   * else null: the identity installed CLIs are compared against
   * (`installed-participants.ts`) and recovery binaries are matched to.
   */
  readonly coordinatorExecutable: () => Promise<string | null>;
  readonly maintenance: MaintenanceClient;
  readonly services: ServiceRelocationPort;
  readonly census: RootUserCensus;
  readonly destination: DestinationPreparer;
  readonly secureBootstrap: (
    bootstrapDir: string,
  ) => Promise<DataRootTargetResult>;
  /** Free bytes on the volume holding `path`; null when the platform cannot say. */
  readonly freeBytes: (path: string) => Promise<number | null>;
  /** The data root THIS process resolved at startup (cleanup must run from the destination). */
  readonly processDataRoot: () => string;
  readonly now: () => string;
  readonly signal: AbortSignal;
  readonly checkpoint: (point: EngineCheckpoint) => Promise<void>;
  readonly progress: (event: EngineProgress) => void;
  /** How long and how often quiescence waits for admitted processes to exit. */
  readonly drain: { readonly waitMs: number; readonly pollMs: number };
  /** Journal `copyManifest.verifiedCount` is persisted every this many files. */
  readonly copyProgressEvery: number;
};

/**
 * Allocates the new, empty, private destination folder. Windows applies and
 * reads back the protected DACL (`preparePrivateDataRoot`); POSIX creates the
 * folder with mode 0700 under the same path and overlap rules.
 */
export interface DestinationPreparer {
  prepare(input: {
    readonly requested: string;
    readonly protectedRoots: readonly string[];
  }): Promise<DataRootTargetResult>;
}

function refused(
  code: Extract<DataRootTargetResult, { ok: false }>["code"],
  reason: string,
): DataRootTargetResult {
  return { ok: false, code, reason };
}

export function windowsDestinationPreparer(
  commands: WindowsDataRootCommands,
): DestinationPreparer {
  return {
    prepare: ({ requested, protectedRoots }) =>
      preparePrivateDataRoot({
        requested,
        protectedRoots,
        platform: "win32",
        commands,
      }),
  };
}

export const posixDestinationPreparer: DestinationPreparer = {
  prepare: async ({ requested, protectedRoots }) => {
    const check = validateDataRootSelection(requested, "posix");
    if (!check.ok) return refused("invalid-path", check.reason);
    const target = check.root;
    for (const root of protectedRoots) {
      if (dataRootPathsOverlap(target, root, "posix")) {
        return refused(
          "overlaps-protected-root",
          "the folder overlaps an existing Traycer data or bootstrap folder",
        );
      }
    }
    const parent = dirname(target);
    let realParent: string;
    try {
      realParent = await realpath(parent);
    } catch {
      return refused("parent-missing", "the parent folder does not exist");
    }
    if (realParent !== parent) {
      return refused(
        "unsupported-reparse-point",
        "the parent folder is reached through a link",
      );
    }
    let created = false;
    try {
      await mkdir(target, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") throw error;
    }
    const stats = await lstat(target);
    if (stats.isSymbolicLink())
      return refused("unsupported-reparse-point", "the folder is a link");
    if (!stats.isDirectory())
      return refused("not-a-directory", "the path exists and is not a folder");
    if (!created && (await readdir(target)).length > 0) {
      return refused(
        "populated",
        "the folder is not empty; choose a new or empty folder dedicated to Traycer",
      );
    }
    if ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.()) {
      if (created) await rmdir(target).catch(() => undefined);
      return refused(
        "acl-not-established",
        "the folder could not be made private",
      );
    }
    return { ok: true, root: target, created };
  },
};

/** POSIX never calls the Windows ACL commands; using one is a wiring error. */
const NO_WINDOWS_COMMANDS: WindowsDataRootCommands = {
  probeVolume: () =>
    Promise.reject(new Error("Windows volume probe on a POSIX platform")),
  applyPrivateAcl: () =>
    Promise.reject(new Error("Windows ACL on a POSIX platform")),
  readAcl: () => Promise.reject(new Error("Windows ACL on a POSIX platform")),
  securePrivateChildren: () =>
    Promise.reject(new Error("Windows ACL on a POSIX platform")),
};

export function bootstrapSecurer(
  platform: DataRootPlatform,
  commands: WindowsDataRootCommands,
): (bootstrapDir: string) => Promise<DataRootTargetResult> {
  return (bootstrapDir) =>
    ensurePrivateBootstrapDir({
      bootstrapDir,
      platform,
      commands: platform === "win32" ? commands : NO_WINDOWS_COMMANDS,
    });
}

export async function volumeFreeBytes(path: string): Promise<number | null> {
  try {
    const stats = await statfs(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/**
 * Production wiring for the engine. Builds nothing until called; never
 * called by a command in this ticket.
 */
export function productionMigrationEngineDeps(input: {
  readonly signal: AbortSignal;
  readonly progress: (event: EngineProgress) => void;
}): MigrationEngineDeps {
  const platform = dataRootPlatformOf(process.platform);
  const windowsCommands = createWindowsDataRootCommands(runWindowsPowerShell);
  const home = homedir();
  return {
    homeDir: home,
    platform,
    nodePlatform: process.platform,
    probe: clientProcessIncarnationProbe,
    coordinatorBuild: currentComponentHandshake("cli", LOCAL_CLI_VERSION),
    coordinatorExecutable: async () =>
      (await isPackagedRun()) ? process.execPath : null,
    maintenance: createMaintenanceClient({
      locateHost: sourceRootHostLocator({
        installRecordPathFor: (environment, root) =>
          layoutUnderRoot(hostInstallRecordPath(environment), root, platform),
        platform,
      }),
      limits: DEFAULT_MAINTENANCE_LIMITS,
      cwd: home,
    }),
    services:
      platform === "win32"
        ? windowsServiceRelocationPort()
        : defaultPosixServiceRelocationPort(),
    census:
      platform === "win32"
        ? windowsRootUserCensus()
        : posixRootUserCensus({ uid: process.getuid?.() ?? -1 }),
    destination:
      platform === "win32"
        ? windowsDestinationPreparer(windowsCommands)
        : posixDestinationPreparer,
    secureBootstrap: bootstrapSecurer(platform, windowsCommands),
    freeBytes: volumeFreeBytes,
    processDataRoot: traycerDataRoot,
    now: () => new Date().toISOString(),
    signal: input.signal,
    checkpoint: () => Promise.resolve(),
    progress: input.progress,
    drain: { waitMs: 120_000, pollMs: 1_000 },
    copyProgressEvery: 2_000,
  };
}
