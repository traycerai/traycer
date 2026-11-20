import type { InstallSourceArg } from "../installer";
import type { LogFields } from "../logger";

export function installSourceLogFields(source: InstallSourceArg): LogFields {
  if (source.kind !== "registry") {
    return { sourceKind: source.kind };
  }
  return {
    sourceKind: "registry",
    versionRequest: source.versionRequest,
  };
}
