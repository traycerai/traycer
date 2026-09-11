import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { SystemNotificationSettingsSection } from "@/components/settings/panels/system-notification-settings-section";

afterEach(() => {
  cleanup();
});

describe("<SystemNotificationSettingsSection />", () => {
  // A host-less shell has no runner host at all, and the group's mutation
  // reaches for one — so the gate has to return before it runs.
  it("renders nothing, and does not throw, with no runner host above it", () => {
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <SystemNotificationSettingsSection />
      </QueryClientProvider>,
    );

    expect(view.container.innerHTML).toBe("");
  });
});
