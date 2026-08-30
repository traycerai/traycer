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
 */
const BACKGROUND_METHODS: ReadonlySet<string> = new Set([
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
