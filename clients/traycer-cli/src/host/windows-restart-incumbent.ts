import { z } from "zod";
import type { Environment } from "../runner/environment";
import { getPublishedProcessIdentityVerdict } from "../store/process-identity";
import { readSupervisorRunState } from "./lifecycle-files";
import { readHostPidMetadata } from "./pid-metadata";

const incarnation = z.object({
  pid: z.number().int().positive(),
  identity: z.string().nullable(),
});

export const windowsRestartIncumbentSchema = z.object({
  supervisor: incarnation.nullable(),
  runtime: incarnation.nullable(),
});

export type WindowsRestartIncumbent = z.infer<
  typeof windowsRestartIncumbentSchema
>;

export async function readWindowsRestartIncumbent(
  environment: Environment,
): Promise<WindowsRestartIncumbent> {
  const [supervisor, runtime] = await Promise.all([
    readSupervisorRunState(environment),
    readHostPidMetadata(environment),
  ]);
  return {
    supervisor:
      supervisor.kind === "valid"
        ? {
            pid: supervisor.record.supervisorPid,
            identity: supervisor.record.supervisorStartIdentity,
          }
        : null,
    runtime:
      runtime === null
        ? null
        : { pid: runtime.pid, identity: runtime.processStartIdentity },
  };
}

export function sameIncarnation(
  previous: WindowsRestartIncumbent["runtime"],
  pid: number,
  identity: string | null,
): boolean {
  return (
    previous?.pid === pid &&
    (previous.identity === null ||
      identity === null ||
      previous.identity === identity)
  );
}

export async function incumbentMayBeAlive(
  incumbent: WindowsRestartIncumbent,
): Promise<boolean> {
  for (const identity of [incumbent.runtime, incumbent.supervisor]) {
    if (identity === null) continue;
    const verdict = await getPublishedProcessIdentityVerdict(
      identity.pid,
      identity.identity,
    );
    if (verdict !== "dead" && verdict !== "mismatch") return true;
  }
  return false;
}
