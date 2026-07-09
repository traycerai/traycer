/**
 * Single source of truth for this CLI build's deployment config.
 *
 * Flat config object: source always holds the DEV values; the deploy script
 * (scripts/set-deploy-target.cjs) rewrites the `environment` field + the
 * literal values in place for staging/production builds, then reverts.
 * Nothing here is read from `process.env` - a hostile or stray runtime
 * environment cannot repoint the CLI at a different backend, registry, or
 * trust root.
 */

export type Environment = string;

export const config = {
  environment: "staging" as Environment,
  // Concrete per-build identity, stamped at install time by the deploy
  // script (alongside `environment`). `0.0.0-dev` in source / after
  // `--restore`; a real install bakes `<target>.<epochMs>.<gitSha>`, shared
  // with the host + desktop built in the same install. `host ensure`
  // records this as the install version and reinstalls when the installed
  // host's stamp differs.
  version: "staging.1783581575647.bb8c937d9",
  authnBaseUrl: "https://authn.dev.traycer.ai",
  cloudUiBaseUrl: "https://platform.dev.traycer.ai",
  // GitHub owner/repo hosting released-host-versions, cli-manifest, host-v*,
  // cli-v*, and desktop-v* releases. Release workflows stamp this from
  // RELEASE_REPO so forked/relocated builds fetch from the same repo they
  // publish to.
  releaseRepo: "traycerai/traycer",
  // Exact host release this CLI installs by default when no local host
  // archive is bundled beside it. Production CLI release workflows stamp this
  // to the matching host/CLI release version. Dev and dogfood bundle flows
  // keep it null so local archives or explicit `--release` remain in charge.
  supportedHostVersion: null as string | null,
  // minisign public keys trusted to verify downloaded host archive
  // signatures — this build's root of trust. The OSS build ships the
  // production host-signing public key here so a source checkout verifies
  // real releases out of the box. The ~/.traycer/cli/host-trusted-pubkeys
  // disk overlay can ADD keys (e.g. mid-rotation) without a rebuild.
  hostTrustedPubkeys: [
    // Traycer host release signing key (minisign, key id 847ef539119a1961).
    "RWSEfvU5EZoZYQTQUOVHeQFv3poThl1VM7FZLkNQr0Zu0FyL2x+u2O2l",
  ] as readonly string[],
};

const DEFAULT_RELEASE_REPO = "traycerai/traycer";

export function configuredReleaseRepo(): string {
  const repo = config.releaseRepo.trim();
  return repo.length === 0 ? DEFAULT_RELEASE_REPO : repo;
}

export function releaseManifestUrl(manifestTag: string): string {
  return `https://github.com/${configuredReleaseRepo()}/releases/download/${manifestTag}/versions.json`;
}

// Host release registry. The canonical `versions.json` is published as an
// asset on the rolling `released-host-versions` GitHub Release of config.releaseRepo.
// Non-production builds are never released on their own channel - staging is
// exercised with local builds or production builds for testing, and dev hosts
// come from the working tree.
export const hostRegistryUrl = releaseManifestUrl("released-host-versions");
