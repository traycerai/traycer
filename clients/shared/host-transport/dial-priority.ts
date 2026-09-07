/**
 * Which host sockets the dial gate lets through first. `background` means no rendered surface waits on this method.
 * Default is `interactive` so an unlisted method is never starved.
 */
export type DialPriority = "interactive" | "background";

/** Methods with no mounted surface waiting on the first answer. Epic lanes, artifact/chat/terminal subscribe, and epic.getWorkspaceContext stay interactive. */
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

export function dialPriorityForMethod(method: string): DialPriority {
  return BACKGROUND_METHODS.has(method) ? "background" : "interactive";
}
