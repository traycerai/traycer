/**
 * What a character on the office floor is, on hover.
 *
 * A REACT OVERLAY, NOT CANVAS TEXT. The floor's own labels are drawn into the
 * bitmap because they belong to the scene and move with it; this does not - it
 * is a description of one agent, wants the app's own type and iconography, and
 * would have to re-implement both to live on the canvas.
 *
 * `pointer-events-none` throughout: the card follows the pointer's target and
 * must never become the pointer's target, or hovering a character would flicker
 * between the two.
 */
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { cn } from "@/lib/utils";
import type { OfficeAgentStatus } from "@/lib/comm-graph/office/office-types";
import type { GuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";

/** One word per status, in the vocabulary the rest of the app already uses. */
const STATUS_LABELS: Readonly<Record<OfficeAgentStatus, string>> = {
  attention: "Needs attention",
  awaiting: "Waiting for reply",
  working: "Working",
  background: "In background",
  idle: "Idle",
  archived: "Archived",
};

export interface OfficeHoverCardProps {
  readonly name: string;
  readonly harnessId: GuiHarnessId | null;
  readonly model: string | null;
  readonly status: OfficeAgentStatus;
  /** Container-relative screen position of the hovered character's top centre. */
  readonly left: number;
  readonly top: number;
}

/**
 * The `harness · model` line, or `null` when the record carries neither. A
 * chat that has never been given run settings has both missing, and a line
 * reading only a separator would be worse than no line.
 */
function detailLine(
  harnessId: GuiHarnessId | null,
  model: string | null,
): string | null {
  if (harnessId !== null && model !== null) return `${harnessId} · ${model}`;
  return harnessId ?? model;
}

export function OfficeHoverCard(props: OfficeHoverCardProps) {
  const { harnessId, left, model, name, status, top } = props;
  const detail = detailLine(harnessId, model);
  return (
    <div
      // Anchored to the character's top centre and lifted clear of it, so the
      // card never covers the thing it describes.
      className={cn(
        "pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full",
        "max-w-64 rounded-md border border-border bg-popover px-2 py-1.5",
        "text-popover-foreground shadow-md",
      )}
      style={{ left, top: top - 8 }}
      data-testid="comm-graph-office-hover-card"
    >
      <p className="truncate text-ui-sm font-medium">{name}</p>
      {detail === null ? null : (
        <p className="mt-0.5 flex items-center gap-1 text-ui-xs text-muted-foreground">
          {harnessId === null ? null : (
            <HarnessIcon harnessId={harnessId} className="size-3" />
          )}
          <span className="truncate">{detail}</span>
        </p>
      )}
      <p className="mt-0.5 text-ui-xs text-muted-foreground">
        {STATUS_LABELS[status]}
      </p>
    </div>
  );
}
