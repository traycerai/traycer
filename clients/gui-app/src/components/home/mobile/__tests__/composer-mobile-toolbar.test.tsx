import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import { ComposerMobileToolbar } from "@/components/home/mobile/composer-mobile-toolbar";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";

vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark", themePreset: "neutral" }),
}));
// The real picker pulls host/query providers; this test covers the row itself.
vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => <div data-testid="mock-model-picker" />,
}));

afterEach(cleanup);

function makeStore(modelSlug: string) {
  return createComposerToolbarStore({
    seedKey: "mobile-toolbar-test",
    values: {
      permission: "supervised",
      selection: { harnessId: "claude", modelSlug, profileId: null },
      reasoning: "",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: false,
    hostId: null,
  });
}

function renderToolbar(
  modelSlug: string,
  onSubmit: () => void,
  activeTurnStatus: ChatActiveTurn["status"] | null,
) {
  return render(
    <ComposerMobileToolbar
      store={makeStore(modelSlug)}
      onAttachImages={vi.fn()}
      canSubmit
      attachmentPending={false}
      onSubmit={onSubmit}
      activeTurnStatus={activeTurnStatus}
      stopDisabled={false}
      onStopTurn={activeTurnStatus === null ? null : vi.fn()}
      composerDisabledHint={null}
      dictation={null}
      dictationPreparing={null}
      settingsLocked={false}
      createProfileHostId={null}
      runTargetHostId={null}
    />,
  );
}

describe("ComposerMobileToolbar", () => {
  it("keeps the desktop arrangement: attach, permission, model, send", () => {
    renderToolbar("claude-opus-5", vi.fn(), null);
    expect(screen.getByRole("button", { name: "Attach image" })).not.toBeNull();
    expect(screen.getByTestId("mock-model-picker")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    // Only the agent-mode pill moves out of the row.
    expect(screen.queryByRole("button", { name: /Switch to Epic/ })).toBeNull();
  });

  it("renders the permission as an icon, naming it only for assistive tech", () => {
    renderToolbar("claude-opus-5", vi.fn(), null);
    expect(
      screen.getByRole("button", { name: "Permissions: Supervised" }),
    ).not.toBeNull();
    // Visible text would truncate to "Superv..." at this width and steal room
    // the model name needs; the glyph carries it instead.
    expect(screen.queryByText("Supervised")).toBeNull();
  });

  it("opens the options sheet from the permission pill", async () => {
    renderToolbar("claude-opus-5", vi.fn(), null);
    expect(screen.queryByTestId("composer-options-sheet")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Permissions: Supervised" }),
    );
    expect(screen.getByTestId("composer-options-sheet")).not.toBeNull();
  });

  it("blocks send while the model slug is still empty", () => {
    const onSubmit = vi.fn();
    renderToolbar("", onSubmit, null);
    expect(
      screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("allows send once the model slug resolves", async () => {
    const onSubmit = vi.fn();
    renderToolbar("claude-opus-5", onSubmit, null);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("keeps a Queue button beside Stop while a turn runs", async () => {
    // Return is a newline on a phone, so without this button there would be
    // no way to queue a message mid-turn.
    const onSubmit = vi.fn();
    renderToolbar("claude-opus-5", onSubmit, "running");
    expect(screen.getByRole("button", { name: "Stop" })).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Queue" }));
    expect(onSubmit).toHaveBeenCalled();
  });
});
