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
  const released151 = new Set(
    RELEASED_151_ACCOUNT_WIDE_METHODS.filter((method) =>
      methods.includes(method),
    ),
  );
  const released154 = new Set(
    methods.filter(
      (method) =>
        method !== "environment.binding.read" && method !== "epic.getChatTitle",
    ),
  );
  const current = new Set(
    [
      ...RELEASED_151_ACCOUNT_WIDE_METHODS,
      "epic.getChatTitle",
      ...CURRENT_TEAM_COMPUTER_METHODS,
    ].filter((method) => methods.includes(method)),
  );
  return { methods, released151, released154, current };
}
