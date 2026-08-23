import type {
  ClientCompatibilityRequirement,
  IncompatibilityUpgradeGuidance,
} from "@traycer/protocol/framework/index";
import {
  PACKAGE_MANAGER_UPGRADE_HINT,
  type CliInstallSource,
} from "../manifest/cli-manifest";

// Vector-aware recovery for a handshake `fatalError { code: "INCOMPATIBLE" }`
// (C2). The host's compatibility checker derives `upgradeGuidance`
// (`deriveUpgradeGuidance`) on the rejecting frame; this module turns that
// verdict, plus the client's install vector, into a concrete recovery the
// caller can act on:
//
//   hostShouldUpgrade → reinstall the latest host (`traycer host update`).
//   clientShouldUpgrade → update THIS client via its install vector (desktop's
//                         built-in updater, brew/apt/etc., or npm / re-download
//                         for a standalone install).
//
// This is deliberately NOT compat-range download resolution (explicitly
// out-of-scope): the host stays always-latest and the handshake is
// authoritative; we only route the verdict to the right per-vector action.

// Client-upgrade hint per install vector. The `desktop` and `manual` rows are
// phrased for protocol-incompatibility recovery (distinct from `cli upgrade`'s
// self-upgrade refusal: desktop defers to the app's electron-updater, manual
// covers npm-global + standalone re-download). The package-manager rows
// (homebrew/winget/scoop/apt/rpm) are the SAME command everywhere, so they come
// from the shared `PACKAGE_MANAGER_UPGRADE_HINT` instead of being duplicated.
export const CLIENT_UPGRADE_HINT_FOR_SOURCE: Record<CliInstallSource, string> =
  {
    desktop:
      "Update the Traycer desktop app (it updates itself via its built-in updater), then relaunch.",
    manual:
      "Run 'npm update -g @traycerai/cli' if you installed via npm, otherwise re-download the latest standalone CLI.",
    ...PACKAGE_MANAGER_UPGRADE_HINT,
  };

export interface CompatRecoveryPlan {
  // `hostShouldUpgrade`: the shared host is the stale side - reinstall the
  // latest host (the only host-update trigger that fires post-launch).
  readonly reinstallHost: boolean;
  // `clientShouldUpgrade`: THIS client is the stale side - upgrade it via its
  // install vector. Null when the client side is current.
  readonly clientUpgrade: {
    readonly source: CliInstallSource;
    readonly hint: string;
  } | null;
  // One-line, user-facing recovery summary covering whichever side(s) are stale.
  readonly summary: string;
}

// A handshake `DOWNGRADE_UNSUPPORTED` is thrown by the client transport with
// `fatalDetails: null` when this client is NEWER than the host and no
// downgrade bridge exists for the called method: client-newer ⇒ the host is
// the stale side ⇒ it must UPDATE, not restart. Synthesize that verdict so the
// null guidance never falls through to a "restart the host" hint which, under
// the softened launch trigger (ordinary launches no longer auto-update), would
// just bring the same stale host back and loop forever.
//
// EVERY `INCOMPATIBLE` / `DOWNGRADE_UNSUPPORTED` recovery path - the doctor card
// (`routeIncompatibleRecovery`) AND the unary-RPC error boundary
// (`mapHostRpcError` → `compatRecoveryHint`) - routes its guidance through
// here first, so the same wire code yields the same advice everywhere.
export function effectiveUpgradeGuidance(
  rpcCode: string,
  guidance: IncompatibilityUpgradeGuidance | null,
): IncompatibilityUpgradeGuidance | null {
  if (rpcCode === "DOWNGRADE_UNSUPPORTED") {
    return { hostShouldUpgrade: true, clientShouldUpgrade: false };
  }
  return guidance;
}

export function resolveCompatRecovery(
  guidance: IncompatibilityUpgradeGuidance | null,
  source: CliInstallSource,
): CompatRecoveryPlan {
  const reinstallHost = guidance?.hostShouldUpgrade ?? false;
  const clientStale = guidance?.clientShouldUpgrade ?? false;
  const clientUpgrade = clientStale
    ? { source, hint: CLIENT_UPGRADE_HINT_FOR_SOURCE[source] }
    : null;
  return {
    reinstallHost,
    clientUpgrade,
    summary: summarize(reinstallHost, clientUpgrade),
  };
}

function summarize(
  reinstallHost: boolean,
  clientUpgrade: CompatRecoveryPlan["clientUpgrade"],
): string {
  if (reinstallHost && clientUpgrade !== null) {
    return `The host and this client are both out of date. Reinstall the latest host ('traycer host update'), then update the client: ${clientUpgrade.hint}`;
  }
  if (reinstallHost) {
    return "The host is out of date. Reinstall the latest host with 'traycer host update'.";
  }
  if (clientUpgrade !== null) {
    return `This Traycer client is out of date. ${clientUpgrade.hint}`;
  }
  // No guidance on the frame (e.g. an older host, or a cross-major
  // DOWNGRADE_UNSUPPORTED): fall back to the conservative restart-then-update
  // path rather than guessing which side is stale.
  return "Restart the host ('traycer host restart'); if the mismatch persists, update both the host and this client.";
}

/**
 * The facts a user needs when the host refused this CLI at its
 * client-compatibility EPOCH gate, rather than over a method-manifest
 * disagreement.
 *
 * It TAKES PRECEDENCE over the guidance-derived hints below, and does not
 * merely add to them, because those hints answer "which side is stale" by
 * reading two booleans. Here the host has already answered that question and
 * gone further: it named the generation it needs, what this CLI declared, and
 * the earliest published build that fixes it. Restating "this CLI is out of
 * date" beside that would be the vaguer of two answers, printed second.
 *
 * The observed version is the HOST's normalized view (`null` when it could not
 * read one), not `resolveCliVersion`. Printing what the host actually saw is
 * what makes a mis-stamped build diagnosable from one line of output.
 *
 * Returns `null` when this was not an epoch rejection, which includes every
 * host that predates the gate.
 */
export function clientCompatibilityRecoveryHint(
  requirement: ClientCompatibilityRequirement | null,
): string | null {
  if (requirement === null) return null;
  const observedVersion =
    requirement.observedClientAppVersion ?? "an unknown version";
  const target =
    requirement.minimumKnownClientAppVersion === null
      ? "the latest CLI"
      : `${requirement.minimumKnownClientAppVersion} or newer${
          requirement.upgradeChannel === null
            ? ""
            : ` on the ${requirement.upgradeChannel} channel`
        }`;
  return (
    `this CLI is too old for that host - it is running ${observedVersion} ` +
    `and declares compatibility generation ` +
    `${requirement.observedCompatibilityEpoch ?? "none"}, ` +
    `while the host requires ${requirement.minimumCompatibilityEpoch}. ` +
    `Install ${target}. Updating the host again will not help, and no data ` +
    `needs to be reset`
  );
}

// Source-agnostic one-liner for callers that surface the verdict without an
// install vector in scope (the unary-RPC error boundary). The vector-aware
// `resolveCompatRecovery` is preferred wherever the install source is known.
export function compatRecoveryHint(
  guidance: IncompatibilityUpgradeGuidance | null,
): string {
  const host = guidance?.hostShouldUpgrade ?? false;
  const client = guidance?.clientShouldUpgrade ?? false;
  if (host && client) {
    return "both the host and this CLI are out of date - run 'traycer host update' and update the CLI via your install method";
  }
  if (host) {
    return "the host is out of date - run 'traycer host update' to reinstall the latest host";
  }
  if (client) {
    return "this CLI is out of date - update it via your install method (e.g. 'traycer cli upgrade', 'brew upgrade traycer', or 'npm update -g @traycerai/cli')";
  }
  return "try 'traycer host restart'; if it persists, update the host and CLI";
}
