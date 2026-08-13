// Centralized localStorage key construction for the gui-app persisted stores.
// Mirrors the `src/lib/query-keys/` convention: durable builders live here and
// are re-exported through the `index.ts` barrel, so no store rebuilds a key
// shape ad hoc.
//
// OUTPUT-PRESERVING: every builder emits each store's CURRENT localStorage key
// byte-for-byte. A mismatch changes a store's key and wipes that store. The
// guarantee is the hand-transcribed non-circular test in
// `__tests__/keys.test.ts`.

export const PERSIST_PREFIX = "traycer-gui-app";

// Account-scoped stores bucket their key by the signed-in identity; an absent/empty
// identity collapses to the shared anonymous bucket. Preserved verbatim from
// the per-store `ANONYMOUS_USER_KEY = "anon"` + `value.length > 0` logic.
export const scopeBucket = (value: string | null): string =>
  value !== null && value.length > 0 ? value : "anon";

export const persistKey = (name: string): string => `${PERSIST_PREFIX}:${name}`;

export const scopedPersistKey = (name: string, ...segments: string[]): string =>
  [persistKey(name), ...segments].join(":");

// ── Scoped builders (reproduce today's exact strings) ──────────────────────
// Each scoped store namespaces its key by the signed-in identity; the bridges
// pass the account email (or `null` → the shared `anon` bucket). The first
// three are named `email` because that is literally what their bridges pass;
// canvas/open-epic take a neutral `identity` (they receive the same email at
// runtime — the older `userId` name was a misnomer). The registry never changes
// WHICH value a store passes, so keys stay byte-identical; only construction is
// centralized. Unifying the parameter naming further is a non-goal.

export const composerRunSettingsKey = (email: string | null): string =>
  scopedPersistKey("composer-run-settings", scopeBucket(email));

export const composerHarnessMemoryKey = (email: string | null): string =>
  scopedPersistKey("composer-harness-memory", scopeBucket(email));

export const worktreeIntentMemoryKey = (email: string | null): string =>
  scopedPersistKey("worktree-intent-memory", scopeBucket(email));

export const worktreeIntentStagingKey = (email: string | null): string =>
  scopedPersistKey("worktree-intent-staging", scopeBucket(email));

export const epicCanvasKey = (identity: string | null): string =>
  scopedPersistKey("epic-canvas", scopeBucket(identity));

export const landingTerminalsKey = (identity: string | null): string =>
  scopedPersistKey("landing-terminals", scopeBucket(identity));

// Arg order is `(identity, epicId)` but the emitted string keeps today's
// `…:open-epic:{identityBucket}:{epicId}` order (the current store's local
// `persistKey(epicId, userId)` emitted exactly this).
export const openEpicKey = (identity: string | null, epicId: string): string =>
  scopedPersistKey("open-epic", scopeBucket(identity), epicId);

// App-level host picker memory. This is intentionally unscoped: creation
// surfaces share one "last selected host" value across the GUI app.
export const lastSelectedHostKey = (): string =>
  persistKey("last-selected-host");

// The composer's PR/Issue mention filters, sticky per (task, section).
// Identity-scoped like the run settings above, NOT like the host picker: a
// stored repository selection names a GitHub host, owner and repo - private
// coordinates for a private repository - so an identity-free bucket would
// leave them readable after sign-out and hand them to the next account on
// this profile. The lifecycle bridge retargets on sign-in and wipes the
// bucket on sign-out, same as composer run settings.
export const githubMentionFiltersKey = (email: string | null): string =>
  scopedPersistKey(STORE_KEYS.githubMentionFilters, scopeBucket(email));

// The hostId this machine's OWN local host last published. Unscoped and
// identity-free like the picker memory: it is a fact about this machine, not
// about who is signed in. The directory uses it to keep the machine's own
// host out of the remote arm while the local host is booting - the boot
// window is exactly when no live local snapshot exists to tell it apart.
export const lastLocalHostIdKey = (): string =>
  persistKey("last-local-host-id");

export const appLocalNotificationsKey = (userId: string | null): string =>
  scopedPersistKey("app-local-notifications", scopeBucket(userId));

export const appLocalNotificationDisplayReceiptPrefix = (
  userId: string,
): string =>
  scopedPersistKey(
    "app-local-notification-display-receipt",
    encodeURIComponent(userId),
  );

export const appLocalNotificationDisplayReceiptNotificationPrefix = (input: {
  readonly userId: string;
  readonly notificationId: string;
}): string =>
  scopedPersistKey(
    "app-local-notification-display-receipt",
    encodeURIComponent(input.userId),
    encodeURIComponent(input.notificationId),
  );

export const appLocalNotificationDisplayReceiptKey = (input: {
  readonly userId: string;
  readonly notificationId: string;
  readonly updatedAt: number;
}): string =>
  `${appLocalNotificationDisplayReceiptNotificationPrefix(input)}:${String(input.updatedAt)}`;

export const appLocalNotificationCompletionReceiptPrefix = (
  userId: string,
): string =>
  scopedPersistKey(
    "app-local-notification-completion-receipt",
    encodeURIComponent(userId),
  );

export const appLocalNotificationCompletionReceiptHostPrefix = (input: {
  readonly userId: string;
  readonly originHostId: string;
}): string =>
  scopedPersistKey(
    "app-local-notification-completion-receipt",
    encodeURIComponent(input.userId),
    encodeURIComponent(input.originHostId),
  );

export const appLocalNotificationCompletionReceiptKey = (input: {
  readonly userId: string;
  readonly originHostId: string;
  readonly occurrenceKey: string;
}): string =>
  scopedPersistKey(
    "app-local-notification-completion-receipt",
    encodeURIComponent(input.userId),
    encodeURIComponent(input.originHostId),
    encodeURIComponent(input.occurrenceKey),
  );

// Interview answer drafts persist ONE localStorage key per (chatId, blockId)
// instead of a single full-snapshot Zustand blob. Separate keys prevent a
// full-map write from one window (or a stale store context) from erasing an
// unrelated chat's draft persisted by another window — the same isolation the
// app-local display receipts above rely on. Both segments are percent-encoded so
// a `:` inside an id can never split the key.
export const interviewDraftKeyPrefix = (): string =>
  `${persistKey("interview-drafts")}:`;

export const interviewDraftKey = (chatId: string, blockId: string): string =>
  scopedPersistKey(
    "interview-drafts",
    encodeURIComponent(chatId),
    encodeURIComponent(blockId),
  );

export const readingPositionKeyPrefix = (accountId: string): string =>
  `${scopedPersistKey(
    "reading-position",
    encodeURIComponent(scopeBucket(accountId)),
  )}:`;

// Host-scoped (not identity-scoped): the worktrees panel's warm-open snapshot
// of per-path activity entries (worktrees-enrichment-persistence.ts). A host
// id is always non-empty, so no `scopeBucket` collapse applies.
export const worktreeActivityCacheKey = (hostId: string): string =>
  scopedPersistKey("worktree-activity-cache", hostId);

// Host-scoped sibling of `worktreeActivityCacheKey`: the base listing rows
// (worktrees-listing-query.ts), so the panel paints its row list instantly on
// launch while the live listing refetches behind it.
export const worktreeListingCacheKey = (hostId: string): string =>
  scopedPersistKey("worktree-listing-cache", hostId);
// ── Catalog ────────────────────────────────────────────────────────────────
// `kind` tells enumeration the shape of each persisted surface:
//   - "static"  : plain `traycer-gui-app:<leaf>` localStorage key.
//   - "scoped"  : `traycer-gui-app:<leaf>:<bucket>[…]` localStorage key.
//   - "session" : sessionStorage key (not localStorage).
//   - "channel" : a BroadcastChannel NAME, not a storage key.
//
// The `leaf` is the DIVERGENCE-CORRECT key leaf, not the store/file name (six
// stores diverge — see the literals below). Non-zustand `traycer-gui-app:` keys
// are cataloged here too; builders may stay local to their owner unless a
// centralized builder is useful. Auth (`traycer.*`) keys are intentionally
// excluded.
export type PersistStoreKind = "static" | "scoped" | "session" | "channel";

export interface PersistStoreEntry {
  readonly camelName: string;
  readonly leaf: string;
  readonly kind: PersistStoreKind;
}

export const PERSIST_STORES = [
  // ── Scoped zustand stores (9) ────────────────────────────────────────────
  {
    camelName: "composerRunSettings",
    leaf: "composer-run-settings",
    kind: "scoped",
  },
  {
    camelName: "composerHarnessMemory",
    leaf: "composer-harness-memory",
    kind: "scoped",
  },
  {
    camelName: "worktreeIntentMemory",
    leaf: "worktree-intent-memory",
    kind: "scoped",
  },
  {
    camelName: "worktreeIntentStaging",
    leaf: "worktree-intent-staging",
    kind: "scoped",
  },
  { camelName: "epicCanvas", leaf: "epic-canvas", kind: "scoped" },
  {
    camelName: "landingTerminals",
    leaf: "landing-terminals",
    kind: "scoped",
  },
  { camelName: "openEpic", leaf: "open-epic", kind: "scoped" },
  {
    camelName: "appLocalNotifications",
    leaf: "app-local-notifications",
    kind: "scoped",
  },
  { camelName: "readingPosition", leaf: "reading-position", kind: "scoped" },

  // ── Scoped non-zustand key families (1) ──────────────────────────────────
  {
    camelName: "appLocalNotificationCompletionReceipt",
    leaf: "app-local-notification-completion-receipt",
    kind: "scoped",
  },

  // ── Static zustand stores (27) ───────────────────────────────────────────
  { camelName: "onboarding", leaf: "onboarding", kind: "static" },
  { camelName: "commandPalette", leaf: "command-palette", kind: "static" },
  { camelName: "composerDraft", leaf: "composer-drafts", kind: "static" },
  // Enumerated under the `interview-drafts` leaf, but persisted as one key per
  // (chatId, blockId) — `interview-drafts:{encChatId}:{encBlockId}` — for
  // cross-window isolation (see `interviewDraftKey`). The `traycer-gui-app:`
  // prefix sweep in `wipe.ts` still clears every per-draft key.
  {
    camelName: "interviewDraft",
    leaf: "interview-drafts",
    kind: "static",
  },
  {
    camelName: "artifactReadState",
    leaf: "artifact-read-state",
    kind: "static",
  },
  { camelName: "gitPanel", leaf: "git-panel", kind: "static" },
  { camelName: "prPresence", leaf: "pr-presence", kind: "static" },
  {
    camelName: "initialChatHandoff",
    leaf: "initial-chat-handoffs",
    kind: "static",
  },
  { camelName: "leftPanel", leaf: "left-panel", kind: "static" },
  { camelName: "commGraphPanel", leaf: "comm-graph-panel", kind: "static" },
  { camelName: "fileTree", leaf: "file-tree", kind: "static" },
  { camelName: "historySearch", leaf: "history-search", kind: "static" },
  { camelName: "landingDraft", leaf: "draft", kind: "static" },
  {
    camelName: "hostUpdateBanner",
    leaf: "host-update-banner",
    kind: "static",
  },
  { camelName: "keybinding", leaf: "keybindings", kind: "static" },
  {
    camelName: "localSnapshotClear",
    leaf: "local-snapshot-clears",
    kind: "static",
  },
  { camelName: "settings", leaf: "settings", kind: "static" },
  { camelName: "settingsSection", leaf: "settings-section", kind: "static" },
  {
    camelName: "worktreesSettingsView",
    leaf: "worktrees-settings-view",
    kind: "static",
  },
  {
    camelName: "rateLimitPopover",
    leaf: "rate-limit-popover",
    kind: "static",
  },
  { camelName: "tabs", leaf: "tabs", kind: "static" },
  {
    camelName: "workspaceFolders",
    leaf: "workspace-folders",
    kind: "static",
  },
  {
    camelName: "providersWorkspaceSelection",
    leaf: "providers-workspace-selection",
    kind: "static",
  },
  {
    camelName: "providerLoginTerminals",
    leaf: "provider-login-terminals",
    kind: "static",
  },
  {
    camelName: "githubMentionFilters",
    leaf: "github-mention-filters",
    kind: "static",
  },

  // ── Non-zustand keys ─────────────────────────────────────────────────────
  // `last-route:<windowId>` — per-window router history (persistent-history.ts).
  { camelName: "lastRoute", leaf: "last-route", kind: "static" },
  // App-level creation-surface host picker memory (host-directory-service.ts).
  { camelName: "lastSelectedHost", leaf: "last-selected-host", kind: "static" },
  // This machine's own local host id (host-directory-service.ts).
  { camelName: "lastLocalHostId", leaf: "last-local-host-id", kind: "static" },
  // `consumed-initial-route:<windowId>:<route>` — sessionStorage guard.
  {
    camelName: "consumedInitialRoute",
    leaf: "consumed-initial-route",
    kind: "session",
  },
  // `deleted-epic-events:last` — localStorage cross-tab notification mirror.
  {
    camelName: "deletedEpicEventsLast",
    leaf: "deleted-epic-events:last",
    kind: "static",
  },
  // `deleted-epic-events:v1` — a BroadcastChannel NAME, not storage.
  {
    camelName: "deletedEpicEventsChannel",
    leaf: "deleted-epic-events:v1",
    kind: "channel",
  },
  // Ephemeral exact-turn completion acks shared across renderer windows.
  {
    camelName: "liveChatCompletionAcknowledgementsChannel",
    leaf: "live-chat-completion-acknowledgements:v1",
    kind: "channel",
  },
  // One monotonic key per displayed app-local notification version. Separate
  // keys prevent an unrelated full-snapshot Zustand write in another window
  // from erasing a receipt.
  {
    camelName: "appLocalNotificationDisplayReceipt",
    leaf: "app-local-notification-display-receipt",
    kind: "scoped",
  },
  // `worktree-activity-cache:<hostId>` — the worktrees panel's warm-open
  // TanStack snapshot (worktrees-enrichment-persistence.ts), host-scoped.
  {
    camelName: "worktreeActivityCache",
    leaf: "worktree-activity-cache",
    kind: "scoped",
  },
  // `worktree-listing-cache:<hostId>` — the worktrees panel's base listing
  // snapshot (worktrees-listing-query.ts), host-scoped.
  {
    camelName: "worktreeListingCache",
    leaf: "worktree-listing-cache",
    kind: "scoped",
  },
] as const satisfies ReadonlyArray<PersistStoreEntry>;

// Ergonomic, typo-safe `{ camelName: "leaf" }` map derived from the catalog.
// The keyed type means a store referencing `STORE_KEYS.<wrongName>` fails to
// compile — the catalog is the single source of truth for every store's leaf.
type PersistStoreCamelName = (typeof PERSIST_STORES)[number]["camelName"];
export const STORE_KEYS = Object.fromEntries(
  PERSIST_STORES.map((entry) => [entry.camelName, entry.leaf]),
) as Readonly<Record<PersistStoreCamelName, string>>;

// Runtime uniqueness assertion: an object literal does not guarantee no two
// entries share a leaf, so prove it at module load. Two stores sharing a leaf
// would silently collide on one localStorage key.
const catalogLeaves = new Set(PERSIST_STORES.map((entry) => entry.leaf));
if (catalogLeaves.size !== PERSIST_STORES.length) {
  throw new Error(
    "persist registry: two PERSIST_STORES entries share a leaf — leaves must be unique",
  );
}
