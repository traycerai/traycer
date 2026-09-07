/** Single source of truth for this CLI build's deployment config. Flat config object: source always holds the DEV values; the deploy script (scripts/set-deploy-target.cjs) rewrites the `environment` field + the literal values in place for staging/production builds, then reverts. */

import {
  DEV_AUTHN_BASE_URL_ENV,
  DEV_CLOUD_UI_BASE_URL_ENV,
  devBackendUrlFromEnv,
} from "@traycer-clients/shared/platform/dev-backend-urls";

export type Environment = string;

const bakedConfig = {
  environment: "dev" as Environment,
  // Concrete per-build identity, stamped at install time by the deploy script (alongside `environment`).
  // `0.0.0-dev` in source / after `--restore`; a real install bakes `<target>.<epochMs>.<gitSha>`, shared with the host + desktop built in the same install.
  version: "0.0.0-dev",
  authnBaseUrl: "https://authn.traycer.ai",
  cloudUiBaseUrl: "https://platform.traycer.ai",
  // GitHub owner/repo hosting released-host-versions, cli-manifest, host-v*, cli-v*, and desktop-v* releases.
  // Release workflows stamp this from RELEASE_REPO so forked/relocated builds fetch from the same repo they publish to.
  releaseRepo: "traycerai/traycer",
  // Exact host release this CLI installs by default when no local host archive is bundled beside it.
  // Production CLI release workflows stamp this to the matching host/CLI release version.
  supportedHostVersion: null as string | null,
  // minisign public keys trusted to verify downloaded host archive signatures - this build's root of trust.
  // The OSS build ships the production host-signing public key here so a source checkout verifies real releases out of the box.
  hostTrustedPubkeys: [
    // Traycer host release signing key (minisign, key id 847ef539119a1961).
    "RWSEfvU5EZoZYQTQUOVHeQFv3poThl1VM7FZLkNQr0Zu0FyL2x+u2O2l",
  ] as readonly string[],
};

// The dev-gated backend URL overrides resolve once, at module init, so every
// command in this process sees one consistent value.
export const config = {
  ...bakedConfig,
  authnBaseUrl: devBackendUrlFromEnv(
    bakedConfig.environment,
    DEV_AUTHN_BASE_URL_ENV,
    bakedConfig.authnBaseUrl,
    process.env,
  ),
  cloudUiBaseUrl: devBackendUrlFromEnv(
    bakedConfig.environment,
    DEV_CLOUD_UI_BASE_URL_ENV,
    bakedConfig.cloudUiBaseUrl,
    process.env,
  ),
};

const DEFAULT_RELEASE_REPO = "traycerai/traycer";

export function configuredReleaseRepo(): string {
  const repo = config.releaseRepo.trim();
  return repo.length === 0 ? DEFAULT_RELEASE_REPO : repo;
}

export function releaseManifestUrl(manifestTag: string): string {
  return `https://github.com/${configuredReleaseRepo()}/releases/download/${manifestTag}/versions.json`;
}

// Host release registry.
// The canonical `versions.json` is published as an asset on the rolling `released-host-versions` GitHub Release of config.releaseRepo.
export const hostRegistryUrl = releaseManifestUrl("released-host-versions");
