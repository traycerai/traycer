import {
  NO_CHAT_STORE,
  resolveHostStoreFormats,
  storeFloorApplicability,
  type HostStoreFormats,
} from "@traycer/protocol/host/store-formats";
import type { HostStatusStoreFormats } from "@traycer/protocol/host/status/index";
import type { HostUpdateStoreFloorRefusal } from "@traycer/protocol/host/maintenance/index";

/**
 * One availability rule for both the version picker and the summary action.
 * The RPC still re-surveys before dispatch: a cached status can explain an
 * offer, but cannot authorize placing older bytes over newly migrated data.
 */
export interface HostStoreFormatOffer {
  readonly version: string;
  readonly publishedFormats: HostStoreFormats | null;
  readonly runningVersion: string | null;
  readonly storeFormats: HostStatusStoreFormats | null;
}

export interface HostStoreFormatRestriction {
  readonly kind: "blocked" | "unknown" | "pending" | "failed";
  readonly reason: string;
  readonly detail: string | null;
  readonly confirmation: string | null;
}

export function hostStoreFormatRestriction(
  input: HostStoreFormatOffer,
): HostStoreFormatRestriction | null {
  if (input.storeFormats === null) return null;
  const target = resolveHostStoreFormats(input.version, input.publishedFormats);
  const chatDb = input.storeFormats.chatDb;
  const downgrade = storeFloorApplicability(
    input.version,
    input.runningVersion,
    input.publishedFormats,
  ).applies;
  // Boot uncertainty is transient. Do not offer loss consent until the
  // first survey has answered, even if this target's metadata is unknown.
  if (downgrade && chatDb.survey === "pending") {
    return {
      kind: "pending",
      reason: "Checking chat stores…",
      detail: null,
      confirmation: null,
    };
  }
  // A completed empty survey has no chats to lose access to, even when the
  // target's format is unknown. A fresh RPC refusal can still override this
  // cached observation if a store appeared after the status poll.
  if (
    chatDb.survey === "complete" &&
    chatDb.onDiskMax === null &&
    chatDb.epicCount === 0
  ) {
    return null;
  }
  if (target.kind === "unknown") {
    return downgrade ? unknownTargetRestriction(input.version) : null;
  }
  if (downgrade && chatDb.survey === "failed") {
    return unreadableStoresRestriction(input.version);
  }
  if (chatDb.onDiskMax === null || chatDb.onDiskMax <= target.formats.chatDb) {
    return null;
  }
  return newerStoresRestriction(
    input.version,
    target.formats.chatDb,
    chatDb.onDiskMax,
  );
}

/**
 * A fresh host refusal outranks the catalog/status that offered the action.
 * Keep it actionable even when those retained reads cannot reproduce it.
 */
export function hostStoreFormatRestrictionFromRpc(
  refusal: HostUpdateStoreFloorRefusal,
): HostStoreFormatRestriction {
  if (refusal.kind === "blocked" && refusal.targetChatDb !== null) {
    return newerStoresRestriction(
      refusal.targetVersion,
      refusal.targetChatDb,
      refusal.onDiskMax,
    );
  }
  return refusal.reason === "target-format-unknown"
    ? unknownTargetRestriction(refusal.targetVersion)
    : unreadableStoresRestriction(refusal.targetVersion);
}

function unknownTargetRestriction(version: string): HostStoreFormatRestriction {
  return {
    kind: "unknown",
    reason: "Chat store format not published",
    detail: `v${version} doesn't publish which chat store format it reads, so this device's data can't be verified against it.`,
    confirmation: `v${version} doesn't publish which chat store format it reads, so Traycer can't verify it can open this device's chats.`,
  };
}

function unreadableStoresRestriction(
  version: string,
): HostStoreFormatRestriction {
  return {
    kind: "failed",
    reason: "Chat stores couldn't be read",
    detail:
      "This device's chat stores couldn't be read, so installing this version may lose access to those chats.",
    confirmation: `This device's chat stores couldn't be read, so Traycer can't verify v${version} can open them.`,
  };
}

function newerStoresRestriction(
  version: string,
  targetFormat: number,
  onDiskMax: number | null,
): HostStoreFormatRestriction {
  const formatDescription =
    onDiskMax === null ? "in a newer format" : `written in format ${onDiskMax}`;
  const targetDescription =
    targetFormat === NO_CHAT_STORE
      ? `v${version} doesn't read chat stores`
      : `v${version} reads format ${targetFormat}`;
  return {
    kind: "blocked",
    reason: newerStoresReason(targetFormat, onDiskMax),
    detail:
      "Can't open chat stores written by this host; installing anyway loses access to those chats until you update forward.",
    confirmation: `This device has chat stores ${formatDescription}. ${targetDescription}, so it can't open those chats, and it may fail to start until you update the host again. Nothing is deleted; updating forward restores access.`,
  };
}

function newerStoresReason(
  targetFormat: number,
  onDiskMax: number | null,
): string {
  if (targetFormat === NO_CHAT_STORE) {
    return "Doesn't read this device's chat stores";
  }
  if (onDiskMax === null) {
    return `Reads format ${targetFormat}; this device has newer chat stores`;
  }
  return `Reads chat store format ${targetFormat}; this device has ${onDiskMax}`;
}

/** The authoritative refusal may name epics a cached status had not seen. */
export function describeHostStoreFloorRpcRefusal(
  refusal: HostUpdateStoreFloorRefusal,
): string {
  const omitted = refusal.epicCount > refusal.epicIds.length ? ", …" : "";
  const named =
    refusal.epicIds.length === 0
      ? ""
      : ` (${refusal.epicIds.join(", ")}${omitted})`;
  const epics = `${refusal.epicCount} ${refusal.epicCount === 1 ? "epic" : "epics"}${named}`;
  if (refusal.kind === "blocked") {
    const maximum =
      refusal.onDiskMax === null
        ? "maximum format could not be determined"
        : `format ${refusal.onDiskMax}`;
    return `Can't install ${refusal.targetVersion}: ${epics} ${refusal.epicCount === 1 ? "uses" : "use"} a newer chat store (${maximum}; ${targetFormatDescription(refusal.targetVersion, refusal.targetChatDb)}). ${overrideGuidance(refusal.targetVersion)}`;
  }
  const affected = refusal.epicCount > 0 ? ` for ${epics}` : "";
  const reason =
    refusal.reason === "target-format-unknown"
      ? "the target's chat store format is unknown"
      : `the chat stores could not be read${affected}`;
  return `Can't install ${refusal.targetVersion}: ${reason}. ${overrideGuidance(refusal.targetVersion)}`;
}

function targetFormatDescription(
  version: string,
  format: number | null,
): string {
  if (format === null) return `${version}'s readable format is unknown`;
  return format === NO_CHAT_STORE
    ? `${version} does not read chat stores`
    : `${version} reads ${format}`;
}

function overrideGuidance(version: string): string {
  return `Update forward instead, or choose Install anyway for v${version} to proceed and lose access to affected chats until the host is updated again.`;
}
