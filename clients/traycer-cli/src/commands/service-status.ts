import type { CommandFn, CommandResult } from "../runner/runner";
import {
  createServiceController,
  serviceLabelFor,
  serviceManifestPath,
  windowsTaskName,
} from "../service";

// `traycer host service status [--json]` - read-only snapshot of the OS
// service state for the current environment. The `data` payload is the
// raw ServiceStatus the controller returns; the human path renders a
// terse summary so a user can tell at a glance whether the service is
// registered + running.
export const serviceStatusCommand: CommandFn = async (
  ctx,
): Promise<CommandResult> => {
  const label = serviceLabelFor(ctx.runtime.environment);
  const status = await createServiceController().status(label);
  const platform = process.platform;
  const manifestPath =
    platform === "win32" ? windowsTaskName(label) : serviceManifestPath(label);
  const data = {
    label: label.id,
    environment: label.environment,
    displayName: label.displayName,
    manifestPath,
    state: status.state,
    pid: status.pid,
    listenUrl: status.listenUrl,
    version: status.version,
  };
  const human = renderHuman(data);
  return { data, human, exitCode: 0 };
};

function renderHuman(data: {
  readonly label: string;
  readonly state: string;
  readonly pid: number | null;
  readonly listenUrl: string | null;
  readonly version: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`Service '${data.label}': ${data.state}`);
  if (data.version !== null) lines.push(`  version: ${data.version}`);
  if (data.pid !== null) lines.push(`  pid:     ${data.pid}`);
  if (data.listenUrl !== null) lines.push(`  listen:  ${data.listenUrl}`);
  return lines.join("\n");
}
