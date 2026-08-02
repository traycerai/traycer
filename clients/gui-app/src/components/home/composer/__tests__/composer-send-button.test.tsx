import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ComposerSendButton } from "../composer-send-button";

afterEach(() => cleanup());

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
      />,
    );

    expect(
      screen.getByRole("button", { name: "Send" }).getAttribute("disabled"),
    ).not.toBeNull();
    expect(screen.getByTestId("composer-attachment-pending")).toBeTruthy();
  });
});
