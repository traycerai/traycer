import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MigrationBlockingModalHost } from "@/components/layout/dialogs/migration-blocking-modal-host";
import { useMigrationRunStore } from "@/stores/migration/migration-run-store";

describe("<MigrationBlockingModalHost />", () => {
  beforeEach(() => {
    useMigrationRunStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    useMigrationRunStore.getState().reset();
  });

  it("renders the settings retry migration layer as a portaled full-screen blocker", () => {
    useMigrationRunStore.getState().markRunning();

    const { container } = render(
      <main className="relative">
        <MigrationBlockingModalHost />
      </main>,
    );

    const overlay = screen.getByTestId("migration-blocking-overlay");
    const modal = screen.getByRole("dialog", { name: "Migrating tasks" });

    expect(container.contains(overlay)).toBe(false);
    expect(container.contains(modal)).toBe(false);
    expect(overlay.className).toContain("fixed");
    expect(overlay.className).not.toContain("absolute");
    expect(modal.className).toContain("fixed");
  });
});
