import {
  HOST_STREAM_RPC_ROUTES,
  HOST_UNARY_RPC_ROUTES,
} from "../host-client/host-rpc-routing";

// Resolver registrations at host-v1.4.0 through host-v1.5.1 were counted by
// host tag in the internal repository; source: critique-inputs/closure-c-app.md, Q4.
export const RELEASED_151_ACCOUNT_WIDE_METHODS = [
  "autoPolicy.get",
  "autoPolicy.set",
  "epic.listTasks",
  "host.notifications.cloudFeed.clear",
  "host.notifications.cloudFeed.clearAll",
  "host.notifications.cloudFeed.markAllRead",
  "host.notifications.cloudFeed.markRead",
  "host.notifications.cloudFeed.resolve",
  "host.notifications.cloudFeed.subscribe",
  "organization.command",
  "organization.history",
  "organization.read",
  "organization.refresh",
  "organization.subscribe",
] as const;

// Resolver and stream registrations counted at host-v1.5.2, host-v1.5.3, and
// host-v1.5.4 in the internal repository: traycer-host/src/transport/rpc/resolvers
// and traycer-host/src/transport/rpc/stream (closure-c-app.md, Q4). These are
// the 56 account-wide methods except environment.binding.read and epic.getChatTitle.
export const RELEASED_154_ACCOUNT_WIDE_METHODS = [
  "autoPolicy.get",
  "autoPolicy.set",
  "environment.configuration.guide.get",
  "environment.configuration.guide.reset",
  "environment.configuration.guide.set",
  "environment.configuration.items",
  "environment.configuration.revision",
  "environment.configuration.items.delete",
  "environment.configuration.items.put",
  "environment.configuration.mcpServers.delete",
  "environment.configuration.mcpServers.list",
  "environment.configuration.mcpServers.put",
  "environment.configuration.mcpServers.setEnabled",
  "environment.configuration.policy.put",
  "environment.configuration.skills.list",
  "environment.configuration.skills.remove",
  "environment.configuration.skills.setPolicy",
  "environment.configuration.skills.setProviders",
  "environment.configuration.skills.upload",
  "environment.history",
  "environment.host.list",
  "environment.invitations.accept",
  "environment.invitations.list",
  "environment.list",
  "environment.members",
  "environment.members.invite",
  "environment.members.noticeSeen",
  "environment.members.remove",
  "environment.members.seats",
  "environment.members.setRole",
  "environment.plans.list",
  "environment.plans.unlink",
  "environment.plans.unlinkPreview",
  "environment.secrets.consent",
  "environment.secrets.create",
  "environment.secrets.destroy",
  "environment.secrets.list",
  "environment.secrets.replaceValue",
  "environment.secrets.rotation",
  "environment.secrets.undo",
  "environment.secrets.verify",
  "environment.secrets.versions",
  "epic.listTasks",
  "host.notifications.cloudFeed.clear",
  "host.notifications.cloudFeed.clearAll",
  "host.notifications.cloudFeed.markAllRead",
  "host.notifications.cloudFeed.markRead",
  "host.notifications.cloudFeed.resolve",
  "host.notifications.cloudFeed.subscribe",
  "organization.command",
  "organization.history",
  "organization.read",
  "organization.refresh",
  "organization.subscribe",
] as const;

export const CURRENT_TEAM_COMPUTER_METHODS = new Set([
  "environment.configuration.guide.get",
  "environment.configuration.guide.reset",
  "environment.configuration.guide.set",
  "environment.configuration.skills.list",
  "environment.configuration.skills.remove",
  "environment.configuration.skills.setPolicy",
  "environment.configuration.skills.setProviders",
  "environment.configuration.skills.upload",
]);

export const CURRENT_ACCOUNT_WIDE_METHODS = [
  "autoPolicy.get",
  "autoPolicy.set",
  "epic.listTasks",
  "host.notifications.cloudFeed.clear",
  "host.notifications.cloudFeed.clearAll",
  "host.notifications.cloudFeed.markAllRead",
  "host.notifications.cloudFeed.markRead",
  "host.notifications.cloudFeed.resolve",
  "host.notifications.cloudFeed.subscribe",
  "organization.command",
  "organization.history",
  "organization.read",
  "organization.refresh",
  "organization.subscribe",
  "epic.getChatTitle",
  "environment.configuration.guide.get",
  "environment.configuration.guide.reset",
  "environment.configuration.guide.set",
  "environment.configuration.skills.list",
  "environment.configuration.skills.remove",
  "environment.configuration.skills.setPolicy",
  "environment.configuration.skills.setProviders",
  "environment.configuration.skills.upload",
] as const;

export function accountWideManifestFixtures(): {
  readonly methods: readonly string[];
  readonly released151: ReadonlySet<string>;
  readonly released154: ReadonlySet<string>;
  readonly current: ReadonlySet<string>;
} {
  const methods = [
    ...Object.entries(HOST_UNARY_RPC_ROUTES),
    ...Object.entries(HOST_STREAM_RPC_ROUTES),
  ]
    .filter(([, route]) => route === "account-wide")
    .map(([method]) => method)
    .sort();
  const released151 = new Set(RELEASED_151_ACCOUNT_WIDE_METHODS);
  const released154 = new Set(RELEASED_154_ACCOUNT_WIDE_METHODS);
  const current = new Set(CURRENT_ACCOUNT_WIDE_METHODS);
  return { methods, released151, released154, current };
}
