import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState, type KeyboardEvent } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import {
  buildHarnessModelRows,
  createModelRowSearchIndex,
  filterModelRows,
  isCustomModelPromptRow,
  type HarnessModelRow,
} from "@/components/home/data/harness-model-search";
import type {
  HarnessOption,
  ModelOption,
} from "@/components/home/data/landing-options";
import { HarnessModelPickerItem } from "@/components/home/pickers/harness-model-picker-item";
import { handleHarnessModelPickerKeyDown } from "@/components/home/pickers/harness-model-picker-keyboard";
import { ALL_PERMISSION_MODES } from "@traycer/protocol/persistence/epic/foundation";

// D09: the composer picker pins the active profile's `defaultModel` id first,
// then a `Custom…` entry, ahead of the harness catalog. Covers
// `buildHarnessModelRows`'s pinned-row generation (`harness-model-search.ts`)
// and their rendering via the existing `HarnessModelPickerItem`.

const CLAUDE_HARNESS: HarnessOption = {
  id: "claude",
  label: "Claude",
  enabled: true,
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  availabilityPending: false,
};

const OPENCODE_HARNESS: HarnessOption = {
  id: "opencode",
  label: "OpenCode",
  enabled: true,
  available: true,
  error: null,
  modes: ["gui", "tui"],
  requiresApiKey: false,
  supportedPermissionModes: [...ALL_PERMISSION_MODES],
  availabilityPending: false,
};

function model(overrides: Partial<ModelOption>): ModelOption {
  const base: ModelOption = {
    harnessId: "claude",
    slug: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    description: null,
    contextWindow: null,
    maxOutputTokens: null,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
    defaultServiceTier: null,
    supportedServiceTiers: [],
    deprecationNotice: null,
    metadata: {},
  };
  return {
    ...base,
    ...overrides,
    metadata: overrides.metadata ?? base.metadata,
  };
}

afterEach(() => {
  cleanup();
});

/**
 * The picker's real select funnel around one row: `selectRow`'s custom-row
 * branch (`isCustomModelPromptRow` - the production predicate, not a copy)
 * plus the picker-owned open state the row now reads. Both gestures reach it
 * the way production does: the row's own click, and Enter through the real
 * `handleHarnessModelPickerKeyDown`.
 */
function CustomRowHarness({
  row,
  onSelect,
}: {
  readonly row: HarnessModelRow;
  readonly onSelect: (row: HarnessModelRow) => void;
}) {
  const [customRowOpen, setCustomRowOpen] = useState(false);
  const listRef = useRef<VirtuosoHandle | null>(null);
  const selectRow = (next: HarnessModelRow): void => {
    if (isCustomModelPromptRow(next)) {
      setCustomRowOpen(true);
      return;
    }
    onSelect(next);
  };
  return (
    <div
      // Stands in for the real keydown surface, so it carries the role the
      // rows it wraps expect: `harness-model-picker-list.tsx` is the
      // `role="listbox"` around `HarnessModelPickerItem`'s `role="option"`.
      role="listbox"
      tabIndex={-1}
      data-testid="picker-surface"
      onKeyDown={(event: KeyboardEvent<HTMLElement>) =>
        handleHarnessModelPickerKeyDown(event, {
          visibleRows: [row],
          effectiveActiveRowId: row.id,
          activeRow: row,
          trimmedQuery: "",
          listRef,
          onActiveRowId: () => undefined,
          onSelectRow: selectRow,
          onQueryChange: () => undefined,
          onClose: () => undefined,
        })
      }
    >
      <HarnessModelPickerItem
        idPrefix="picker"
        row={row}
        selected={false}
        active
        showCapacity={false}
        onHover={() => undefined}
        onActive={() => undefined}
        onSelect={selectRow}
        customRowOpen={customRowOpen}
        onCloseCustomRow={() => setCustomRowOpen(false)}
      />
    </div>
  );
}

describe("D09 pinned rows: defaultModel first, then Custom…", () => {
  it("pins the defaultModel id first, ahead of every catalog row and provider-group header, even when the catalog does not contain it", () => {
    const rows = buildHarnessModelRows(
      OPENCODE_HARNESS,
      [
        model({
          harnessId: "opencode",
          slug: "anthropic:claude-sonnet",
          label: "Anthropic: Claude Sonnet",
          metadata: {
            openCodeProviderId: "anthropic",
            openCodeProviderLabel: "Anthropic",
          },
        }),
      ],
      "opencode-unlisted-model",
    );

    // The catalog has no row for "opencode-unlisted-model" - D06's live probe
    // established an unrecognized id is legitimate, not an error state.
    expect(rows.some((row) => row.value === "opencode-unlisted-model")).toBe(
      true,
    );
    expect(rows[0]).toMatchObject({
      pinned: "default-model",
      value: "opencode-unlisted-model",
      label: "opencode-unlisted-model",
      // Never grouped - `providerGroupHeader` (harness-model-picker-list.tsx)
      // emits no header for a `null` group, and this keeps it ahead of the
      // first real `providerGroupId` header.
      providerGroupId: null,
    });
    expect(rows[1]).toMatchObject({ pinned: "custom" });
    // Both pinned rows precede the first (and only) provider-group row.
    const firstGroupedIndex = rows.findIndex(
      (row) => row.providerGroupId !== null,
    );
    expect(firstGroupedIndex).toBe(2);

    render(
      <HarnessModelPickerItem
        idPrefix="picker"
        row={rows[0]}
        selected={false}
        active={false}
        showCapacity
        onHover={vi.fn()}
        onActive={vi.fn()}
        onSelect={vi.fn()}
        customRowOpen={false}
        onCloseCustomRow={vi.fn()}
      />,
    );
    const optionRow = screen.getByRole("option", {
      name: /opencode-unlisted-model/,
    });
    expect(optionRow).toBeTruthy();
    // "Profile default" is the row's secondary text (reuses the existing
    // capacity-label slot rather than a new one).
    expect(screen.getByText("Profile default")).toBeTruthy();
  });

  it("has no defaultModel row when the profile carries none - only Custom… is pinned", () => {
    const rows = buildHarnessModelRows(
      CLAUDE_HARNESS,
      [model({ slug: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" })],
      null,
    );

    expect(rows[0]).toMatchObject({ pinned: "custom", label: "Custom…" });
    expect(rows.filter((row) => row.pinned === "default-model")).toHaveLength(
      0,
    );
  });

  it("Custom… commits a typed free-form id as the selection, through the same onSelect path a catalog row uses", () => {
    const rows = buildHarnessModelRows(
      CLAUDE_HARNESS,
      [model({ slug: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" })],
      null,
    );
    const customRow = rows.find((row) => row.pinned === "custom");
    expect(customRow).toBeDefined();
    if (customRow === undefined) return;

    const onSelect = vi.fn();
    render(<CustomRowHarness row={customRow} onSelect={onSelect} />);
    // Clicking the pinned row opens the field instead of committing
    // immediately - `onSelect` fires only once a slug is actually typed.
    fireEvent.click(screen.getByRole("option", { name: /Custom…/ }));
    expect(onSelect).not.toHaveBeenCalled();
    const input = screen.getByLabelText("Custom model id");
    fireEvent.change(input, { target: { value: "my-custom-model" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Same `onSelect(row)` funnel a catalog pick uses - only `value` differs.
    expect(onSelect).toHaveBeenCalledWith({
      ...customRow,
      value: "my-custom-model",
    });
    // The field closes back to the plain row after committing.
    expect(screen.queryByLabelText("Custom model id")).toBeNull();
    expect(screen.getByRole("option", { name: /Custom…/ })).toBeTruthy();
  });

  // The regression this pins: opening the field used to live in the row's own
  // `onClick`, so Enter went straight to `onSelectRow(activeRow)` and
  // committed the pinned row's EMPTY `value` - blanking the composer's model
  // instead of prompting for one.
  it("Custom… opens the same free-form field on Enter as on click, and never commits an empty slug", () => {
    const rows = buildHarnessModelRows(
      CLAUDE_HARNESS,
      [model({ slug: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" })],
      null,
    );
    const customRow = rows.find((row) => row.pinned === "custom");
    expect(customRow).toBeDefined();
    if (customRow === undefined) return;

    const onSelect = vi.fn();
    render(<CustomRowHarness row={customRow} onSelect={onSelect} />);

    fireEvent.keyDown(screen.getByTestId("picker-surface"), { key: "Enter" });

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Custom model id")).toBeTruthy();

    const input = screen.getByLabelText("Custom model id");
    fireEvent.change(input, { target: { value: "typed-by-keyboard" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({
      ...customRow,
      value: "typed-by-keyboard",
    });
  });

  it("Custom… entry cancels back to the plain row on Escape, without committing", () => {
    const rows = buildHarnessModelRows(
      CLAUDE_HARNESS,
      [model({ slug: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" })],
      null,
    );
    const customRow = rows.find((row) => row.pinned === "custom");
    expect(customRow).toBeDefined();
    if (customRow === undefined) return;

    const onSelect = vi.fn();
    render(<CustomRowHarness row={customRow} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("option", { name: /Custom…/ }));
    fireEvent.change(screen.getByLabelText("Custom model id"), {
      target: { value: "abandoned-draft" },
    });
    fireEvent.keyDown(screen.getByLabelText("Custom model id"), {
      key: "Escape",
    });

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Custom model id")).toBeNull();
    expect(screen.getByRole("option", { name: /Custom…/ })).toBeTruthy();
  });

  it("search mode drops Custom… and keeps a matching default-model row", () => {
    const rows = buildHarnessModelRows(
      CLAUDE_HARNESS,
      [model({ slug: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" })],
      "claude-preview-model",
    );
    const searchIndex = createModelRowSearchIndex(rows);

    const noQuery = filterModelRows(rows, searchIndex, "");
    expect(noQuery.some((row) => row.pinned === "custom")).toBe(true);

    const matched = filterModelRows(rows, searchIndex, "preview");
    expect(matched.some((row) => row.pinned === "custom")).toBe(false);
    expect(
      matched.some(
        (row) =>
          row.pinned === "default-model" &&
          row.value === "claude-preview-model",
      ),
    ).toBe(true);

    // A query that only the Custom… label could match (it never does - no
    // id/label to fuzz against) returns nothing pinned.
    const noCustomMatch = filterModelRows(rows, searchIndex, "custom");
    expect(noCustomMatch.every((row) => row.pinned !== "custom")).toBe(true);
  });
});
