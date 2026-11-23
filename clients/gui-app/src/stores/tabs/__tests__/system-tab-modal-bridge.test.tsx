import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  setSystemTabModalApi,
  useSystemTabModalApiPublished,
} from "@/stores/tabs/system-tab-modal-bridge";
import type {
  OpenSettingsModalOpts,
  SystemOverlayKind,
  SystemTabModalApi,
} from "@/stores/tabs/use-system-tab-modal";
import type { SettingsSectionId } from "@/lib/settings-sections";

function buildFakeApi(): SystemTabModalApi {
  return {
    active: null,
    openSettings: vi.fn<(opts: OpenSettingsModalOpts) => void>(),
    openHistory: vi.fn<() => void>(),
    close: vi.fn<() => void>(),
    setSection: vi.fn<(section: SettingsSectionId) => void>(),
    promoteToTab: vi.fn<() => void>(),
    isOverlayActive: vi.fn<(kind: SystemOverlayKind) => boolean>(() => false),
  };
}

function PublishedProbe() {
  const published = useSystemTabModalApiPublished();
  return <div data-testid="published">{String(published)}</div>;
}

describe("useSystemTabModalApiPublished", () => {
  afterEach(() => {
    cleanup();
    setSystemTabModalApi(null);
  });

  it("reports false with nothing published, true once published, and false again once cleared", () => {
    render(<PublishedProbe />);
    expect(screen.getByTestId("published").textContent).toBe("false");

    act(() => {
      setSystemTabModalApi(buildFakeApi());
    });
    expect(screen.getByTestId("published").textContent).toBe("true");

    act(() => {
      setSystemTabModalApi(null);
    });
    expect(screen.getByTestId("published").textContent).toBe("false");
  });
});
