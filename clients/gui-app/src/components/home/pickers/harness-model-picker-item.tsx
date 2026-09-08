import type { HarnessModelRow } from "@/components/home/data/harness-model-search";
import { Badge } from "@/components/ui/badge";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import { guiAgentModelCapabilitiesSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  useCallback,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

interface HarnessModelPickerItemProps {
  readonly idPrefix: string;
  readonly row: HarnessModelRow;
  readonly selected: boolean;
  readonly active: boolean;
  readonly showCapacity: boolean;
  readonly onHover: (rowId: string) => void;
  readonly onActive: (rowId: string) => void;
  readonly onSelect: (row: HarnessModelRow) => void;
  /** D09's `Custom…` row is OPEN for typing. Owned by the picker, not by this
   *  row, so click and Enter open it through the one shared select path
   *  (`selectRow`) - a keyboard activation used to commit the pinned row's
   *  empty `value` and blank the composer's model instead. */
  readonly customRowOpen: boolean;
  readonly onCloseCustomRow: () => void;
}

export function HarnessModelPickerItem(props: HarnessModelPickerItemProps) {
  const {
    idPrefix,
    row,
    selected,
    active,
    showCapacity,
    onHover,
    onActive,
    onSelect,
    customRowOpen,
    onCloseCustomRow,
  } = props;

  // The typed text only. WHETHER the field is showing is the picker's state
  // (`customRowOpen`), because both gestures that open it - clicking the row
  // and pressing Enter on it - arrive through the picker's shared select
  // path. Every other row (including the `default-model` pinned row, which
  // already has a concrete `value`) never enters this state.
  const [customModelDraft, setCustomModelDraft] = useState("");

  if (row.pinned === "custom" && customRowOpen) {
    return (
      <CustomModelEntryField
        elementId={modelRowElementId(idPrefix, row.id)}
        value={customModelDraft}
        onChange={setCustomModelDraft}
        onCommit={(modelSlug) => {
          // Same commit path as any catalog row (`onSelect`) - only the
          // `value` differs, carrying the typed id instead of the pinned
          // row's empty one, which is what makes `selectRow` commit rather
          // than re-open.
          onSelect({ ...row, value: modelSlug });
          setCustomModelDraft("");
          onCloseCustomRow();
        }}
        onCancel={() => {
          setCustomModelDraft("");
          onCloseCustomRow();
        }}
      />
    );
  }

  // Search is scoped to the active harness, so rows render identically whether
  // browsing or searching: the `browseLabel` (which drops the OpenCode upstream
  // prefix now carried by the group header) and no redundant harness context.
  const capacityLabel =
    showCapacity && row.capacityLabel !== null ? row.capacityLabel : null;
  // Same "has a notice" predicate TooltipWrapper uses (null or empty string is
  // no notice), so the badge never renders without the tooltip behind it.
  const hasDeprecationNotice =
    row.deprecationNotice !== null && row.deprecationNotice.length > 0;
  const supportsImageGeneration = modelSupportsImageGeneration(row);
  const tooltipLabel = modelRowTooltipLabel(
    row.deprecationNotice,
    supportsImageGeneration,
  );

  return (
    // Anchored to the row button so capability/deprecation details are reachable
    // by hover and keyboard focus. Radix merges the tooltip handlers with the
    // button via `asChild`; `label={null}` is a transparent pass-through.
    <TooltipWrapper
      label={tooltipLabel}
      side="top"
      sideOffset={6}
      align="center"
    >
      <button
        id={modelRowElementId(idPrefix, row.id)}
        type="button"
        role="option"
        aria-selected={selected}
        data-active={active}
        data-selected={selected}
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
          // Hover/keyboard active: subtle, transient feedback.
          active && "bg-accent/30",
          // Selected: the prominent persistent state (matches the primary Check).
          // Listed last so tailwind-merge lets it win when you hover the selected
          // row - the selection stays loud, hover just adds nothing extra.
          selected && "bg-accent/70",
        )}
        onMouseEnter={() => {
          onHover(row.id);
          onActive(row.id);
        }}
        onFocus={() => {
          onActive(row.id);
        }}
        onClick={() => {
          onSelect(row);
        }}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium leading-5">
            {row.browseLabel}
          </span>
        </span>
        {hasDeprecationNotice ? (
          <Badge variant="destructive" className="shrink-0">
            Deprecated
          </Badge>
        ) : null}
        {capacityLabel === null ? null : (
          <span className="shrink-0 rounded-md bg-foreground/8 px-1.5 py-0.5 text-ui-xs text-muted-foreground">
            {capacityLabel}
          </span>
        )}
        {selected ? (
          <Check className="size-4 shrink-0 text-primary" />
        ) : (
          <span className="size-4 shrink-0" />
        )}
      </button>
    </TooltipWrapper>
  );
}

interface CustomModelEntryFieldProps {
  readonly elementId: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onCommit: (modelSlug: string) => void;
  readonly onCancel: () => void;
}

/**
 * D09's `Custom…` row, expanded: a single free-form model-id field. Enter
 * commits a non-empty trimmed value; Escape (or losing focus) cancels back to
 * the plain `Custom…` row. Both keys stop propagation so they don't also
 * reach the panel-level `onKeyDown` (`handleHarnessModelPickerKeyDown`) -
 * that handler's own Enter branch would otherwise commit whatever row is
 * currently "active" underneath this field, and its Escape would close the
 * whole picker instead of just this field.
 */
function CustomModelEntryField(props: CustomModelEntryFieldProps): ReactNode {
  const { elementId, value, onChange, onCommit, onCancel } = props;
  // Stable callback ref focuses the field when the row expands, without the
  // banned `autoFocus` prop (same pattern as `ShellFlagChips`). The field
  // only ever mounts on that expansion, so this is the same moment.
  const focusField = useCallback((node: HTMLInputElement | null): void => {
    node?.focus();
  }, []);
  return (
    <div className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5">
      <input
        ref={focusField}
        id={elementId}
        type="text"
        aria-label="Custom model id"
        placeholder="model-id"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            const modelSlug = value.trim();
            if (modelSlug.length === 0) return;
            onCommit(modelSlug);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        onBlur={onCancel}
        className="w-full rounded-md border border-input bg-transparent px-2 py-1 text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      />
    </div>
  );
}

function modelSupportsImageGeneration(row: HarnessModelRow): boolean {
  const parsed = guiAgentModelCapabilitiesSchema.safeParse(
    row.model.metadata.capabilities,
  );
  return parsed.success && parsed.data.imageGeneration;
}

function modelRowTooltipLabel(
  deprecationNotice: string | null,
  supportsImageGeneration: boolean,
): string | null {
  const imageLabel = supportsImageGeneration
    ? "Supports image generation"
    : null;
  if (deprecationNotice === null || deprecationNotice.length === 0) {
    return imageLabel;
  }
  return imageLabel === null
    ? deprecationNotice
    : `${deprecationNotice} · ${imageLabel}`;
}

function modelRowElementId(idPrefix: string, rowId: string): string {
  return `${idPrefix}-row-${rowId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
