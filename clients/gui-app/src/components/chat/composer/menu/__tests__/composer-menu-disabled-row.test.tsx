import "../../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { SlashCommand } from "@/lib/composer/types";

import {
  createComposerPickerStore,
  type ComposerPickerItem,
  type ComposerPickerStore,
} from "../../picker/composer-picker-store";
import { ComposerMenu } from "../composer-menu";

afterEach(() => {
  cleanup();
});

const LEADING_ONLY = "This command is only allowed at the start of the message";

function slashCommand(name: string): SlashCommand {
  return {
    harnessId: "claude",
    name,
    description: "",
    argumentHint: null,
    kind: "slash-command",
    metadata: {},
    source: "provider",
    preview: { kind: "text", primary: "", secondary: null, mono: false },
  };
}

function slashItem(
  name: string,
  disabledReason: string | null,
): ComposerPickerItem {
  return {
    id: name,
    kind: "slash",
    command: slashCommand(name),
    disabledReason,
  };
}

function openWith(
  store: ComposerPickerStore,
  items: ReadonlyArray<ComposerPickerItem>,
): void {
  store.getState().openPicker({
    sessionId: 1,
    kind: "slash",
    slashScope: "skills",
    range: { from: 1, to: 2 },
    query: "",
    commit: () => undefined,
    clientRect: null,
  });
  store.getState().setItems({
    kind: "slash",
    query: "",
    slashScope: "skills",
    step: store.getState().step,
    items,
    loading: false,
  });
}

// The reason a row is unavailable lives in the side preview panel, which is
// `aria-hidden` and disappears when it cannot fit. `aria-disabled` alone says
// a row is unavailable but never why, so the row itself has to carry the
// explanation or assistive tech never receives it.
describe("<ComposerMenu /> disabled rows", () => {
  it("puts the disabled reason in the row's accessible name", () => {
    const store = createComposerPickerStore();
    act(() => {
      render(<ComposerMenu pickerStore={store} />);
    });
    act(() => {
      openWith(store, [slashItem("plan", LEADING_ONLY)]);
    });

    const option = screen.getByRole("option");
    expect(option.getAttribute("aria-disabled")).toBe("true");
    expect(option.textContent).toContain(`Disabled. ${LEADING_ONLY}`);
  });

  it("leaves an enabled row's accessible name free of policy text", () => {
    const store = createComposerPickerStore();
    act(() => {
      render(<ComposerMenu pickerStore={store} />);
    });
    act(() => {
      openWith(store, [slashItem("plan", null)]);
    });

    const option = screen.getByRole("option");
    expect(option.getAttribute("aria-disabled")).toBe("false");
    expect(option.textContent).not.toContain("Disabled.");
  });
});
