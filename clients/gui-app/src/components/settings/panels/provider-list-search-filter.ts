/** Fuzzy matching for the resource lists in Settings ▸ Providers. */
import Fuse, { type IFuseOptions } from "fuse.js";
import type {
  ModelProviderEntry,
  ProviderMcpServer,
  ProviderMcpTool,
  ProviderPlugin,
  ProviderSkill,
} from "@traycer/protocol/host/provider-native-schemas";

// Match the app's other Fuse indexes: a hit anywhere in the relevant text is useful, and a moderate threshold
// accepts ordinary misspellings without turning the list into a near-unfiltered result set.
const BASE_FUSE_OPTIONS = {
  includeScore: false,
  ignoreLocation: true,
  threshold: 0.4,
  minMatchCharLength: 1,
} as const;

/** Tool names deliberately do not participate: they are hidden until a server is expanded, so a tool-only hit
 * would need to expand or annotate the row to explain why it appeared. */
const MCP_FUSE_OPTIONS: IFuseOptions<ProviderMcpServer> = {
  ...BASE_FUSE_OPTIONS,
  keys: [{ name: "name", weight: 1 }],
};

type McpSearchableTool = Pick<
  ProviderMcpTool,
  "name" | "description" | "inputSchema"
>;

// Tool inventory is deferred until a server detail is opened, but needs the same forgiving matching as the
// outer resource list once it is visible.
const MCP_TOOL_FUSE_OPTIONS: IFuseOptions<McpSearchableTool> = {
  ...BASE_FUSE_OPTIONS,
  keys: [
    { name: "name", weight: 2 },
    { name: "description", weight: 1 },
  ],
};

/** Skill rows render their frontmatter name, description and source badge. */
const SKILLS_FUSE_OPTIONS: IFuseOptions<ProviderSkill> = {
  ...BASE_FUSE_OPTIONS,
  keys: [
    { name: "name", weight: 2 },
    { name: "description", weight: 1 },
    { name: "source", weight: 0.5 },
    { name: "path", weight: 0.5 },
  ],
};

/** The install id remains searchable as the stable identifier even when a friendly manifest name replaces it
 * onscreen. */
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

/** Model provider rows render the display name; the id is what the user typed in a config file or read in
 * someone's docs (`amazon-bedrock`, `github-copilot`). */
const MODEL_PROVIDERS_FUSE_OPTIONS: IFuseOptions<ModelProviderEntry> = {
  ...BASE_FUSE_OPTIONS,
  threshold: 0.3,
  keys: [
    { name: "name", weight: 2 },
    { name: "id", weight: 1 },
  ],
};

export function isProviderListSearchActive(query: string): boolean {
  return query.trim().length > 0;
}

export function filterProviderMcpServers(
  servers: readonly ProviderMcpServer[],
  query: string,
): readonly ProviderMcpServer[] {
  if (!isProviderListSearchActive(query)) return servers;
  return new Fuse([...servers], MCP_FUSE_OPTIONS)
    .search(query.trim())
    .map((result) => result.item);
}

/** Generic over the caller's tool shape rather than returning `McpSearchableTool`. */
export function filterProviderMcpTools<Tool extends McpSearchableTool>(
  tools: readonly Tool[],
  query: string,
): readonly Tool[] {
  if (!isProviderListSearchActive(query)) return tools;
  return new Fuse([...tools], MCP_TOOL_FUSE_OPTIONS)
    .search(query.trim())
    .map((result) => result.item);
}

export function filterProviderSkills(
  skills: readonly ProviderSkill[],
  query: string,
): readonly ProviderSkill[] {
  if (!isProviderListSearchActive(query)) return skills;
  return new Fuse([...skills], SKILLS_FUSE_OPTIONS)
    .search(query.trim())
    .map((result) => result.item);
}

export function filterModelProviders(
  entries: readonly ModelProviderEntry[],
  query: string,
): readonly ModelProviderEntry[] {
  if (!isProviderListSearchActive(query)) return entries;
  return new Fuse([...entries], MODEL_PROVIDERS_FUSE_OPTIONS)
    .search(query.trim())
    .map((result) => result.item);
}

export function filterProviderPlugins(
  plugins: readonly ProviderPlugin[],
  query: string,
): readonly ProviderPlugin[] {
  if (!isProviderListSearchActive(query)) return plugins;
  return new Fuse([...plugins], PLUGINS_FUSE_OPTIONS)
    .search(query.trim())
    .map((result) => result.item);
}
