import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import {
  DATA_MAINTENANCE_ROLE_ARG,
  encodeMaintenanceFrame,
  MaintenanceFrameDecoder,
  requestFrame,
  type MaintenanceFrame,
  type MaintenanceProgress,
} from "@traycer/protocol/config/data-maintenance-channel";
import {
  canonicalJson,
  incompatibleHandshakes,
  type MaintenanceOperation,
  type MaintenanceResponse,
  type MigrationJournal,
  type Sha256Digest,
} from "@traycer/protocol/config/data-migration-contracts";
import { readHostInstallRecordAtPath } from "@traycer/protocol/config/installation";
import { pathInsideRoot } from "../external-actions/ledger";
import type { DataRootPlatform } from "@traycer/protocol/config/data-root";
import { EngineStop, engineBlocker } from "./engine-types";

/**
 * The coordinator's side of the host's offline `data-maintenance` role
 * (`data-maintenance-channel.ts`): spawn the installed host executable with
 * an argument array and piped stdio, send one request frame, read progress
 * frames and exactly one final frame. No shell, no socket, no port.
 *
 * Bounded: the child is killed when no frame arrives within the inactivity
 * window, when the total budget runs out, or when the caller cancels. A
 * response is accepted only when it echoes the request (migration id,
 * journal revision, operation), comes from a `maintenance` component of this
 * protocol, and - once the journal pinned a maintenance build - from exactly
 * that build. Stderr is kept as a bounded tail for diagnostics only.
 */

export interface MaintenanceClient {
  run(input: {
    readonly journal: MigrationJournal;
    readonly operation: MaintenanceOperation;
    readonly inventoryDigest: Sha256Digest | null;
    readonly signal: AbortSignal;
    readonly onProgress: (progress: MaintenanceProgress) => void;
  }): Promise<MaintenanceResponse>;
}

export type MaintenanceHostLocator = (
  journal: MigrationJournal,
) => Promise<string>;

export type MaintenanceLimits = {
  readonly inactivityMs: number;
  readonly totalMs: number;
};

export const DEFAULT_MAINTENANCE_LIMITS: MaintenanceLimits = {
  inactivityMs: 15 * 60_000,
  totalMs: 6 * 60 * 60_000,
};

const STDERR_TAIL_BYTES = 64 * 1024;

function maintenanceFailure(code: string, message: string): EngineStop {
  return new EngineStop("failed", [engineBlocker(code, null, message)], null);
}

export function createMaintenanceClient(input: {
  readonly locateHost: MaintenanceHostLocator;
  readonly limits: MaintenanceLimits;
  readonly cwd: string;
}): MaintenanceClient {
  return {
    run: async (request) => {
      const executable = await input.locateHost(request.journal);
      const coordinator = request.journal.coordinator;
      if (coordinator === null) {
        throw new Error(
          "a maintenance request needs the coordinator recorded in the journal",
        );
      }
      const frame = encodeMaintenanceFrame(
        requestFrame({
          version: 1,
          migrationId: request.journal.id,
          journalRevision: request.journal.revision,
          operation: request.operation,
          inventoryDigest: request.inventoryDigest,
          authorization: coordinator,
        }),
      );
      const response = await exchange({
        executable,
        frame,
        cwd: input.cwd,
        limits: input.limits,
        signal: request.signal,
        onProgress: request.onProgress,
      });
      validateResponse(response, request.journal, request.operation);
      return response;
    },
  };
}

function validateResponse(
  response: MaintenanceResponse,
  journal: MigrationJournal,
  operation: MaintenanceOperation,
): void {
  if (
    response.migrationId !== journal.id ||
    response.journalRevision !== journal.revision ||
    response.operation !== operation
  ) {
    throw maintenanceFailure(
      "maintenance-mismatch",
      "the maintenance response does not answer this request",
    );
  }
  if (
    response.handshake.component !== "maintenance" ||
    incompatibleHandshakes([response.handshake]).length > 0
  ) {
    throw maintenanceFailure(
      "maintenance-incompatible",
      "the installed Traycer host does not support this data migration protocol",
    );
  }
  if (
    journal.maintenanceBuild !== null &&
    canonicalJson(journal.maintenanceBuild) !==
      canonicalJson(response.handshake)
  ) {
    throw maintenanceFailure(
      "maintenance-build-changed",
      "the installed Traycer host changed during the migration; it must finish with the build that started it",
    );
  }
}

function exchange(input: {
  readonly executable: string;
  readonly frame: Buffer;
  readonly cwd: string;
  readonly limits: MaintenanceLimits;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: MaintenanceProgress) => void;
}): Promise<MaintenanceResponse> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) {
      reject(maintenanceFailure("cancelled", "the migration was cancelled"));
      return;
    }
    const child = spawn(input.executable, [DATA_MAINTENANCE_ROLE_ARG], {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const decoder = new MaintenanceFrameDecoder();
    let response: MaintenanceResponse | null = null;
    let failure: EngineStop | null = null;
    let stderrTail = Buffer.alloc(0);
    let settled = false;

    const kill = (reason: EngineStop): void => {
      failure ??= reason;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone: its `close` settles the call.
      }
    };
    let inactivity = setTimeout(
      () =>
        kill(
          maintenanceFailure(
            "maintenance-timeout",
            "the maintenance step stopped responding",
          ),
        ),
      input.limits.inactivityMs,
    );
    const total = setTimeout(
      () =>
        kill(
          maintenanceFailure(
            "maintenance-timeout",
            "the maintenance step ran out of time",
          ),
        ),
      input.limits.totalMs,
    );
    const onAbort = (): void =>
      kill(maintenanceFailure("cancelled", "the migration was cancelled"));
    input.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(inactivity);
      clearTimeout(total);
      input.signal.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      clearTimeout(inactivity);
      inactivity = setTimeout(
        () =>
          kill(
            maintenanceFailure(
              "maintenance-timeout",
              "the maintenance step stopped responding",
            ),
          ),
        input.limits.inactivityMs,
      );
      let frames: MaintenanceFrame[];
      try {
        frames = decoder.push(chunk);
      } catch {
        kill(
          maintenanceFailure(
            "maintenance-protocol",
            "the maintenance step sent an unreadable frame",
          ),
        );
        return;
      }
      for (const frame of frames) {
        if (frame.kind === "progress") {
          input.onProgress(frame.progress);
        } else if (frame.kind === "response" && response === null) {
          response = frame.response;
        } else if (frame.kind === "fatal") {
          kill(
            maintenanceFailure(
              `maintenance-${frame.code}`,
              "the maintenance step failed",
            ),
          );
        } else {
          kill(
            maintenanceFailure(
              "maintenance-protocol",
              "the maintenance step sent an unexpected frame",
            ),
          );
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk]);
      if (stderrTail.length > STDERR_TAIL_BYTES)
        stderrTail = stderrTail.subarray(stderrTail.length - STDERR_TAIL_BYTES);
    });
    child.on("error", () => {
      kill(
        maintenanceFailure(
          "maintenance-unavailable",
          "the installed Traycer host could not be started",
        ),
      );
    });
    child.on("close", (code) => {
      finish();
      if (failure !== null) {
        reject(failure);
        return;
      }
      try {
        decoder.finish();
      } catch {
        reject(
          maintenanceFailure(
            "maintenance-protocol",
            "the maintenance step ended inside a frame",
          ),
        );
        return;
      }
      if (response === null || code !== 0) {
        reject(
          maintenanceFailure(
            "maintenance-crashed",
            "the maintenance step ended without an answer",
          ),
        );
        return;
      }
      resolve(response);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input.frame);
  });
}

/** The host installs the maintenance role may come from, in preference order. */
const MAINTENANCE_ENVIRONMENTS: readonly string[] = [
  "production",
  "staging",
  "dev",
];

/**
 * The installed host executable under the SOURCE root: the first environment
 * with an install record whose executable lies inside the source and exists.
 * The build it answers with is pinned in the journal on first use, so every
 * later step (including recovery from another process) runs the same build.
 */
export function sourceRootHostLocator(input: {
  readonly installRecordPathFor: (environment: string, root: string) => string;
  readonly platform: DataRootPlatform;
}): MaintenanceHostLocator {
  return async (journal) => {
    for (const environment of MAINTENANCE_ENVIRONMENTS) {
      const recordPath = input.installRecordPathFor(
        environment,
        journal.source.path,
      );
      // A malformed record is not an install to run; the next environment is tried.
      const record = await readHostInstallRecordAtPath(recordPath).catch(
        () => null,
      );
      if (record === null) continue;
      const executable = record.executablePath;
      if (
        pathInsideRoot(executable, journal.source.path, input.platform) === null
      )
        continue;
      try {
        if ((await stat(executable)).isFile()) return executable;
      } catch {
        continue;
      }
    }
    throw maintenanceFailure(
      "maintenance-host-missing",
      "no installed Traycer host was found in the source data folder to run the migration's storage steps",
    );
  };
}

/** Test seam: a fixed executable (a fake maintenance host script). */
export function fixedHostLocator(executable: string): MaintenanceHostLocator {
  return () => Promise.resolve(executable);
}
