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

const RECOVERY_FEED_LOOKUP_DEADLINE_MS = 3_000;

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
 * gone further: it named the generation it needs and what this CLI declared.
 * Restating "this CLI is out of date" beside that would be the vaguer of two
 * answers, printed second.
 *
 * The observed version is the HOST's normalized view (`null` when it could not
 * read one), not `resolveCliVersion`. Printing what the host actually saw is
 * what makes a mis-stamped build diagnosable from one line of output.
 *
 * WHAT IT NO LONGER PRINTS is a remedy VERSION. The host used to name the
 * earliest build carrying the required epoch, and that string had to serve the
 * desktop app and the CLI at once - so it was only ever right for one of them
 * at a time, and wrong for every CLI installed through a package manager whose
 * version numbering we do not control. Admission is epoch-only and so is this
 * sentence: it states the generation gap and leaves the artifact to the
 * caller's install vector, which {@link resolveCompatRecovery} above already
 * knows how to name.
 *
 * Returns `null` when this was not an epoch rejection, which includes every
 * host that predates the gate.
 */
export function clientCompatibilityRecoveryHint(
  requirement: ClientCompatibilityRequirement | null,
): string | null {
  if (requirement === null) return null;
  return `${describeCompatibilityGap(requirement)} Install the latest Traycer CLI. ${COMPATIBILITY_REASSURANCE}`;
}

/**
 * The gap itself, with no remedy attached: what this CLI is, what generation it
 * declares, and what the host asked for.
 *
 * Split out because the remedy varies by install vector while this never does,
 * and because the two are useful at different times - the sync error boundaries
 * can only ever state the gap plus generic advice, while the doctor knows the
 * vector and can name a command.
 */
function describeCompatibilityGap(
  requirement: ClientCompatibilityRequirement,
): string {
  const observedVersion =
    requirement.observedClientAppVersion ?? "an unknown version";
  return (
    `this CLI is too old for that host - it is running ${observedVersion} ` +
    `and declares compatibility generation ` +
    `${requirement.observedCompatibilityEpoch ?? "none"}, ` +
    `while the host requires ${requirement.minimumCompatibilityEpoch}.`
  );
}

// Said on every epoch rejection, whatever the vector. Both halves answer a
// thing a stuck user actually reaches for and would otherwise get wrong: the
// host is the NEWER leg by construction so updating it again cannot help, and
// the data is intact and migrated so a reset is destructive rather than
// corrective.
const COMPATIBILITY_REASSURANCE =
  "Updating the host again will not help, and no data needs to be reset";

/**
 * The epoch rejection stated with a remedy this INSTALL VECTOR can actually
 * follow, resolving the CLI feed only where the feed is what answers.
 *
 * The vector split is not cosmetic - it is which mechanism decides what a user
 * gets when they follow the advice:
 *
 *  - `manual`: `versions.json` IS the resolved source, so its stamped epoch
 *    says definitively whether `traycer cli upgrade` would deliver a build that
 *    clears the floor. Sufficient, and the command is the remedy. Insufficient
 *    or unreadable, and telling someone to run it sends them through a
 *    download, a replace, and a relaunch to arrive at the same rejection - so
 *    the releases page is the remedy instead. THIS IS THE ONLY VECTOR WHOSE
 *    HINT DEPENDS ON THE FEED, and the only one worth a network read on an
 *    error path.
 *  - Package managers, npm included: no feed we control describes what brew,
 *    apt, winget, scoop, or npm will actually deliver, so reading ours would be
 *    asserting something we cannot know. The hint is unchanged, and the loop is
 *    bounded at one hop by the upgraded binary itself - it knows its own
 *    `CURRENT_CLIENT_COMPATIBILITY_EPOCH` and states plainly whether it clears
 *    the floor.
 *  - `desktop`: the app's own updater owns this, including the RC routing the
 *    CLI has no part in.
 *
 * Returns `null` when this was not an epoch rejection, which includes every
 * host predating the gate.
 */
export async function clientCompatibilityRecoveryHintForVector(input: {
  readonly requirement: ClientCompatibilityRequirement | null;
  readonly source: CliInstallSource;
  readonly readFeedEpoch: (signal: AbortSignal) => Promise<number | null>;
}): Promise<string | null> {
  const { requirement } = input;
  if (requirement === null) return null;
  const remedy =
    input.source === "manual"
      ? manualVectorRemedy(
          await readRecoveryFeedEpoch(input.readFeedEpoch),
          requirement.minimumCompatibilityEpoch,
        )
      : CLIENT_UPGRADE_HINT_FOR_SOURCE[input.source];
  return `${describeCompatibilityGap(requirement)} ${remedy} ${COMPATIBILITY_REASSURANCE}`;
}

async function readRecoveryFeedEpoch(
  readFeedEpoch: (signal: AbortSignal) => Promise<number | null>,
): Promise<number | null> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, RECOVERY_FEED_LOOKUP_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      readFeedEpoch(controller.signal).catch(() => null),
      deadline,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function manualVectorRemedy(
  feedEpoch: number | null,
  minimumCompatibilityEpoch: number,
): string {
  if (feedEpoch !== null && feedEpoch >= minimumCompatibilityEpoch) {
    return `Run 'traycer cli upgrade' - the published CLI declares generation ${feedEpoch}, which clears this host.`;
  }
  // THE REMEDY IS THE URL; the command is named only to rule it out.
  //
  // Naming `traycer cli upgrade` in a negation is a deliberate choice over
  // silence. It is the obvious next thing a blocked CLI user reaches for, and
  // it would cost them a download, a replace and a relaunch to arrive back at
  // this same rejection. Saying nothing leaves them to discover that the
  // expensive way; saying "not that, this" closes it in one line. The sentence
  // is ordered so the actionable half comes first and the warning trails it.
  //
  // What it deliberately does NOT say is WHY the feed could not vouch for an
  // upgrade. Unstamped, insufficient, and unreachable are one answer here -
  // the action is identical for all three, and naming the internals of a
  // release feed to a blocked user is noise.
  return "Download the latest Traycer CLI from https://github.com/traycerai/traycer/releases - the CLI feed could not verify a build new enough for this host, so it could not verify that 'traycer cli upgrade' will resolve it.";
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
