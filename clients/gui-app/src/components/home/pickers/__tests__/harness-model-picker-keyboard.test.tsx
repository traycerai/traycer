import { useRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  guiAgentModelOptionSchema,
  guiHarnessOptionSchema,
} from "@traycer/protocol/host/index";
import { buildHarnessModelRows } from "@/components/home/data/harness-model-search";
import type { VirtuosoHandle } from "react-virtuoso";
import { handleHarnessModelPickerKeyDown } from "../harness-model-picker-keyboard";

const model = guiAgentModelOptionSchema.parse({
  harnessId: "codex",
  slug: "gpt-test",
  label: "GPT Test",
  description: null,
  contextWindow: null,
  maxOutputTokens: null,
  defaultReasoningEffort: null,
  supportedReasoningEfforts: [],
  metadata: {},
});
const harness = guiHarnessOptionSchema.parse({
  id: "codex",
  label: "Codex",
  available: true,
  error: null,
  modes: ["gui"],
  requiresApiKey: false,
  supportedPermissionModes: [],
});
const row = buildHarnessModelRows(harness, [model])[0];
const activeRow = row;

describe("handleHarnessModelPickerKeyDown", () => {
  it("selects on Enter from search and a model row, but leaves other controls alone", () => {
    const onSelectRow = vi.fn();
    function Picker() {
      const listRef = useRef<VirtuosoHandle | null>(null);
      return (
        <div
          role="toolbar"
          aria-label="Model picker"
          tabIndex={0}
          onKeyDown={(event) =>
            handleHarnessModelPickerKeyDown(event, {
              visibleRows: [activeRow],
              effectiveActiveRowId: activeRow.id,
              activeRow,
              trimmedQuery: "",
              listRef,
              onActiveRowId: () => undefined,
              onSelectRow,
              onQueryChange: () => undefined,
              onClose: () => undefined,
            })
          }
        >
          <input aria-label="Search models" />
          <button aria-label="Model row" aria-selected="true" role="option" />
          <button aria-label="Manage" />
          <div role="menuitem" tabIndex={0}>
            Manage menu item
          </div>
        </div>
      );
    }
    const view = render(<Picker />);

    fireEvent.keyDown(view.getByLabelText("Search models"), { key: "Enter" });
    expect(onSelectRow).toHaveBeenLastCalledWith(row);

    fireEvent.keyDown(view.getByLabelText("Model row"), { key: "Enter" });
    expect(onSelectRow).toHaveBeenLastCalledWith(row);
    expect(onSelectRow).toHaveBeenCalledTimes(2);

    const buttonEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    view.getByLabelText("Manage").dispatchEvent(buttonEvent);
    expect(buttonEvent.defaultPrevented).toBe(false);
    expect(onSelectRow).toHaveBeenCalledTimes(2);

    const menuEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    view.getByRole("menuitem").dispatchEvent(menuEvent);
    expect(menuEvent.defaultPrevented).toBe(false);
    expect(onSelectRow).toHaveBeenCalledTimes(2);
  });
});
