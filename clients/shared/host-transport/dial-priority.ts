/**
 * Which host sockets the dial gate (`ws-dial-gate.ts`) lets through first.
 *
 * Two values rather than a numeric rank: the gate's only decision is which
 * queue to drain next, and a number invites per-call-site tuning that nothing
 * can verify. `"background"` is a claim about the METHOD - "no rendered
 * surface is waiting on this call" - not about the moment it happens to be
 * issued in, which is why the table below is keyed by method name and lives in
 * one place instead of being threaded through the call sites.
 */
export type DialPriority = "interactive" | "background";

/**
 * The methods that may wait.
 *
 * Drawn from the measured boot enumeration (cold-open design §3, lever 2): at
 * renderer boot this app puts ~50 handshakes in flight inside 300 ms, and the
 * active Epic's two lanes - created at 1313 ms - completed at 5642 ms, behind
 * them. Almost all of that flood is prefetch and reconciliation whose results
 * nothing on screen is blocked on:
 *
 *   - `agent.gui.listModels` is one socket PER HARNESS (~20) from
 *     `HarnessCatalogPrefetcher`, cached with `staleTime: Infinity`;
 *   - `host.status` is one per incompatible host from the compatibility
 *     recovery fan-out;
 *   - `epic.getTaskContexts` is the tab-existence reconciler's chunks;
 *   - the remaining streams are app-chrome subscriptions (notifications,
 *     activity, worktrees, providers, chat records, terminal lists) that
 *     populate surfaces the user has not looked at yet.
 *
 * Everything absent from this set is `interactive`, which is the whole point
 * of the default: a method nobody thought about is never silently starved, and
 * adding an RPC does not require touching this file. The failure mode of an
 * over-inclusive list is a visible stall; the failure mode of an
 * under-inclusive one is that the gate is merely FIFO, which is what it was
 * before this table and still 500 ms better than no gate at all.
 *
 * Deliberately NOT here, though they look similar: the Epic lanes
 * (`epic.status.subscribe`, `epic.state.subscribe`), `artifact.subscribe`,
 * `chat.subscribe`, `terminal.subscribe` and `epic.getWorkspaceContext` - each
 * one has a mounted tile or a mounted shell waiting on its first frame.
 *
 * ## The second pass, from the re-measure
 *
 * The first table was drawn from what the boot flood was ALREADY dialling as
 * background. The re-measure enumerated what it dialled INTERACTIVE-by-default
 * and asked of each one the only question this file answers: which rendered
 * surface waits on its FIRST answer. Sixteen were examined; twelve moved.
 *
 * | method | surface that waits on the first answer |
 * | --- | --- |
 * | `providers.list` | none. Provider rows in the composer's harness/model picker and Settings ▸ Providers - the same picker whose catalog (`agent.gui.listHarnesses` / `listModels`) is already background; the reauth banner it also feeds renders nothing until a provider is actually expired. |
 * | `epic.recordViewed` | none. A `useHostMutation` write. |
 * | `host.notifications.markRead` | none. A `useHostMutation` write. |
 * | `host.chatFork.get` | none. Mounted app-wide in `app-shell.tsx:49` for its POLL EDGE; the per-chat fork indicator it feeds is derived from the cache invalidation a later answer triggers, not from the first one. |
 * | `host.notifications.feed.subscribe` | none. The notifications popover (user-opened) and the bell's unread dot. |
 * | `host.notifications.cloudFeed.subscribe` | none. The same feed, cloud half. |
 * | `resources.subscribe` | none. The resource-monitor popover (user-opened); `resources-stream-mount.tsx` mounts it app-wide for the indicator. |
 * | `epic.chatBackupStatus` | none. The Epic connection pill's backup chip - `useEpicChatBackupStatus` answers `null` until known and the pill renders without it. |
 * | `browser.sessions` | none. The composer's @-mention list (`use-mention-items.ts`), resolved when the picker opens. |
 * | `epic.listCollaborators` | none. The chat sidebar's shared-with-task glyph (`taskHasCollaborators`) and the sharing panel (user-opened); the rows render before it answers. |
 * | `epic.listCommentThreads` | none. Comment anchors DECORATE an already-rendered tile body, and the state lane is the primary source (`resolveArtifactCommentThreads` treats this poll as the fallback); the comment sidebar and hover popover are user-opened. |
 * | `worktree.listBindingsForEpic` | none. The @-mention picker and the git-diff panel, both user-opened; the landing composer calls it at SUBMIT rather than at mount. |
 *
 * Four stayed `interactive`, and they are the reason the reserve exists rather
 * than a bigger background list: `epic.listTasks` IS the landing list;
 * `epic.listChatRecords` and `epic.listTuiAgents` ARE the sidebar's chat rows;
 * and `epic.listCloudChats` is interleaved into those same rows
 * (`mergeChatListEntries`), so a late answer is a visibly incomplete row set
 * rather than a decoration arriving second.
 */
const BACKGROUND_METHODS: ReadonlySet<string> = new Set([
  // From the boot enumeration (lever 2).
  "agent.gui.listModels",
  "agent.gui.listHarnesses",
  "host.getRateLimitUsage",
  "host.status",
  "epic.getTaskContexts",
  "host.notifications.indicatorState",
  "worktree.listAllForHost",
  "worktree.changed",
  "providers.changed",
  "host.chatRecords.subscribe",
  "notifications.subscribe",
  "agent.activity.subscribe",
  "terminal.list",
  "terminal.plain.list",
  "terminal.plain.subscribeList",
  // From the re-measure (lever 6). Evidence per method in the table above.
  "providers.list",
  "epic.recordViewed",
  "host.notifications.markRead",
  "host.chatFork.get",
  "host.notifications.feed.subscribe",
  "host.notifications.cloudFeed.subscribe",
  "resources.subscribe",
  "epic.chatBackupStatus",
  "browser.sessions",
  "epic.listCollaborators",
  "epic.listCommentThreads",
  "worktree.listBindingsForEpic",
]);

/**
 * Classifies the method a socket is being dialed FOR. Both transports know
 * this at the moment they dial - `WsRpcClient` is inside the call, and a
 * `WsStreamSession` is bound to one subscription for its lifetime - so nothing
 * has to be inferred from the URL, which carries no method at all.
 */
export function dialPriorityForMethod(method: string): DialPriority {
  return BACKGROUND_METHODS.has(method) ? "background" : "interactive";
}
