import type { SandboxCatalogue } from "@traycer/protocol/host/sandbox-control";
import {
  stageProviderForShape,
  stageQuotedSize,
  type StageSize,
} from "@/lib/sandboxes/sandbox-stage-model";

/** A count is a current observation, never a reservation for this create. */
export function sandboxReadinessLine(
  catalogue: SandboxCatalogue,
  shape: StageSize | null,
): string | null {
  if (shape === null) return null;
  const provider = stageProviderForShape(catalogue, shape);
  if (provider === null) return null;
  const readiness = provider.readiness;
  if (readiness === undefined) return null;
  const quoted = stageQuotedSize(provider, shape);
  if (quoted === null || !quoted.exact) return null;
  const request = readiness.request;
  if (
    request.os !== shape.os ||
    request.region !== shape.region ||
    request.shape.cpus !== quoted.shape.cpus ||
    request.shape.memoryMb !== quoted.shape.memoryMb ||
    request.shape.diskMb !== quoted.shape.diskMb
  )
    return null;
  const result = readiness.result;
  if ("warm" in result)
    return result.warm === 0
      ? "None ready now. Starting may take longer."
      : `${result.warm} ready now.`;
  if (result.cold === null) return "Starting may take a few minutes.";
  const minutes = Math.max(1, Math.ceil(result.cold / 60_000));
  return `Starting takes up to about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}
