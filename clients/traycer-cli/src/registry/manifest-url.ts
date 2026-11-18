import { signedFeedUrls } from "../config";

// Production prefers the CDN; staging stays on its private GitHub release.
export interface ResolvedManifestUrl {
  readonly url: string;
  readonly urls?: readonly string[];
}

export function resolveManifestUrl(): ResolvedManifestUrl {
  const urls = signedFeedUrls("host");
  return { url: urls[0] ?? "", urls };
}
