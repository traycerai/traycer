/**
 * D7 render-side half of host-attributed provider-pack notifications.
 *
 * Host mints `host.operation.finished` rows with open payload arms:
 * `provider_pack_update_available`, `provider_pack_security_floor`,
 * `provider_pack_pin_lifecycle` — each carrying `hostId` + `hostLabel`.
 * The origin store always replicates; this module is what keeps a laptop
 * feed from treating another machine's pack store as local.
 *
 * "This machine" for comparison is the **local host directory entry**
 * (`useReactiveLocalHostEntry`), not the ambient active host — notifications
 * are machine-scoped (G8), and the active host can be a remote peer.
 *
 * Locality context distinguishes three shells (finding 3):
 * - `resolved` — desktop with a known local hostId
 * - `pending` — desktop shell has a local-host concept, entry not yet known
 * - `no-local-host` — browser/mobile: never has a local pack store
 */

export type ProviderPackNotificationPayloadKind =
  | "provider_pack_update_available"
  | "provider_pack_security_floor"
  | "provider_pack_pin_lifecycle";

export type ProviderPackNotificationAttribution = {
  readonly kind: ProviderPackNotificationPayloadKind;
  readonly hostId: string;
  readonly hostLabel: string;
};

/**
 * How this client relates to a local pack store for D7 classification.
 *
 * - `resolved` — desktop (or any shell) with a known local host id
 * - `pending` — shell has a local-host concept, but the entry is not ready yet
 * - `no-local-host` — browser/mobile: no local pack store ever
 */
export type ProviderPackViewingLocalityContext =
  | { readonly kind: "resolved"; readonly hostId: string }
  | { readonly kind: "pending" }
  | { readonly kind: "no-local-host" };

/**
 * Build locality context from the shell capability + live local entry.
 * `hasLocalHost` comes from `IRunnerHost.hasLocalHost`; `localHostId` from
 * `useReactiveLocalHostEntry()?.hostId`.
 */
export function providerPackViewingLocalityFromShell(options: {
  readonly hasLocalHost: boolean;
  readonly localHostId: string | null;
}): ProviderPackViewingLocalityContext {
  if (!options.hasLocalHost) return { kind: "no-local-host" };
  if (options.localHostId === null) return { kind: "pending" };
  return { kind: "resolved", hostId: options.localHostId };
}
/** Classified presentation of one attributed pack notification. */
export type ProviderPackNotificationLocality = "local" | "remote" | "unknown";

export function parseProviderPackNotificationAttribution(
  payload: unknown,
): ProviderPackNotificationAttribution | null {
  if (!isRecord(payload)) return null;
  const kind = payload.kind;
  if (
    kind !== "provider_pack_update_available" &&
    kind !== "provider_pack_security_floor" &&
    kind !== "provider_pack_pin_lifecycle"
  ) {
    return null;
  }
  const hostId = nonEmptyString(payload.hostId);
  const hostLabel = nonEmptyString(payload.hostLabel);
  if (hostId === null || hostLabel === null) return null;
  return { kind, hostId, hostLabel };
}

/**
 * Classify locality for an attributed pack notification.
 *
 * - Never present as **local** unless we positively know the viewing host
 *   matches the payload hostId.
 * - Shells with **no local host** (browser/mobile) always classify attributed
 *   pack events as **remote** — there is no local pack store to act on.
 * - Desktop **pending** resolve is **unknown**: neither local nor remote
 *   presentation (brief window only).
 */
export function classifyProviderPackNotificationLocality(options: {
  readonly attribution: ProviderPackNotificationAttribution | null;
  readonly viewing: ProviderPackViewingLocalityContext;
}): ProviderPackNotificationLocality {
  if (options.attribution === null) return "local";
  if (options.viewing.kind === "no-local-host") return "remote";
  if (options.viewing.kind === "pending") return "unknown";
  if (options.attribution.hostId === options.viewing.hostId) return "local";
  return "remote";
}

/**
 * True when the entry describes a pack store on a machine other than the one
 * this client is running on. Browser/mobile (`no-local-host`) always remote
 * for attributed rows. Pending desktop resolve is not remote.
 */
export function isProviderPackNotificationRemote(options: {
  readonly attribution: ProviderPackNotificationAttribution | null;
  readonly viewing: ProviderPackViewingLocalityContext;
}): boolean {
  return classifyProviderPackNotificationLocality(options) === "remote";
}

/**
 * Local: no machine caption (strip host-composed "on &lt;label&gt;" if present).
 * Remote / unknown: ensure a machine caption early in the body so one-line
 * truncation still shows which machine (finding 6).
 *
 * Never drops the row — security-floor and pin-lifecycle stay visible with
 * attribution (de-emphasis is a separate visual decision).
 */
export function presentProviderPackNotificationBody(options: {
  readonly body: string;
  readonly attribution: ProviderPackNotificationAttribution | null;
  readonly locality: ProviderPackNotificationLocality;
}): string {
  if (options.attribution === null) return options.body;
  const label = options.attribution.hostLabel;
  if (options.locality === "local") {
    return stripOnHostLabel(options.body, label);
  }
  // remote + unknown: keep/ensure caption where truncation still shows it.
  return ensureOnHostLabelEarly(options.body, label);
}

/**
 * Only positively-local rows may look locally actionable. Remote and unknown
 * (cannot establish local) forbid inventing a local deep-link action.
 */
export function providerPackNotificationAllowsLocalAction(
  locality: ProviderPackNotificationLocality,
): boolean {
  return locality === "local";
}

/** Prefer local-machine pack notifications ahead of remote ones, then recency. */
export function compareProviderPackLocalFirst(
  a: {
    readonly attribution: ProviderPackNotificationAttribution | null;
    readonly createdAt: number;
    readonly feedId: string;
  },
  b: {
    readonly attribution: ProviderPackNotificationAttribution | null;
    readonly createdAt: number;
    readonly feedId: string;
  },
  viewing: ProviderPackViewingLocalityContext,
): number {
  const aRemote = isProviderPackNotificationRemote({
    attribution: a.attribution,
    viewing,
  });
  const bRemote = isProviderPackNotificationRemote({
    attribution: b.attribution,
    viewing,
  });
  if (aRemote !== bRemote) {
    return aRemote ? 1 : -1;
  }
  const createdAtDelta = b.createdAt - a.createdAt;
  if (createdAtDelta !== 0) return createdAtDelta;
  if (a.feedId < b.feedId) return -1;
  if (a.feedId > b.feedId) return 1;
  return 0;
}

/**
 * Visible prefix used by tests for truncation safety. Matches the rough
 * one-line body budget in the notification popover.
 */
export const PROVIDER_PACK_BODY_VISIBLE_PREFIX_CHARS = 72;

/** Whether the host label appears in the leading visible prefix of the body. */
export function hostLabelSurvivesBodyTruncation(
  body: string,
  hostLabel: string,
  visibleChars: number,
): boolean {
  const prefix = body.slice(0, Math.max(0, visibleChars));
  return prefix.includes(hostLabel);
}

function stripOnHostLabel(body: string, hostLabel: string): string {
  // Host update copy: "… is available on MacBook-Pro. Auto-download…"
  const patterns = [
    new RegExp(`\\s+on\\s+${escapeRegExp(hostLabel)}(?=[.\\s]|$)`, "gu"),
    new RegExp(`^On\\s+${escapeRegExp(hostLabel)}:\\s*`, "u"),
  ];
  let next = body;
  for (const pattern of patterns) {
    next = next.replace(pattern, "");
  }
  return next
    .replace(/\s{2,}/gu, " ")
    .replace(/\s+\./gu, ".")
    .trim();
}

/**
 * Place the machine name at the **start** of the body so one-line CSS
 * truncation keeps it visible. Prefer rewriting existing mid/end "on X"
 * captions into the leading form.
 */
function ensureOnHostLabelEarly(body: string, hostLabel: string): string {
  const leading = new RegExp(`^On\\s+${escapeRegExp(hostLabel)}:\\s*`, "u");
  if (leading.test(body)) return body;

  // Strip any existing mid-body "on <label>" so we do not double-caption.
  const withoutMid = stripOnHostLabel(body, hostLabel);
  const trimmed = withoutMid.trim();
  if (trimmed.length === 0) return `On ${hostLabel}`;
  return `On ${hostLabel}: ${trimmed}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
