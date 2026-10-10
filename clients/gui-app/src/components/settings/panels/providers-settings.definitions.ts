import { alwaysAvailable } from "@/lib/settings/settings-availability";
import { defineSettingsSection } from "@/lib/settings-search/settings-definitions";

// A bespoke page: its per-provider tab bar exists only once a host answers,
// so its concepts are region groups with a `null` anchor — each lands at the
// top of the page — and name the page as their breadcrumb.
export const PROVIDERS = defineSettingsSection("providers", {
  page: {
    availableWhen: alwaysAvailable,
    label: "Providers",
    description: "Coding agents, their accounts, models, and extensions.",
    keywords: [
      "claude",
      // Its display name. The Judge tab's removed built-in reviewer card was
      // the only entry that carried it, and "claude" alone does not answer it.
      "claude code",
      "codex",
      "cursor",
      "grok",
      "amp",
      "harness",
      "cli",
      "sign in",
      "auth",
      "login",
      "agent",
      // The per-provider "Who reviews <provider>'s commands" select on a
      // provider's Permissions tab has no region group of its own, and it is
      // the switch that wins over the Permissions-page judge; these land that
      // search on this page. It is the switch's only home, so the words of the
      // Judge tab's former "Providers with a built-in reviewer" card are here
      // too. Like every concept on this page they land at its top, not on a
      // provider's tab; the Judge tab's pointer line is the direct route.
      "auto mode judge",
      "classifier",
      "who reviews commands",
      "built-in reviewer",
      "own classifier",
    ],
  },
  apiKey: {
    kind: "group",
    search: { anchor: null },
    label: "API key",
    description: "The key a provider authenticates with.",
    breadcrumb: "Providers",
    availableWhen: alwaysAvailable,
    keywords: ["api key", "token", "secret", "credential", "auth"],
  },
  profilesAndLimits: {
    kind: "group",
    search: { anchor: null },
    label: "Profiles & limits",
    description: "Managed profiles and remaining rate limits per provider.",
    breadcrumb: "Providers",
    availableWhen: alwaysAvailable,
    keywords: [
      "profile",
      "subscription",
      "rate limit",
      "quota",
      "usage limits",
      "account",
    ],
  },
  mcpServers: {
    kind: "group",
    search: { anchor: null },
    label: "MCP servers",
    description: "Model Context Protocol servers, per provider.",
    breadcrumb: "Providers",
    availableWhen: alwaysAvailable,
    keywords: ["mcp", "model context protocol", "server", "tools", "connector"],
  },
  modelProviders: {
    kind: "group",
    search: { anchor: null },
    label: "Model providers",
    description: "Which upstream models a provider can reach.",
    breadcrumb: "Providers",
    availableWhen: alwaysAvailable,
    keywords: ["model", "openrouter", "custom model", "endpoint", "base url"],
  },
  skills: {
    kind: "group",
    search: { anchor: null },
    label: "Skills",
    description: "Skills installed into a provider.",
    breadcrumb: "Providers",
    availableWhen: alwaysAvailable,
    keywords: ["skill", "skills", "playbook", "install"],
  },
  plugins: {
    kind: "group",
    search: { anchor: null },
    label: "Plugins",
    description: "Plugins installed into a provider.",
    breadcrumb: "Providers",
    availableWhen: alwaysAvailable,
    keywords: ["plugin", "plugins", "extension", "marketplace"],
  },
  // The Model list group in each provider's CLI & Args tab. Host-gated (both
  // `config.catalog.*` methods at 1.1), so it lands at the top of the page like
  // the other region groups, and its two rows fold into it.
  modelList: {
    kind: "group",
    search: { anchor: null },
    label: "Model list",
    description: "How long to wait for a provider's model list.",
    breadcrumb: "Providers",
    availableWhen: alwaysAvailable,
    keywords: [
      "model list timeout",
      "timeout",
      "model picker",
      "slow",
      "wait",
      "catalog",
    ],
  },
  modelListTimeout: {
    kind: "row",
    group: "modelList",
    search: { contributesTo: "modelList" },
    label: "Timeout",
    description: "How long to wait for the model list.",
    availableWhen: alwaysAvailable,
    keywords: ["seconds", "probe timeout"],
  },
  modelListSameForAll: {
    kind: "row",
    group: "modelList",
    search: { contributesTo: "modelList" },
    label: "Same for all providers",
    description: null,
    availableWhen: alwaysAvailable,
    keywords: ["shared", "every provider", "all providers"],
  },
  environmentVariables: {
    kind: "group",
    search: { anchor: null },
    label: "Environment variables",
    description: "Per-provider environment overrides.",
    breadcrumb: "Providers",
    availableWhen: alwaysAvailable,
    keywords: ["env", "environment", "variable", "override", "secret", "proxy"],
  },
});
