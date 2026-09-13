/**
 * Which office this epic is drawn as.
 *
 * A radio group, not a cycle button: the views are alternatives rather than
 * steps, every one of them is somebody's preferred reading, and the one you
 * are on has to be visible without opening anything. Each row carries the
 * view's own one-line description, because "Towers" tells a first-time reader
 * nothing about what they will get.
 *
 * AUTO IS A COMMAND, not just a value. Picking the view you are already on is
 * a no-op - handled by the tile, which owns the write - except for Auto, which
 * always re-measures: an epic that has doubled in size since it was last
 * measured is exactly when a person asks again.
 */
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  officeZoomLabel,
  type OfficeAutoDecision,
} from "@/lib/comm-graph/office/office-auto";
import { OFFICE_LOD_OFFICE_ZOOM } from "@/lib/comm-graph/office/office-lod";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";
import {
  isOfficeViewChoice,
  OFFICE_VIEW_IDS,
  type OfficeViewChoice,
  type OfficeViewId,
} from "@/lib/comm-graph/office/office-view-vocabulary";

export interface OfficeViewPickerProps {
  /** What this tile is set to - `"auto"` included, which is a choice. */
  readonly choice: OfficeViewChoice;
  /** What Auto currently resolves to, or `null` while it is measuring. */
  readonly autoViewId: OfficeViewId | null;
  /** The measurement behind that, if this tile still has it in hand. */
  readonly decision: OfficeAutoDecision | null;
  readonly onChoose: (choice: OfficeViewChoice) => void;
}

/**
 * The Auto row's second line: the numbers Auto decided on, said in full.
 *
 * The chip over the floor says which view won; this says what it beat and by
 * how much, which is the part a person disagreeing with the outcome needs.
 */
function autoReason(
  decision: OfficeAutoDecision | null,
  measuring: boolean,
): string {
  if (decision === null) {
    return measuring
      ? "Measuring this tile…"
      : "Picks by how much of the office fits this tile.";
  }
  // "fits at" belongs to the view that WON, which is not the first one
  // measured. `decideOfficeView` keeps `fits` in candidate order and takes the
  // first entry that reaches the threshold, so a Floor that fails and a Towers
  // that wins used to read "Floor fits at 0.2×, Towers at 0.8×" - the claim
  // attached to the loser. When nothing reaches, the outcome is the fallback
  // view, which is in no entry here, and then no entry says "fits" - which is
  // the truth as well.
  const fits = decision.fits
    .map(
      (fit) =>
        `${OFFICE_VIEWS[fit.view].label} ${fit.view === decision.view ? "fits at" : "at"} ${officeZoomLabel(fit.zoom)}`,
    )
    .join(", ");
  return `${fits}; office detail needs ${OFFICE_LOD_OFFICE_ZOOM}×. Choose Auto again to re-measure.`;
}

function triggerLabel(
  choice: OfficeViewChoice,
  autoViewId: OfficeViewId | null,
): string {
  if (choice !== "auto") return OFFICE_VIEWS[choice].label;
  // The resolved view rides along, because "Auto" alone leaves the one
  // question the control exists to answer - which office am I looking at -
  // unanswered on the surface.
  return autoViewId === null
    ? "Auto"
    : `Auto · ${OFFICE_VIEWS[autoViewId].label}`;
}

export function OfficeViewPicker(props: OfficeViewPickerProps) {
  const { autoViewId, choice, decision, onChoose } = props;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label="Office view"
          data-testid="comm-graph-office-view-picker"
        >
          {triggerLabel(choice, autoViewId)}
          <ChevronDown data-icon="inline-end" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      {/* The shadcn base pins `w` to the trigger; max-w cannot displace it. */}
      <DropdownMenuContent align="end" className="w-[min(90vw,22rem)]">
        <DropdownMenuRadioGroup
          value={choice}
          onValueChange={(value) => {
            if (isOfficeViewChoice(value)) onChoose(value);
          }}
        >
          <DropdownMenuRadioItem
            value="auto"
            data-testid="comm-graph-office-view-auto"
          >
            <span className="flex flex-col gap-0.5">
              <span>Auto</span>
              <span className="text-ui-xs text-muted-foreground">
                {autoReason(decision, choice === "auto" && autoViewId === null)}
              </span>
            </span>
          </DropdownMenuRadioItem>
          {OFFICE_VIEW_IDS.map((id) => (
            <DropdownMenuRadioItem
              key={id}
              value={id}
              data-testid={`comm-graph-office-view-${id}`}
            >
              <span className="flex flex-col gap-0.5">
                <span>{OFFICE_VIEWS[id].label}</span>
                <span className="text-ui-xs text-muted-foreground">
                  {OFFICE_VIEWS[id].description}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
