/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Judge).
 * Update that file whenever this settings surface changes.
 */
import { useEffect, type ComponentProps, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HarnessModelTrigger } from "@/components/home/pickers/harness-model-trigger";
import type { HarnessModelSelection } from "@/components/home/data/landing-options";
import type { ProfileAccentDotInput } from "@/components/providers/provider-profile-model";
import { cn } from "@/lib/utils";

/** What the second tile's model control shows. */
export interface JudgeFace {
  /** The pick, drawn as the composer's chip; `null` draws "Choose a model". */
  readonly selection: HarnessModelSelection | null;
  /**
   * Everything the chip says after the provider icon: the model, the account
   * when its provider has more than one, and why a last pick cannot run.
   */
  readonly label: string;
  readonly accentDot: ProfileAccentDotInput | null;
  /** Dimmed while Automatic is on, until the picker opens from it. */
  readonly dimmed: boolean;
  /** Neither clickable nor focusable: a click on it lands on the tile. */
  readonly inert: boolean;
}

/** Marks the face, so the tile can tell a click that started on it. */
export const JUDGE_MODEL_FACE_SELECTOR = "[data-judge-model-face]";

type JudgeModelFaceProps = ComponentProps<"button"> & {
  readonly face: JudgeFace;
  /**
   * Told whenever the picker opens or closes, read off the `aria-expanded`
   * the popover trigger hands this face: the picker reports its open state to
   * nobody else.
   */
  readonly onExpandedChange: (expanded: boolean) => void;
};

/**
 * The face of the judge's picker: the `PopoverTrigger`'s child, so it takes
 * the trigger's ref and props and passes them to the button it draws.
 *
 * An inert face is never natively `disabled`. `HarnessModelTrigger` is a plain
 * `<button>`, and a disabled one eats the click, so the tile would never hear
 * a click on the dimmed chip. It carries `aria-disabled`, leaves the Tab order,
 * and its wrapper stops taking the pointer, so the click lands on the tile.
 * The dimming is the wrapper's own opacity for the same reason: nothing here
 * rides on `disabled:`.
 */
export function JudgeModelFace(props: JudgeModelFaceProps): ReactNode {
  const { face, onExpandedChange, ref, ...trigger } = props;
  const expanded =
    trigger["aria-expanded"] === true || trigger["aria-expanded"] === "true";
  useEffect(() => {
    onExpandedChange(expanded);
  }, [expanded, onExpandedChange]);
  const inertProps: Pick<
    ComponentProps<"button">,
    "aria-disabled" | "tabIndex"
  > = face.inert ? { "aria-disabled": true, tabIndex: -1 } : {};
  return (
    <span
      className={cn(
        "flex max-w-full min-w-0 self-start",
        face.dimmed && !expanded && "opacity-45",
        face.inert && "pointer-events-none",
      )}
    >
      {face.selection === null ? (
        <Button
          ref={ref}
          type="button"
          variant="muted-outline"
          size="sm"
          {...trigger}
          {...inertProps}
          data-judge-model-face=""
          data-testid="auto-judge-model-face"
        >
          {face.label}
          <ChevronDown data-icon="inline-end" />
        </Button>
      ) : (
        <HarnessModelTrigger
          ref={ref}
          {...trigger}
          {...inertProps}
          selection={face.selection}
          label={face.label}
          reasoningLabel={null}
          reasoningStep={null}
          reasoningIndicator="text"
          serviceTierLabel={null}
          serviceTierActive={false}
          profileLabel={null}
          profileAccentDot={face.accentDot}
          isLoading={false}
          disabled={false}
          labelDisplay="model-only"
          aria-label={`Judge model: ${face.label}`}
          data-judge-model-face=""
          data-testid="auto-judge-model-face"
        />
      )}
    </span>
  );
}
