import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EpicConnectionPill } from "@/components/epic-canvas/panels/epic-connection-pill";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  useEpicConnectionStatus: vi.fn(),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicConnectionStatus: mocks.useEpicConnectionStatus,
}));

function renderPill(status: "open" | "connecting" | "reconnecting" | "closed") {
  mocks.useEpicConnectionStatus.mockReturnValue(status);
  return render(
    <TooltipProvider>
      <EpicConnectionPill />
    </TooltipProvider>,
  );
}

async function expectTooltip(text: string) {
  fireEvent.focus(screen.getByTestId("epic-connection-pill"));
  expect((await screen.findByRole("tooltip")).textContent).toBe(text);
}

describe("<EpicConnectionPill />", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the connected state with muted italic synced copy and green dot", () => {
    renderPill("open");

    expect(screen.getByTestId("epic-connection-pill").textContent).toBe(
      "All changes synced",
    );
    expect(screen.getByTestId("epic-connection-pill").className).toContain(
      "text-muted-foreground",
    );
    expect(screen.getByTestId("epic-connection-pill").className).toContain(
      "italic",
    );
    expect(screen.getByTestId("epic-connection-pill").innerHTML).toContain(
      "bg-emerald-500",
    );
    expect(screen.getByTestId("epic-connection-pill").className).not.toContain(
      "ring-border",
    );
    expect(screen.getByTestId("epic-connection-pill").className).not.toContain(
      "shadow-sm",
    );
    expect(screen.queryByText("Offline")).toBeNull();
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    expect(screen.getByTestId("epic-connection-pill").innerHTML).toContain(
      "animate-ping",
    );
    fireEvent.focus(screen.getByTestId("epic-connection-pill"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("renders connecting as the amber bootstrap pill with no tooltip", () => {
    renderPill("connecting");

    expect(screen.getByText("Connecting…")).not.toBeNull();
    expect(screen.queryByText("Reconnecting…")).toBeNull();
    expect(screen.getByTestId("epic-connection-pill").className).toContain(
      "bg-amber-500/10",
    );
    expect(screen.getByTestId("epic-connection-pill-dot").className).toContain(
      "text-amber-500",
    );
    fireEvent.focus(screen.getByTestId("epic-connection-pill"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("renders reconnecting as the amber pill with no tooltip", () => {
    renderPill("reconnecting");

    expect(screen.getByText("Reconnecting…")).not.toBeNull();
    expect(screen.getByTestId("epic-connection-pill").className).toContain(
      "bg-amber-500/10",
    );
    expect(screen.getByTestId("epic-connection-pill-dot").className).toContain(
      "text-amber-500",
    );
    fireEvent.focus(screen.getByTestId("epic-connection-pill"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("renders the closed state as a red offline pill with disconnect tooltip text", async () => {
    renderPill("closed");

    expect(screen.getByText("Offline")).not.toBeNull();
    expect(screen.getByTestId("epic-connection-pill").className).toContain(
      "bg-red-500/10",
    );
    expect(screen.getByTestId("epic-connection-pill-dot").className).toContain(
      "bg-red-500",
    );
    await expectTooltip("Disconnected. Changes will sync when reconnected.");
  });
});
