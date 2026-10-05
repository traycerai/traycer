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
    case "keychain-locked":
      return `The keychain on ${names.source} is locked`;
    case "account-changed":
      return `${names.source} is now signed in to a different account`;
    case "account-unknown":
      return "The account isn't identified yet";
    case "destination-refused":
      return `${names.device} refused this profile`;
    case "transfer-failed":
      return `Couldn't reach ${names.device}, retrying`;
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

/** A row carries at most ONE action, and only these two exist. */
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

const REST_ORDER: Record<ProfileSyncStatus, number> = {
  "cannot-sync": 0,
  "sign-in-needed": 0,
  "update-needed": 1,
  "device-offline": 2,
  syncing: 3,
  synced: 4,
};

export interface ProfileSyncItemGroups {
  /** Always shown, in the host's order. */
  readonly needsUser: readonly ProfileSyncItem[];
  /** Behind "Show all": problems first, synced last. */
  readonly rest: readonly ProfileSyncItem[];
}

export function groupProfileSyncItems(
  items: readonly ProfileSyncItem[],
): ProfileSyncItemGroups {
  return {
    needsUser: items.filter(profileSyncItemNeedsUser),
    rest: items
      .filter((item) => !profileSyncItemNeedsUser(item))
      .toSorted(
        (left, right) => REST_ORDER[left.status] - REST_ORDER[right.status],
      ),
  };
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

const DEVICE_OFFLINE_SUMMARY: readonly ProfileSyncSummaryPart[] = [
  { text: "Device offline · syncs when it connects", tone: "muted" },
];

/** A device's one-line summary, as the parts a " · " joins. */
export function profileSyncDeviceSummary(input: {
  /** `null` for a device the user has never synced to. */
  readonly device: ProfileSyncDevice | null;
  readonly reach: ProfileSyncDeviceReach;
  readonly deviceName: string;
  readonly profileCount: number;
}): readonly ProfileSyncSummaryPart[] {
  const { device, reach } = input;
  if (reach === "offline") return DEVICE_OFFLINE_SUMMARY;
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
  // The source could reach none of it: the same sentence the directory gives.
  if (count("device-offline") === items.length) return DEVICE_OFFLINE_SUMMARY;
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
