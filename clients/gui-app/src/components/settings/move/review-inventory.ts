/**
 * Retrospective inventory rows that are not held items: Shared in use from
 * this host's applied `environment.status` items, Shared from the room from
 * `planes.room` plus the room-backed kinds, Applied on from
 * `environment.host.list@1.1` `applied[]`.
 */
import type { EnvironmentItemStatus } from "@traycer/protocol/host/environment-schemas";
import type { EnvironmentHostRecordV11 } from "@traycer/protocol/host/environment/contracts";
import type { EnvironmentPlanes } from "@/components/settings/move/cohort-rows";
import type {
  RetrospectivePageId,
  SharedInUseItem,
} from "@/components/settings/move/retrospective-sheet";

const MAIL_PASSWORD_KEY = "NOTIFICATION_SMTP_PASSWORD";
const ROOM_KINDS = new Set(["skill", "agent_selection_guide"]);

const KIND_PAGE: Readonly<Record<string, RetrospectivePageId>> = {
  managed_profile: "providers",
  env_override: "providers",
  variable: "shell",
  shell: "shell",
  mcp_server: "mcp-servers",
  agent_definition: "agent-definitions",
  setup_script: "machine-setup",
  pack_policy: "permissions",
  fallback_policy: "fallback",
  browser_agent_access: "browser-agent-access",
  auto_policy: "permissions",
};

const KIND_WORDS: Readonly<
  Record<string, { readonly one: string; readonly many: string }>
> = {
  managed_profile: { one: "1 profile", many: "profiles" },
  env_override: { one: "1 provider override", many: "provider overrides" },
  variable: { one: "1 variable", many: "variables" },
  shell: { one: "1 shell variable", many: "shell variables" },
  mcp_server: { one: "1 MCP server", many: "MCP servers" },
  agent_definition: { one: "1 agent definition", many: "agent definitions" },
  setup_script: { one: "1 setup script", many: "setup scripts" },
  pack_policy: { one: "1 permission pack", many: "permission packs" },
  fallback_policy: { one: "1 fallback policy", many: "fallback policies" },
  browser_agent_access: {
    one: "1 browser-agent access row",
    many: "browser-agent access rows",
  },
  auto_policy: { one: "1 auto policy", many: "auto policies" },
  secret: { one: "1 secret", many: "secrets" },
};

function isApplied(item: EnvironmentItemStatus): boolean {
  return item.status === "applied";
}

function looksLikeApiKey(key: string): boolean {
  return /API_KEY$/.test(key);
}

function pageForItem(item: EnvironmentItemStatus): RetrospectivePageId | null {
  if (item.key === MAIL_PASSWORD_KEY) return "notifications";
  if (item.kind === "secret") {
    return looksLikeApiKey(item.key) ? "providers" : "secrets";
  }
  return KIND_PAGE[item.kind] ?? null;
}

function groupKey(
  item: EnvironmentItemStatus,
  page: RetrospectivePageId,
): string {
  if (item.key === MAIL_PASSWORD_KEY) return "mail";
  if (item.kind === "secret" && looksLikeApiKey(item.key)) return "api-keys";
  return `${page}:${item.kind}`;
}

function groupLabel(
  items: readonly EnvironmentItemStatus[],
  page: RetrospectivePageId,
): string {
  if (items.some((item) => item.key === MAIL_PASSWORD_KEY)) {
    return "notification settings";
  }
  if (
    page === "providers" &&
    items.every((item) => looksLikeApiKey(item.key))
  ) {
    return items.length === 1 ? "1 API key" : `${items.length} API keys`;
  }
  const words = KIND_WORDS[items[0]?.kind ?? ""] ?? {
    one: "1 item",
    many: "items",
  };
  return items.length === 1 ? words.one : `${items.length} ${words.many}`;
}

/** Applied items that reached Personal, grouped for the Shared in use row. */
export function sharedInUseFromItems(
  items: readonly EnvironmentItemStatus[],
): readonly SharedInUseItem[] {
  const groups = new Map<
    string,
    {
      readonly page: RetrospectivePageId;
      readonly items: EnvironmentItemStatus[];
    }
  >();
  const order: string[] = [];
  for (const item of items) {
    if (!isApplied(item) || ROOM_KINDS.has(item.kind)) continue;
    const page = pageForItem(item);
    if (page === null) continue;
    const key = groupKey(item, page);
    const existing = groups.get(key);
    if (existing === undefined) {
      order.push(key);
      groups.set(key, { page, items: [item] });
    } else {
      existing.items.push(item);
    }
  }
  return order.map((key) => {
    const group = groups.get(key);
    if (group === undefined) {
      return {
        id: key,
        label: "0 items",
        names: [],
        page: "providers",
        includesMailPassword: false,
      };
    }
    return {
      id: key,
      label: groupLabel(group.items, group.page),
      names: group.items.map((item) => item.key),
      page: group.page,
      includesMailPassword: group.items.some(
        (item) => item.key === MAIL_PASSWORD_KEY,
      ),
    };
  });
}

/**
 * What an earlier build projected into the configuration's room. Null when
 * the room plane is this computer's.
 */
export function roomSharedLine(
  planes: EnvironmentPlanes | null,
  items: readonly EnvironmentItemStatus[],
): string | null {
  if (planes === null) return null;
  if (planes.room !== "shared_unrecorded" && planes.room !== "moved") {
    return null;
  }
  const applied = items.filter(
    (item) => isApplied(item) && ROOM_KINDS.has(item.kind),
  );
  const skillCount = applied.filter((item) => item.kind === "skill").length;
  const hasGuide = applied.some(
    (item) => item.kind === "agent_selection_guide",
  );
  const parts: string[] = [];
  if (skillCount > 0) {
    parts.push(
      skillCount === 1
        ? "The skills folder (1 skill)"
        : `The skills folder (${skillCount} skills)`,
    );
  }
  if (hasGuide) parts.push("the agent selection guide");
  if (parts.length === 0) return "Skills and the guide";
  if (parts.length === 1) return parts[0] ?? "Skills and the guide";
  return `${parts[0]} and ${parts[1]}`;
}

/** Hosts of this configuration that have applied at least one item. */
export function appliedOnHostNames(
  hosts: readonly EnvironmentHostRecordV11[],
): readonly string[] {
  const names: string[] = [];
  for (const host of hosts) {
    if (!host.applied.some((entry) => entry.state === "applied")) continue;
    const name = host.hostLabel;
    if (name !== null && name.length > 0 && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}
