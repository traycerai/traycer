import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";

import {
  ComposerSendButton,
  type ComposerStopPlacement,
} from "../composer-send-button";

afterEach(() => cleanup());

interface RenderOptions {
  readonly stopPlacement: ComposerStopPlacement;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly canSubmit: boolean;
  readonly onSubmit: () => void;
  readonly onStopTurn: (() => void) | null;
}

function renderButton(options: RenderOptions) {
  return render(
    <ComposerSendButton
      canSubmit={options.canSubmit}
      attachmentPending={false}
      onSubmit={options.onSubmit}
      activeTurnStatus={options.activeTurnStatus}
      stopDisabled={false}
      onStopTurn={options.onStopTurn}
      disabledHint={null}
      stopPlacement={options.stopPlacement}
    />,
  );
}

describe("ComposerSendButton attachment preparation", () => {
  it("shows visible pending feedback while attachment work gates submit", () => {
    render(
      <ComposerSendButton
        canSubmit={false}
        attachmentPending
        onSubmit={() => undefined}
        activeTurnStatus={null}
        stopDisabled
        onStopTurn={null}
        disabledHint={null}
        stopPlacement="replace"
      />,
    );

    expect(
      screen.getByRole("button", { name: "Send" }).getAttribute("disabled"),
    ).not.toBeNull();
    expect(screen.getByTestId("composer-attachment-pending")).toBeTruthy();
  });
});

describe("ComposerSendButton stop placement", () => {
  it("idle renders Send alone under either placement", () => {
    renderButton({
      stopPlacement: "beside",
      activeTurnStatus: null,
      canSubmit: true,
      onSubmit: vi.fn(),
      onStopTurn: null,
    });
    expect(screen.getByRole("button", { name: "Send" })).not.toBeNull();
    expect(screen.queryByTestId("chat-stop-button")).toBeNull();
  });

  it("'replace' morphs Send into Stop while a turn runs", () => {
    renderButton({
      stopPlacement: "replace",
      activeTurnStatus: "running",
      canSubmit: true,
      onSubmit: vi.fn(),
      onStopTurn: vi.fn(),
    });
    expect(screen.getByRole("button", { name: "Stop" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
  });

  it("'beside' keeps a Queue button next to Stop while a turn runs", () => {
    const onSubmit = vi.fn();
    const onStopTurn = vi.fn();
    renderButton({
      stopPlacement: "beside",
      activeTurnStatus: "running",
      canSubmit: true,
      onSubmit,
      onStopTurn,
    });

    const stop = screen.getByRole("button", { name: "Stop" });
    const queue = screen.getByRole("button", { name: "Queue" });
    expect(stop.getAttribute("data-testid")).toBe("chat-stop-button");
    // Stop sits to the left of the queueing Send so an urgent tap never
    // lands on the primary button.
    expect(
      stop.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    fireEvent.click(queue);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onStopTurn).not.toHaveBeenCalled();

    fireEvent.click(stop);
    expect(onStopTurn).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("'beside' disables Queue when there is nothing to send", () => {
    renderButton({
      stopPlacement: "beside",
      activeTurnStatus: "running",
      canSubmit: false,
      onSubmit: vi.fn(),
      onStopTurn: vi.fn(),
    });
    expect(
      screen.getByRole("button", { name: "Queue" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Stop" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("'beside' disables both buttons while the turn is stopping", () => {
    renderButton({
      stopPlacement: "beside",
      activeTurnStatus: "stopping",
      canSubmit: true,
      onSubmit: vi.fn(),
      onStopTurn: null,
    });
    expect(
      screen.getByRole("button", { name: "Stopping" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Queue" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
