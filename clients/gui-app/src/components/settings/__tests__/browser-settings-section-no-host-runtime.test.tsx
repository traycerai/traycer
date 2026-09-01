import "../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSettingsSection } from "@/components/settings/browser-settings-section";

/**
 * Settings ▸ Browser rendered with NO `<HostRuntimeProvider>` above it, which
 * is how the General panel is reached before a host is bound.
 *
 * Its own file, and with the host hooks left REAL: the saved-logins list runs
 * `useHostClient()`, which throws rather than answering null when no runtime is
 * bound, and mocking it away is exactly what would hide that. Only the desktop
 * bridge is faked here, so the group has every other reason to render.
 */

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({ browserView: {} }),
}));

vi.mock("@/lib/browser-view/use-browser-save-logins", () => ({
  useBrowserSaveLogins: () => ({
    enabled: true,
    pending: false,
    setEnabled: () => undefined,
  }),
}));

describe("<BrowserSettingsSection /> without a host runtime", () => {
  afterEach(cleanup);

  it("renders the panel instead of throwing, and leaves the saved-logins group out", () => {
    render(<BrowserSettingsSection />);

    expect(screen.getByText("Web link default")).not.toBeNull();
    expect(screen.queryByText("Saved logins")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
