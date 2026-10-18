import type { Stats } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DATA_MIGRATION_PROTOCOL_VERSION } from "@traycer/protocol/config/data-migration-contracts";
import type { DataRootPlatform } from "@traycer/protocol/config/data-root";
import { readHostInstallRecordAtPath } from "@traycer/protocol/config/installation";
import { isErrnoException } from "../../runner/errors";
import { pathInsideRoot } from "../external-actions/ledger";
import { sha256File } from "./content-inventory";
import { engineBlocker, type EngineBlocker } from "./engine-types";

/**
 * The installed-participant preflight gate: every Traycer host and CLI
 * installed in the source data folder must be PROVEN to understand data
 * relocation before the barrier goes up, because an old one started after
 * the switch would keep using the old folder. Absent or unsupported evidence
 * refuses. Nothing installed is ever executed to find out: an old binary's
 * behaviour on an unknown flag is exactly what cannot be assumed.
 *
 * - A host slot (each environment's install record): the record must attest
 *   its executable (`executableSha256`), the executable on disk must still
 *   hash to it, and the `version.json` the host build writes beside that
 *   executable (`traycer-host/scripts/build-host-sea.cjs`) must name the
 *   record's runtime version and declare `dataMigrationProtocol` equal to
 *   this build's protocol. A host build older than that field declares
 *   nothing and refuses.
 * - A CLI slot (each environment's well-known CLI binary): its bytes must be
 *   identical to the running coordinator's own executable - the one binary
 *   proven to speak this protocol. A coordinator that is not a packaged
 *   executable (a development run) cannot vouch for any installed CLI.
 *
 * The coordinator CLI itself usually IS the production slot, which then
 * passes by identity.
 *
 * Which slots exist is read from the source tree by the install layout the
 * path owners define (`protocol/src/config/installation.ts`,
 * `store/paths.ts`), never from this process's environment or development
 * slot: `host/install`, `host/<staging|dev>/install`,
 * `host/dev-runs/<slot>/install`, and the same shapes under `cli/` with a
 * `bin/` folder. A slot folder or binary that is a link, or a `dev-runs`
 * folder that cannot be listed, refuses rather than being skipped.
 */

const NAMED_ENVIRONMENTS: readonly string[] = ["staging", "dev"];
const DEV_RUNS = "dev-runs";

export type InstallSlot = {
  /** `production`, `staging`, `dev` or `dev-runs/<slot>`. */
  readonly label: string;
  /** The slot's home: `<root>/host[/...]` or `<root>/cli[/...]`. */
  readonly home: string;
};

/**
 * Every slot home under `<root>/<component>` that exists, in layout order.
 * A slot home that is not a real folder, or a `dev-runs` folder that cannot
 * be listed, is returned as a blocker instead.
 */
async function slotHomes(
  root: string,
  component: "host" | "cli",
): Promise<{
  readonly slots: readonly InstallSlot[];
  readonly blockers: readonly EngineBlocker[];
}> {
  const base = join(root, component);
  const slots: InstallSlot[] = [];
  const blockers: EngineBlocker[] = [];
  const consider = async (label: string, home: string): Promise<void> => {
    let stats: Stats;
    try {
      stats = await lstat(home);
    } catch (error) {
      if (
        isErrnoException(error) &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      )
        return;
      blockers.push(
        engineBlocker(
          "participant-unreadable",
          `${label} ${component}`,
          "an installed Traycer slot could not be read",
        ),
      );
      return;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      blockers.push(
        engineBlocker(
          "participant-alias",
          `${label} ${component}`,
          "an installed Traycer slot is not a plain folder",
        ),
      );
      return;
    }
    slots.push({ label, home });
  };
  await consider("production", base);
  for (const environment of NAMED_ENVIRONMENTS)
    await consider(environment, join(base, environment));
  let runs: string[] = [];
  try {
    runs = (await readdir(join(base, DEV_RUNS))).sort();
  } catch (error) {
    if (
      !isErrnoException(error) ||
      (error.code !== "ENOENT" && error.code !== "ENOTDIR")
    ) {
      blockers.push(
        engineBlocker(
          "participant-unreadable",
          `${DEV_RUNS} ${component}`,
          "the development install slots could not be listed",
        ),
      );
    }
  }
  for (const run of runs)
    await consider(`${DEV_RUNS}/${run}`, join(base, DEV_RUNS, run));
  return { slots, blockers };
}

/** The CLI binary names a `bin/` folder may hold; any present must be accounted for. */
function cliBinaryNames(platform: DataRootPlatform): readonly string[] {
  return platform === "win32"
    ? ["traycer.exe", "traycer.cmd", "traycer"]
    : ["traycer"];
}

/** Every CLI binary installed in a slot under `root`, for participants and recovery. */
export async function installedCliBinaries(
  root: string,
  platform: DataRootPlatform,
): Promise<{
  readonly binaries: readonly {
    readonly label: string;
    readonly path: string;
  }[];
  readonly blockers: readonly EngineBlocker[];
}> {
  const { slots, blockers } = await slotHomes(root, "cli");
  const binaries: { label: string; path: string }[] = [];
  for (const slot of slots) {
    for (const name of cliBinaryNames(platform)) {
      const path = join(slot.home, "bin", name);
      if (await isPresent(path)) binaries.push({ label: slot.label, path });
    }
  }
  return { binaries, blockers };
}

export type InstalledParticipantsInput = {
  readonly sourceRoot: string;
  readonly platform: DataRootPlatform;
  /** The running coordinator's executable when it is a packaged binary, else null. */
  readonly coordinatorExecutable: string | null;
};

async function isPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return false;
    throw error;
  }
}

/** SHA-256 of a regular, non-link file, or null for anything else. */
export async function regularFileSha256(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile()) return null;
    return await sha256File(path);
  } catch {
    return null;
  }
}

/** What a host build declares about itself beside its executable, or null. */
async function declaredHostCapability(executable: string): Promise<{
  readonly version: string | null;
  readonly dataMigrationProtocol: number | null;
} | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(join(dirname(executable), "version.json"), "utf8"),
    );
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const version = Reflect.get(parsed, "version");
  const protocol = Reflect.get(parsed, "dataMigrationProtocol");
  return {
    version: typeof version === "string" && version.length > 0 ? version : null,
    dataMigrationProtocol:
      typeof protocol === "number" && Number.isSafeInteger(protocol)
        ? protocol
        : null,
  };
}

async function hostSlotBlockers(
  sourceRoot: string,
  platform: DataRootPlatform,
  slot: InstallSlot,
): Promise<EngineBlocker[]> {
  const environment = slot.label;
  const recordPath = join(slot.home, "install", "install.json");
  if (!(await isPresent(recordPath))) return [];
  const refuse = (code: string, message: string): EngineBlocker[] => [
    engineBlocker(code, `${environment} host`, message),
  ];
  const record = await readHostInstallRecordAtPath(recordPath).catch(
    () => null,
  );
  if (record === null)
    return refuse(
      "participant-unreadable",
      "an installed Traycer host's install record is unreadable",
    );
  if (pathInsideRoot(record.executablePath, sourceRoot, platform) === null) {
    return refuse(
      "participant-outside-source",
      "an installed Traycer host runs from outside the data folder",
    );
  }
  if (record.executableSha256 === null) {
    return refuse(
      "participant-unattested",
      "an installed Traycer host predates data relocation; update it first",
    );
  }
  if (
    (await regularFileSha256(record.executablePath)) !== record.executableSha256
  ) {
    return refuse(
      "participant-changed",
      "an installed Traycer host no longer matches its install record; reinstall or update it",
    );
  }
  const declared = await declaredHostCapability(record.executablePath);
  const expectedVersion = record.runtimeVersion ?? record.version;
  if (declared === null || declared.version !== expectedVersion) {
    return refuse(
      "participant-unsupported",
      "an installed Traycer host does not declare data relocation support; update it first",
    );
  }
  if (declared.dataMigrationProtocol !== DATA_MIGRATION_PROTOCOL_VERSION) {
    return refuse(
      "participant-unsupported",
      declared.dataMigrationProtocol !== null &&
        declared.dataMigrationProtocol > DATA_MIGRATION_PROTOCOL_VERSION
        ? "an installed Traycer host is newer than this Traycer; update Traycer first"
        : "an installed Traycer host does not support data relocation; update it first",
    );
  }
  return [];
}

export async function installedParticipantBlockers(
  input: InstalledParticipantsInput,
): Promise<readonly EngineBlocker[]> {
  const blockers: EngineBlocker[] = [];
  const hosts = await slotHomes(input.sourceRoot, "host");
  blockers.push(...hosts.blockers);
  for (const slot of hosts.slots)
    blockers.push(
      ...(await hostSlotBlockers(input.sourceRoot, input.platform, slot)),
    );
  const clis = await installedCliBinaries(input.sourceRoot, input.platform);
  blockers.push(...clis.blockers);
  const coordinator =
    input.coordinatorExecutable === null
      ? null
      : await regularFileSha256(input.coordinatorExecutable);
  for (const binary of clis.binaries) {
    const installed = await regularFileSha256(binary.path);
    if (installed !== null && coordinator !== null && installed === coordinator)
      continue;
    blockers.push(
      engineBlocker(
        "participant-unsupported",
        `${binary.label} CLI`,
        "a Traycer CLI installed in the data folder is not this Traycer version; update it first",
      ),
    );
  }
  return blockers;
}
