import { hostRegistryUrl } from "../config";

// Where the CLI fetches `versions.json` from.
// A single source-controlled URL derived from `config.environment` (see `config.ts`) - no environment, no env.
export interface ResolvedManifestUrl {
  readonly url: string;
}

export function resolveManifestUrl(): ResolvedManifestUrl {
  return { url: hostRegistryUrl };
}
