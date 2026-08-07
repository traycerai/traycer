/**
 * Fuzzy matching for the resource lists in Settings ▸ Providers. Keeping the
 * rules outside the tabs means the rows, empty states, and result announcements
 * share one definition of a match; a blank query also returns the original
 * array, so normal list renders preserve memo-friendly identity.
 */
import Fuse, { type IFuseOptions } from "fuse.js";
import type {
  ProviderMcpServer,
  ProviderMcpTool,
  ProviderPlugin,
  ProviderSkill,
} from "@traycer/protocol/host/provider-native-schemas";

// Match the app's other Fuse indexes: a hit anywhere in the relevant text is
// useful, and a moderate threshold accepts ordinary misspellings without
// turning the list into a near-unfiltered result set.
const BASE_FUSE_OPTIONS = {
  includeScore: false,
  ignoreLocation: true,
  threshold: 0.4,
  minMatchCharLength: 1,
} as const;

/**
 * MCP rows visibly identify a server only by its name, which is also its
 * stable configuration key. Tool names deliberately do not participate:
 * they are hidden until a server is expanded, so a tool-only hit would need to
 * expand or annotate the row to explain why it appeared.
 */
const MCP_FUSE_OPTIONS: IFuseOptions<ProviderMcpServer> = {
  ...BASE_FUSE_OPTIONS,
  keys: [{ name: "name", weight: 1 }],
};

type McpSearchableTool = Pick<
  ProviderMcpTool,
  "name" | "description" | "inputSchema"
>;

// Tool inventory is deferred until a server detail is opened, but needs the
// same forgiving matching as the outer resource list once it is visible.
// Keeping both indexes here prevents each resource detail from inventing a
// near-identical matcher with subtly different typo behavior.
const MCP_TOOL_FUSE_OPTIONS: IFuseOptions<McpSearchableTool> = {
  ...BASE_FUSE_OPTIONS,
  keys: [
    { name: "name", weight: 2 },
    { name: "description", weight: 1 },
  ],
};

/**
 * Skill rows render their frontmatter name, description and source badge.
 * `source:path` is the stable identity used to key a row, so its path is the
 * one non-rendered field included for users who know the on-disk location.
 */
const SKILLS_FUSE_OPTIONS: IFuseOptions<ProviderSkill> = {
  ...BASE_FUSE_OPTIONS,
  keys: [
    { name: "name", weight: 2 },
    { name: "description", weight: 1 },
    { name: "source", weight: 0.5 },
    { name: "path", weight: 0.5 },
  ],
};

/**
 * Plugin rows render the manifest name (or the install name), description,
 * version and source when present. The install id remains searchable as the
 * stable identifier even when a friendly manifest name replaces it onscreen.
 */
const PLUGINS_FUSE_OPTIONS: IFuseOptions<ProviderPlugin> = {
  ...BASE_FUSE_OPTIONS,
  keys: [
    { name: "displayName", weight: 2 },
    { name: "name", weight: 2 },
    { name: "description", weight: 1 },
    { name: "version", weight: 0.5 },
    { name: "source", weight: 0.5 },
    { name: "id", weight: 0.5 },
  ],
};

export function isProviderListSearchActive(query: string): boolean {
  return query.trim().length > 0;
}

/** See {@link MCP_FUSE_OPTIONS} for the visible-row matching rule. */
export function filterProviderMcpServers(
  servers: readonly ProviderMcpServer[],
  query: string,
): readonly ProviderMcpServer[] {
  if (!isProviderListSearchActive(query)) return servers;
  return new Fuse([...servers], MCP_FUSE_OPTIONS)
    .search(query.trim())
    .map((result) => result.item);
}

/**
 * See {@link MCP_TOOL_FUSE_OPTIONS} for the deferred-detail matching rule.
 *
 * Generic over the caller's tool shape rather than returning
 * `McpSearchableTool`: searching is a FILTER, and a filter that narrowed its
 * elements to the fields the matcher happens to read would silently strip
 * everything else off them. It did exactly that to `enabled`, which is how a
 * searchable tool list became one that could not offer a toggle.
 */
export function filterProviderMcpTools<Tool extends McpSearchableTool>(
  tools: readonly Tool[],
  query: string,
): readonly Tool[] {
  if (!isProviderListSearchActive(query)) return tools;
  return new Fuse([...tools], MCP_TOOL_FUSE_OPTIONS)
    .search(query.trim())
    .map((result) => result.item);
}

/** See {@link SKILLS_FUSE_OPTIONS} for the visible-row matching rule. */
export function filterProviderSkills(
  skills: readonly ProviderSkill[],
  query: string,
): readonly ProviderSkill[] {
  if (!isProviderListSearchActive(query)) return skills;
  return new Fuse([...skills], SKILLS_FUSE_OPTIONS)
    .search(query.trim())
    .map((result) => result.item);
}

/** See {@link PLUGINS_FUSE_OPTIONS} for the visible-row matching rule. */
export function filterProviderPlugins(
  plugins: readonly ProviderPlugin[],
  query: string,
): readonly ProviderPlugin[] {
  if (!isProviderListSearchActive(query)) return plugins;
  return new Fuse([...plugins], PLUGINS_FUSE_OPTIONS)
    .search(query.trim())
    .map((result) => result.item);
}
