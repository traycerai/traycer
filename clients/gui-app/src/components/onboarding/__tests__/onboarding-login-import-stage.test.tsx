import "../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingLoginImportStage } from "@/components/onboarding/onboarding-login-import-stage";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import { useFeatureAnnouncementsStore } from "@/stores/settings/feature-announcements-store";
import type { LoginImportSource } from "@traycer-clients/shared/platform/browser-view";

const browserViewState = vi.hoisted((): { current: object | null } => ({
  current: null,
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () =>
    browserViewState.current === null
      ? null
      : { browserView: browserViewState.current },
}));

class OneSourceBridge extends FakeBrowserViewBridge {
  override listLoginImportSources(): Promise<readonly LoginImportSource[]> {
    return Promise.resolve([
      {
        id: "source-1",
        browser: "chrome",
        profileLabel: "Default",
        lastUsedAt: null,
      },
    ]);
  }
}

function renderStage(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <OnboardingLoginImportStage />
    </QueryClientProvider>,
  );
}

function resetStore(): void {
  useFeatureAnnouncementsStore.setState({ consumed: {} });
  window.localStorage.clear();
}

describe("<OnboardingLoginImportStage />", () => {
  afterEach(() => {
    cleanup();
    resetStore();
  });

  it("renders the flow's Pick step against the runner host's browser bridge", async () => {
    resetStore();
    browserViewState.current = new OneSourceBridge();
    renderStage();

    expect(
      screen.getByRole("heading", {
        name: "Import logins from another browser",
      }),
    ).not.toBeNull();
    await waitFor(() => {
      expect(screen.getByText("Google Chrome")).not.toBeNull();
    });
  });

  it("consumes the login-import announcement on mount", () => {
    resetStore();
    browserViewState.current = new OneSourceBridge();
    renderStage();

    expect(
      useFeatureAnnouncementsStore.getState().consumed["login-import"],
    ).toBeDefined();
  });

  it("renders nothing when the runner host has no browser bridge", () => {
    resetStore();
    browserViewState.current = null;
    const { container } = (() => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      return render(
        <QueryClientProvider client={client}>
          <OnboardingLoginImportStage />
        </QueryClientProvider>,
      );
    })();

    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("onboarding-login-import-stage")).toBeNull();
  });
});
