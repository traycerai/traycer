import { describe, expect, it } from "vitest";
import type {
  ProviderMcpServer,
  ProviderMcpTool,
  ProviderPlugin,
  ProviderSkill,
} from "@traycer/protocol/host/provider-native-schemas";
import {
  filterProviderMcpServers,
  filterProviderMcpTools,
  filterProviderPlugins,
  filterProviderSkills,
  isProviderListSearchActive,
} from "@/components/settings/panels/provider-list-search-filter";

function server(name: string): ProviderMcpServer {
  return {
    name,
    enabled: true,
    transport: {
      type: "http",
      url: "https://example.com",
      auth: null,
    },
    status: "connected",
    statusSource: "probe",
    statusDetail: null,
    tools: [],
    discoveryPending: false,
    instructions: null,
    configOnly: false,
    stdioDegraded: false,
  };
}

const SERVERS: readonly ProviderMcpServer[] = [
  server("context7"),
  server("github"),
];

const TOOLS: readonly ProviderMcpTool[] = [
  {
    name: "search_code",
    description: "Search the configured repository.",
    inputSchema: null,
    enabled: true,
    readOnly: false,
    denySources: [],
  },
  {
    name: "list_branches",
    description: "List every reachable branch.",
    inputSchema: null,
    enabled: true,
    readOnly: false,
    denySources: [],
  },
];

const SKILLS: readonly ProviderSkill[] = [
  {
    name: "find-skills",
    description: "Helps users discover and install agent skills.",
    path: "/Users/dev/.agents/skills/find-skills",
    source: "shared",
  },
  {
    name: "release-notes",
    description: "Write release notes from a changeset.",
    path: "/Users/dev/.traycer/managed-skills/release-notes",
    source: "managed",
  },
];

const PLUGINS: readonly ProviderPlugin[] = [
  {
    id: "pdf@openai-primary-runtime",
    name: "pdf",
    displayName: "PDF tools",
    description: "Read and create PDF documents.",
    version: "26.802.11031",
    source: "openai-primary-runtime",
    enabled: true,
    readOnly: true,
    hasIcon: false,
    hasDarkIcon: false,
  },
  {
    id: "slides@openai-primary-runtime",
    name: "slides",
    displayName: null,
    description: "Create presentations.",
    version: "26.802.11031",
    source: "openai-primary-runtime",
    enabled: true,
    readOnly: true,
    hasIcon: false,
    hasDarkIcon: false,
  },
];

describe("provider resource fuzzy filters", () => {
  it("returns each input unchanged while search is inactive", () => {
    expect(filterProviderMcpServers(SERVERS, "   ")).toBe(SERVERS);
    expect(filterProviderMcpTools(TOOLS, "")).toBe(TOOLS);
    expect(filterProviderSkills(SKILLS, "")).toBe(SKILLS);
    expect(filterProviderPlugins(PLUGINS, " ")).toBe(PLUGINS);
  });

  it("identifies whether a trimmed query is active", () => {
    expect(isProviderListSearchActive("  ")).toBe(false);
    expect(isProviderListSearchActive("skill")).toBe(true);
  });

  it("fuzzily matches MCP server names", () => {
    expect(
      filterProviderMcpServers(SERVERS, "contxt7").map((row) => row.name),
    ).toEqual(["context7"]);
  });

  it("fuzzily matches deferred MCP tool inventory", () => {
    expect(filterProviderMcpTools(TOOLS, "seach code")).toEqual([TOOLS[0]]);
    expect(filterProviderMcpTools(TOOLS, "reachable")).toEqual([TOOLS[1]]);
  });

  it("matches skill descriptions and their stable path identity", () => {
    expect(
      filterProviderSkills(SKILLS, "discover").map((row) => row.name),
    ).toEqual(["find-skills"]);
    expect(
      filterProviderSkills(SKILLS, ".agents").map((row) => row.name),
    ).toEqual(["find-skills"]);
  });

  it("matches plugin manifest copy and the stable install id", () => {
    expect(
      filterProviderPlugins(PLUGINS, "documents").map((row) => row.name),
    ).toEqual(["pdf"]);
    expect(
      filterProviderPlugins(PLUGINS, "slides@").map((row) => row.name),
    ).toEqual(["slides"]);
  });

  it("returns the same tool object so non-search fields stay intact", () => {
    // Filtering is a FILTER, not a projection: stripping fields that the
    // matcher never reads (enabled, denySources, …) used to leave the tools
    // grid without a toggle. Identity of the match is the contract that keeps
    // those fields reachable after a search.
    const hit = filterProviderMcpTools(TOOLS, "search_code");
    expect(hit).toHaveLength(1);
    expect(hit[0]).toBe(TOOLS[0]);
    expect(hit[0].enabled).toBe(true);
    expect(hit[0].denySources).toEqual([]);
  });

  it("returns no rows when the query matches nothing", () => {
    expect(filterProviderMcpServers(SERVERS, "zzzz-nope")).toEqual([]);
    expect(filterProviderSkills(SKILLS, "zzzz-nope")).toEqual([]);
    expect(filterProviderPlugins(PLUGINS, "zzzz-nope")).toEqual([]);
  });
});
