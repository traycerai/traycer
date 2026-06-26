import type { InstallSourceArg } from "../installer";
import type { LogFields } from "../logger";

export function installSourceLogFields(source: InstallSourceArg): LogFields {
  if (source.kind === "local-file") {
    return { sourceKind: "local-file" };
  }
  return {
    sourceKind: "registry",
    versionRequest: source.versionRequest,
  };
}
