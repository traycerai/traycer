import { z } from "zod";
import type { Environment } from "../runner/environment";
import { getPublishedProcessIdentityVerdict } from "../store/process-identity";
import {
  readSupervisorRecord,
  readSupervisorRunState,
} from "./lifecycle-files";
import { readHostPidMetadataEvidence } from "./pid-metadata";

const incarnation = z.object({
  pid: z.number().int().positive(),
  identity: z.string().nullable(),
});

export const windowsRestartIncumbentSchema = z.object({
  supervisor: incarnation.nullable().or(z.literal("unknown")),
  runtime: incarnation.nullable().or(z.literal("unknown")),
});

export type WindowsRestartIncumbent = z.infer<
  typeof windowsRestartIncumbentSchema
>;

export async function readWindowsRestartIncumbent(
  environment: Environment,
): Promise<WindowsRestartIncumbent> {
  const [run, supervisor, runtime] = await Promise.all([
    readSupervisorRunState(environment),
    readSupervisorRecord(environment),
    readHostPidMetadataEvidence(environment),
  ]);
  return {
    supervisor:
      run.kind === "valid" &&
      (supervisor.kind === "absent" ||
        (supervisor.kind === "valid" &&
          run.record.supervisorPid === supervisor.record.pid))
        ? {
            pid: run.record.supervisorPid,
            identity: run.record.supervisorStartIdentity,
          }
        : run.kind === "absent" && supervisor.kind === "absent"
          ? null
          : run.kind === "absent" && supervisor.kind === "valid"
            ? { pid: supervisor.record.pid, identity: null }
            : "unknown",
    runtime:
      runtime.kind === "read"
        ? {
            pid: runtime.metadata.pid,
            identity: runtime.metadata.processStartIdentity,
          }
        : runtime.kind === "absent"
          ? null
          : "unknown",
  };
}

export async function readWindowsRestartSlot(
  environment: Environment,
): Promise<"empty" | "runtime-current" | "unknown" | "supervisor-current"> {
  const { supervisor, runtime } =
    await readWindowsRestartIncumbent(environment);
  const runtimeState = await incarnationState(runtime);
  const supervisorState = await incarnationState(supervisor);
  if (runtimeState === "current") return "runtime-current";
  if (runtimeState === "unknown" || supervisorState === "unknown")
    return "unknown";
  return supervisorState === "current" ? "supervisor-current" : "empty";
}

async function incarnationState(
  incarnation: WindowsRestartIncumbent["runtime"],
): Promise<"gone" | "current" | "unknown"> {
  if (incarnation === null) return "gone";
  if (incarnation === "unknown") return "unknown";
  const verdict = await getPublishedProcessIdentityVerdict(
    incarnation.pid,
    incarnation.identity,
  );
  if (verdict === "dead" || verdict === "mismatch") return "gone";
  return verdict === "current" ? "current" : "unknown";
}

export function sameIncarnation(
  previous: WindowsRestartIncumbent["runtime"],
  pid: number,
  identity: string | null,
): boolean {
  return (
    previous !== null &&
    previous !== "unknown" &&
    previous.pid === pid &&
    (previous.identity === null ||
      identity === null ||
      previous.identity === identity)
  );
}

export async function incumbentMayBeAlive(
  incumbent: WindowsRestartIncumbent,
  swept: boolean,
): Promise<boolean> {
  for (const identity of [incumbent.runtime, incumbent.supervisor]) {
    // The stop's final convergence scan accounts for unrecorded slot
    // processes it swept. Keep checking any incumbent we identified by PID.
    if (identity === "unknown" && swept) continue;
    if ((await incarnationState(identity)) !== "gone") return true;
  }
  return false;
}
