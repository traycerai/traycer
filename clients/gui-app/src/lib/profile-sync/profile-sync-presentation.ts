import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type {
  ProfileSyncDevice,
  ProfileSyncItem,
  ProfileSyncProvider,
  ProfileSyncReason,
  ProfileSyncStatus,
} from "@traycer/protocol/host/profile-sync-link-schemas";

/**
 * Everything the Sync profiles dialog SAYS, as pure functions of the source
 * host's overview. The host sends a status and a reason word; the sentences,
 * the one action a row may carry, and the order rows appear in are decided
 * here and nowhere else, so the dialog speaks one vocabulary.
 */

/** GUI provider id → wire provider, or `null` for a provider sync leaves out. */
export function profileSyncWireProvider(
  providerId: ProviderId,
): ProfileSyncProvider | null {
  switch (providerId) {
    case "claude-code":
      return "claude";
    case "codex":
      return "codex";
    case "grok":
      return "grok";
    case "antigravity":
      return "antigravity";
    default:
      return null;
  }
}

export function profileSyncGuiProvider(
  provider: ProfileSyncProvider,
): ProviderId {
  switch (provider) {
    case "claude":
      return "claude-code";
    case "codex":
      return "codex";
    case "grok":
      return "grok";
    case "antigravity":
      return "antigravity";
  }
}

export function profileSyncProviderLabel(
  provider: ProfileSyncProvider,
): string {
  return PROVIDER_DISPLAY_NAMES[profileSyncGuiProvider(provider)];
}

export type ProfileSyncTone = "success" | "warning" | "muted";

export const PROFILE_SYNC_STATUS_LABELS: Record<ProfileSyncStatus, string> = {
  synced: "Synced",
  syncing: "Syncing",
  "sign-in-needed": "Sign in needed",
  "device-offline": "Device offline",
  "update-needed": "Update needed",
  "cannot-sync": "Can't sync",
};

const STATUS_TONES: Record<ProfileSyncStatus, ProfileSyncTone> = {
  synced: "success",
  syncing: "muted",
  "sign-in-needed": "warning",
  "device-offline": "muted",
  "update-needed": "warning",
  "cannot-sync": "warning",
};

export function profileSyncStatusTone(
  status: ProfileSyncStatus,
): ProfileSyncTone {
  return STATUS_TONES[status];
}

/** The two machines a sentence can name. Display names, never host ids. */
export interface ProfileSyncNames {
  readonly source: string;
  readonly device: string;
}

export function profileSyncReasonSentence(
  reason: ProfileSyncReason,
  provider: ProfileSyncProvider,
  names: ProfileSyncNames,
): string {
  const providerLabel = profileSyncProviderLabel(provider);
  switch (reason) {
    case "provider-not-installed":
      return `${providerLabel} isn't installed on ${names.device}`;
    case "provider-disabled":
      return `${providerLabel} is turned off on ${names.device}`;
    case "unsupported-sign-in":
      return "This sign-in type can't be synced";
    case "keychain-store":
      return `${providerLabel} keeps this sign-in in the system keychain`;
    // Either device's keychain can be the locked one, so neither is named.
    case "keychain-locked":
      return "A keychain is locked. Unlock it on both devices, then sync again.";
    case "account-changed":
      return `${names.source} is now signed in to a different account`;
    case "account-mismatch":
      return `${names.source} and ${names.device} are signed in to different accounts. Sign in to the same account on both to resume.`;
    case "account-unknown":
      return "The account isn't identified yet";
    case "destination-refused":
      return `${names.device} refused this profile`;
    // Also a write that failed after the device answered, so not "reach".
    case "transfer-failed":
      return `Couldn't sync to ${names.device}, retrying`;
    case "removed-on-device":
      return `Removed on ${names.device}`;
  }
}

/** The line under a row's name, or `null` when its status says it all. */
export function profileSyncItemDetail(
  item: ProfileSyncItem,
  names: ProfileSyncNames,
): string | null {
  if (item.status === "update-needed") {
    return `Update Traycer on ${names.device}`;
  }
  if (item.reason !== null) {
    return profileSyncReasonSentence(item.reason, item.providerId, names);
  }
  // "Can't sync" always carries a reason; a host that sent none still gets one.
  return item.status === "cannot-sync" ? "This profile can't be synced" : null;
}

/**
 * A row carries at most ONE action, and only these two exist. An account
 * switch has two shapes: `account-changed` (the device that created the link
 * switched, and the user may send the new account across) carries the action;
 * `account-mismatch` (the receiving device switched) carries none, because
 * sync never replaces either account.
 */
export type ProfileSyncItemAction = "sign-in" | "accept-account";

export function profileSyncItemAction(
  item: ProfileSyncItem,
): ProfileSyncItemAction | null {
  if (item.status === "sign-in-needed") return "sign-in";
  if (item.status === "cannot-sync" && item.reason === "account-changed") {
    return "accept-account";
  }
  return null;
}

/** "Needs you" is exactly the rows that carry an action. */
export function profileSyncItemNeedsUser(item: ProfileSyncItem): boolean {
  return profileSyncItemAction(item) !== null;
}

/**
 * A row is listed without expanding when the user can do something about it:
 * every "Can't sync", "Sign in needed" and "Update needed" row, whether or
 * not it carries a button. The device line counts these, so a count the list
 * does not show would send the user looking for rows that are hidden.
 */
export function profileSyncItemShownByDefault(item: ProfileSyncItem): boolean {
  return (
    item.status === "cannot-sync" ||
    item.status === "sign-in-needed" ||
    item.status === "update-needed"
  );
}

/** Rows with an action lead; the hidden rest ends with what is simply done. */
function itemOrder(item: ProfileSyncItem): number {
  if (profileSyncItemNeedsUser(item)) return 0;
  switch (item.status) {
    case "cannot-sync":
    case "sign-in-needed":
      return 1;
    case "update-needed":
      return 2;
    case "device-offline":
      return 3;
    case "syncing":
      return 4;
    case "synced":
      return 5;
  }
}

function byItemOrder(left: ProfileSyncItem, right: ProfileSyncItem): number {
  return itemOrder(left) - itemOrder(right);
}

export interface ProfileSyncItemGroups {
  /** Always listed: rows with an action first, then the other problems. */
  readonly shown: readonly ProfileSyncItem[];
  /** Behind "Show all": waiting and syncing rows, synced last. */
  readonly rest: readonly ProfileSyncItem[];
}

export function groupProfileSyncItems(
  items: readonly ProfileSyncItem[],
): ProfileSyncItemGroups {
  return {
    shown: items.filter(profileSyncItemShownByDefault).toSorted(byItemOrder),
    rest: items
      .filter((item) => !profileSyncItemShownByDefault(item))
      .toSorted(byItemOrder),
  };
}

/**
 * Whether "Sync now" has something to retry on a device that is kept in sync.
 * A "Can't sync" row is fixed by the user outside this dialog (install the
 * CLI, unlock a keychain, sign in to the same account), and nothing tells the
 * host it was fixed; the explicit sync is the retry. `account-changed` is the
 * exception: its own button is the only thing that moves it.
 */
export function profileSyncHasRetryableItems(
  items: readonly ProfileSyncItem[],
): boolean {
  return items.some(
    (item) =>
      item.status === "cannot-sync" && item.reason !== "account-changed",
  );
}

/** A row's identity under one device: a provider's profile on the source. */
export function profileSyncItemKey(item: ProfileSyncItem): string {
  return JSON.stringify([item.providerId, item.sourceProfileId]);
}

/**
 * What THIS app knows about the device from the host directory, independently
 * of what the source host reports per profile. `offline` and `update-required`
 * lead the summary; `reachable` leaves it to the profiles.
 */
export type ProfileSyncDeviceReach =
  | "reachable"
  | "offline"
  | "update-required";

export interface ProfileSyncSummaryPart {
  readonly text: string;
  readonly tone: ProfileSyncTone;
}

function countPart(
  count: number,
  one: string,
  many: string,
  tone: ProfileSyncTone,
): readonly ProfileSyncSummaryPart[] {
  if (count === 0) return [];
  return [{ text: `${String(count)} ${count === 1 ? one : many}`, tone }];
}

/** "Syncs when it connects" is a promise, so it is made only when one holds. */
function deviceOfflineSummary(
  syncsOnConnect: boolean,
): readonly ProfileSyncSummaryPart[] {
  return [
    {
      text: syncsOnConnect
        ? "Device offline · syncs when it connects"
        : "Device offline",
      tone: "muted",
    },
  ];
}

/** A device's one-line summary, as the parts a " · " joins. */
export function profileSyncDeviceSummary(input: {
  /** `null` for a device the user has never synced to. */
  readonly device: ProfileSyncDevice | null;
  readonly reach: ProfileSyncDeviceReach;
  /** As the switch shows it, a pending request included. */
  readonly keepInSync: boolean;
  readonly deviceName: string;
  readonly profileCount: number;
}): readonly ProfileSyncSummaryPart[] {
  const { device, reach } = input;
  if (reach === "offline") {
    // Work resumes on connect when the device is followed, or a row is
    // already waiting for it or mid-sync.
    const waiting = (device?.items ?? []).some(
      (item) => item.status === "device-offline" || item.status === "syncing",
    );
    return deviceOfflineSummary(input.keepInSync || waiting);
  }
  if (reach === "update-required") {
    return [{ text: `Update Traycer on ${input.deviceName}`, tone: "warning" }];
  }
  if (device === null) return [{ text: "Not synced yet", tone: "muted" }];
  const items = device.items;
  if (items.length === 0) {
    return [
      {
        text: input.profileCount === 0 ? "No profiles to sync" : "Syncing",
        tone: "muted",
      },
    ];
  }
  const count = (status: ProfileSyncStatus): number =>
    items.filter((item) => item.status === status).length;
  // The source could reach none of it, and every row is waiting for it.
  if (count("device-offline") === items.length) {
    return deviceOfflineSummary(true);
  }
  const needsUser = items.filter(profileSyncItemNeedsUser).length;
  const cannotSync = items.filter(
    (item) => item.status === "cannot-sync" && !profileSyncItemNeedsUser(item),
  ).length;
  return [
    ...countPart(count("synced"), "synced", "synced", "success"),
    ...countPart(count("syncing"), "syncing", "syncing", "muted"),
    ...countPart(needsUser, "needs you", "need you", "warning"),
    ...countPart(cannotSync, "can't sync", "can't sync", "warning"),
    ...countPart(
      count("update-needed"),
      "needs an update",
      "need an update",
      "warning",
    ),
    ...countPart(
      count("device-offline"),
      "waiting for the device",
      "waiting for the device",
      "muted",
    ),
  ];
}

export function profileSyncProfileCountLabel(profileCount: number): string {
  return `${String(profileCount)} ${profileCount === 1 ? "profile" : "profiles"}`;
}
