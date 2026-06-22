import { hostRegistryUrl } from "../config";

// Where the CLI fetches `versions.json` from. A single source-controlled URL
// derived from `config.environment` (see `config.ts`) - no environment, no env.
// `file://` URLs are accepted in addition to `http(s)://` for fixtures /
// local manifest mirrors. Callers treat the value as opaque and pass it back
// through the registry client.
export interface ResolvedManifestUrl {
  readonly url: string;
}

export function resolveManifestUrl(): ResolvedManifestUrl {
  return { url: hostRegistryUrl };
}
