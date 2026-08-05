import "../../../../../__tests__/test-browser-apis";
import type { ProviderPlugin } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderPluginsTab } from "@/components/settings/panels/provider-plugins-tab";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const pluginMocks = vi.hoisted(() => ({
  plugins: [] as ProviderPlugin[],
  /** Every `useProvidersPluginIcon` call, in render order. */
  iconCalls: [] as Array<{
    pluginId: string;
    enabled: boolean;
    hasDarkIcon: boolean;
  }>,
  /** pluginId -> data URI the mocked query resolves with. */
  iconByPluginId: new Map<string, string | null>(),
}));

vi.mock("@/hooks/providers/use-providers-plugins-list-query", () => ({
  useProvidersPluginsList: () => ({
    data: { plugins: pluginMocks.plugins },
    isLoading: false,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/providers/use-providers-plugins-mutate-mutation", () => ({
  useProvidersPluginsMutate: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/providers/use-providers-plugin-icon-query", () => ({
  useProvidersPluginIcon: (args: {
    pluginId: string;
    enabled: boolean;
    hasDarkIcon: boolean;
  }) => {
    pluginMocks.iconCalls.push({
      pluginId: args.pluginId,
      enabled: args.enabled,
      hasDarkIcon: args.hasDarkIcon,
    });
    // Mirrors the real hook: a disabled query has no data at all.
    if (!args.enabled) return { data: undefined };
    const dataUri = pluginMocks.iconByPluginId.get(args.pluginId) ?? null;
    return { data: { icon: { dataUri, error: null } } };
  },
}));

function pluginsState(): ProviderCliState {
  return {
    providerId: "codex",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: {
      supportedTabs: ["plugins"],
      mcp: null,
      plugins: {
        addModes: ["read-only"],
        marketplaceBrowse: false,
        traycerSessionToolsNotice: false,
        actionScopes: {
          list: ["global"],
          add: [],
          remove: [],
          setEnabled: [],
        },
      },
      skills: null,
    },
    selected: { kind: "bundled" },
    candidates: [],
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [],
  };
}

function plugin(over: Partial<ProviderPlugin>): ProviderPlugin {
  return {
    id: "pdf@openai-primary-runtime",
    name: "pdf",
    version: "26.802.11031",
    enabled: true,
    source: "openai-primary-runtime",
    readOnly: true,
    description: null,
    displayName: null,
    hasIcon: false,
    hasDarkIcon: false,
    ...over,
  };
}

/**
 * Returns the rendered container so icons can be queried as ELEMENTS.
 *
 * Not `getByRole("img")`: the tile is decorative (`alt=""` + `aria-hidden`),
 * which gives it the `presentation` role, so a role query silently matches
 * nothing - and the "falls back to the monogram" assertion below would then
 * pass whether or not the image rendered.
 */
function renderTab(): HTMLElement {
  return render(<ProviderPluginsTab state={pluginsState()} />).container;
}

describe("<ProviderPluginsTab /> icons and manifest labels", () => {
  beforeEach(() => {
    pluginMocks.plugins = [];
    pluginMocks.iconCalls = [];
    pluginMocks.iconByPluginId = new Map();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the provider's artwork when the row reports one", () => {
    pluginMocks.plugins = [plugin({ hasIcon: true, displayName: "PDF" })];
    pluginMocks.iconByPluginId.set("pdf@openai-primary-runtime", PNG);
    const container = renderTab();

    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe(PNG);
  });

  it("does not request an icon for a row that ships none", () => {
    // `hasIcon` exists precisely so these rows cost no round trip. Asserted on
    // the ENABLED flag rather than call count: the hook is called either way
    // (hooks are unconditional), and it is the gate that must be false.
    pluginMocks.plugins = [plugin({ hasIcon: false })];
    const container = renderTab();

    expect(pluginMocks.iconCalls).toEqual([
      {
        pluginId: "pdf@openai-primary-runtime",
        enabled: false,
        hasDarkIcon: false,
      },
    ]);
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders NO tile when the host returns no artwork", () => {
    // The host answers `{ dataUri: null }` rather than failing when a file is
    // unreadable, so this is a success path - and its answer is "nothing".
    // There is deliberately no fallback glyph: a derived monogram asserts a
    // visual identity the plugin never declared, and beside real vendor logos
    // it reads as a rendering fault.
    pluginMocks.plugins = [plugin({ hasIcon: true, displayName: "PDF" })];
    pluginMocks.iconByPluginId.set("pdf@openai-primary-runtime", null);
    const container = renderTab();

    expect(container.querySelector("img")).toBeNull();
    // No initials anywhere - "P" was what the old monogram drew for "PDF".
    expect(screen.queryByText("P")).toBeNull();
    expect(screen.getByText("PDF")).toBeDefined();
  });

  it("reserves the icon column so a MIXED list keeps one left edge", () => {
    // Alignment is a list-level property: as soon as one row has artwork, the
    // rest hold the same footprint empty rather than ragged-edging the names.
    pluginMocks.plugins = [
      plugin({ id: "withicon@m", hasIcon: true }),
      plugin({ id: "noicon@m", hasIcon: false }),
    ];
    pluginMocks.iconByPluginId.set("withicon@m", PNG);
    const container = renderTab();

    const rows = container.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector("img")).not.toBeNull();
    // The second row has no image but still opens with a size-8 spacer.
    expect(rows[1].querySelector("img")).toBeNull();
    expect(rows[1].firstElementChild?.className).toContain("size-8");
  });

  it("omits the icon column entirely when NO row has artwork", () => {
    // The common case: most providers ship no plugin artwork at all, so their
    // lists should not carry a permanently empty column.
    pluginMocks.plugins = [
      plugin({ id: "a@m", hasIcon: false }),
      plugin({ id: "b@m", hasIcon: false }),
    ];
    const container = renderTab();

    const rows = container.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.querySelector("img")).toBeNull();
      expect(row.firstElementChild?.className ?? "").not.toContain("size-8");
    }
  });

  it("prefers the manifest displayName over the install id", () => {
    pluginMocks.plugins = [
      plugin({
        displayName: "Default templates",
        name: "openai-templates",
        description: "Default templates for documents",
      }),
    ];
    renderTab();

    expect(screen.getByText("Default templates")).toBeDefined();
    expect(screen.getByText("Default templates for documents")).toBeDefined();
  });

  it("falls back to the install id when an older host sends no displayName", () => {
    // `displayName` / `hasIcon` are additive optional wire fields; a host from
    // before this change omits them entirely.
    pluginMocks.plugins = [
      plugin({ name: "pdf", displayName: null, hasIcon: false }),
    ];
    renderTab();

    expect(screen.getByText("pdf")).toBeDefined();
  });

  it("passes hasDarkIcon through so only theme-aware rows vary by theme", () => {
    // The hook keys its request on theme ONLY when a dark asset exists.
    // Without this flag reaching it, a theme flip would miss the cache on
    // every row and re-fetch the whole ~900 KB set to get identical bytes.
    pluginMocks.plugins = [
      plugin({ id: "a@m", hasIcon: true, hasDarkIcon: true }),
      plugin({ id: "b@m", hasIcon: true, hasDarkIcon: false }),
    ];
    renderTab();

    expect(
      pluginMocks.iconCalls.map((c) => [c.pluginId, c.hasDarkIcon]),
    ).toEqual([
      ["a@m", true],
      ["b@m", false],
    ]);
  });
});
