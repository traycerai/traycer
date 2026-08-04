import "../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProvidersPluginIcon } from "@/hooks/providers/use-providers-plugin-icon-query";
import {
  ResolvedThemeContext,
  type ResolvedTheme,
} from "@/providers/use-resolved-theme";
import { DEFAULT_THEME_PRESET } from "@/lib/theme-presets";

/**
 * Captures the params the hook hands the transport. The theme decision is the
 * whole point of this hook and it is invisible from the plugins tab, which
 * mocks the hook wholesale.
 */
const queryMocks = vi.hoisted(() => ({
  params: [] as Array<{ native: { theme: string; pluginId: string } }>,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQueryWithResponseMap: (args: {
    params: { native: { theme: string; pluginId: string } };
  }) => {
    queryMocks.params.push(args.params);
    return { data: undefined, isPending: true, isError: false, error: null };
  },
}));

vi.mock("@/lib/host", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/host")>("@/lib/host");
  return { ...actual, useHostClient: () => null };
});

function themed(theme: ResolvedTheme) {
  return function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return (
      <ResolvedThemeContext
        value={{ resolvedTheme: theme, themePreset: DEFAULT_THEME_PRESET }}
      >
        {children}
      </ResolvedThemeContext>
    );
  };
}

function run(args: {
  readonly hasDarkIcon: boolean;
  readonly wrapper: ((p: { children: ReactNode }) => ReactNode) | undefined;
}): string {
  queryMocks.params = [];
  renderHook(
    () =>
      useProvidersPluginIcon({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        pluginId: "github@m",
        hasDarkIcon: args.hasDarkIcon,
        enabled: true,
      }),
    args.wrapper === undefined ? undefined : { wrapper: args.wrapper },
  );
  // `.at(0)` rather than `[0]`: indexing types as non-optional here, so the
  // guard would read as dead code to the linter. The guard is what turns "the
  // hook issued no query at all" into a named failure instead of a TypeError.
  const first = queryMocks.params.at(0);
  if (first === undefined) throw new Error("hook issued no query");
  return first.native.theme;
}

describe("useProvidersPluginIcon theme selection", () => {
  beforeEach(() => {
    queryMocks.params = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("asks for the dark asset only when the plugin ships one", () => {
    expect(run({ hasDarkIcon: true, wrapper: themed("dark") })).toBe("dark");
  });

  it("pins a plugin with no dark asset to `light` even in dark mode", () => {
    // This is the cache-key rule, not a rendering preference: the request is
    // the query key, so varying it by theme for the ~10 of 13 plugins that
    // ship one asset would miss on every row at theme-flip and re-fetch the
    // whole ~900 KB set to receive byte-identical images.
    expect(run({ hasDarkIcon: false, wrapper: themed("dark") })).toBe("light");
  });

  it("asks for light in light mode even when a dark asset exists", () => {
    expect(run({ hasDarkIcon: true, wrapper: themed("light") })).toBe("light");
  });

  it("defaults to light with NO ThemeProvider instead of throwing", () => {
    // `useResolvedTheme()` throws without a provider. Artwork is decoration
    // and must never be the reason a settings pane fails to render, so this
    // hook reads the context directly and falls back.
    expect(run({ hasDarkIcon: true, wrapper: undefined })).toBe("light");
  });
});
