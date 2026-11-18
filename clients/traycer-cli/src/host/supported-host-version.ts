import { config } from "../config";

export function configuredSupportedHostVersion(): string | null {
  const value = config.supportedHostVersion;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function defaultRegistryHostVersionRequest(): string {
  return configuredSupportedHostVersion() ?? "latest";
}
