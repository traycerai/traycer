/**
 * `/settings/layout` under the Customize editor: the page's rows moved to
 * Appearance, so the route sends the reader there - and only there. With the
 * switch off, or a window narrower than the editor supports, it is the ordinary
 * page, whatever the stored switch says.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostScopeFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { APPEARANCE } from "@/components/settings/panels/appearance-settings.definitions";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { createFakeRunnerHost } from "../../../__tests__/create-fake-runner-host";
import { Route as LayoutRoute } from "@/routes/settings.layout";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

// The redirect target is a probe: the real one needs a router, and this suite
// is about WHETHER and WHERE the route redirects.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Navigate: (props: { readonly to: string; readonly replace: boolean }) => (
    <div
      data-testid="redirect"
      data-to={props.to}
      data-replace={String(props.replace)}
    />
  ),
  useNavigate: () => vi.fn(),
}));

// The legacy page's provider list reads the watched host's scope; see the
// search-fixture suite for why it is mocked at this boundary.
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));
vi.mock("@/hooks/rate-limits/use-rate-limit-host-scope", () => ({
  useRateLimitResolveHostScope: () => ({
    scope: hostScopeFixture({}),
    hasExplicitPick: false,
  }),
}));

function setWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

function mountRoute(): void {
  const Component = LayoutRoute.options.component;
  if (Component === undefined) throw new Error("route has no component");
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RunnerHostProvider runnerHost={createFakeRunnerHost({})}>
        <Component />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

describe("/settings/layout", () => {
  beforeEach(() => {
    setWidth(1280);
    useSettingsSearchStore.setState({ pendingReveal: null });
  });

  afterEach(() => {
    cleanup();
    setWidth(1024);
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });
    useSettingsSearchStore.setState({ pendingReveal: null });
  });

  it("redirects to Appearance, replacing the entry, when the editor is on", () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });

    mountRoute();

    const redirect = screen.getByTestId("redirect");
    expect(redirect.dataset.to).toBe("/settings/appearance");
    expect(redirect.dataset.replace).toBe("true");
    expect(
      screen.queryByText(
        "Where the app's chrome sits and how much of it shows.",
      ),
    ).toBeNull();
  });

  it("aims the reveal at the Customize card", () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });

    mountRoute();

    expect(useSettingsSearchStore.getState().pendingReveal).toMatchObject({
      section: "appearance",
      anchor: APPEARANCE.definitions.customizeCard.anchor,
    });
  });

  it("draws the full Layout page with the editor off", () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: false });

    mountRoute();

    expect(screen.queryByTestId("redirect")).toBeNull();
    expect(screen.getByRole("heading", { name: "Layout" })).toBeTruthy();
    expect(screen.getByTestId("layout-presets-group")).toBeTruthy();
    expect(useSettingsSearchStore.getState().pendingReveal).toBeNull();
  });

  it("keeps the full page at a narrow window even with the switch on", () => {
    useSettingsStore.setState({ visualLayoutEditorEnabled: true });
    setWidth(500);

    mountRoute();

    expect(screen.queryByTestId("redirect")).toBeNull();
    expect(screen.getByTestId("layout-presets-group")).toBeTruthy();
    expect(useSettingsSearchStore.getState().pendingReveal).toBeNull();
  });
});
