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
  const warm = readiness.result.warm;
  if (warm !== null && warm >= 1) return "Ready to start.";
  const measuredMs = provider.coldCreateMeasuredMs ?? null;
  if (measuredMs === null) return null;
  const minutes = Math.max(1, Math.round(measuredMs / 60_000));
  return `This create takes about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}
