import type { ReactNode } from "react";
import { Check } from "lucide-react";
import {
  HostGlyph,
  HostPresenceDot,
} from "@/components/settings/host-scope/host-glyph";
import {
  hostOptionKindLabel,
  hostOptionStatusWord,
  type HostPickIntent,
  type HostRowSurfaceState,
} from "@/components/settings/host-scope/host-option-model";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { cn } from "@/lib/utils";

/**
 * ONE host row: kind glyph · name · [ACTIVE] · status word · presence dot ·
 * check.
 *
 * This is the whole shared vocabulary, and it is deliberately content only —
 * no button, no `CommandItem`, no list semantics. The containers differ in ways
 * that are theirs to own (a cmdk item in a combobox, a radio in a dialog, a row
 * in a section of another popover), and forcing one interaction shell on all of
 * them is what would make the shared picker sit badly in each. What must not
 * differ is this: three pickers each inventing their own icon set, their own
 * dot and their own word for "offline" is exactly what this replaced.
 *
 * Single-line by design. The old two-line row restated health as words under
 * every name, which at six hosts read as a log rather than a list; the dot
 * carries it, and the full sentence lives on Overview where there is room for
 * it to be useful.
 */
export function HostOptionRow(props: {
  readonly host: HostScopeOption;
  /** The row this surface is currently pointed at — draws the check. */
  readonly picked: boolean;
  /** The app-wide active host — where new work lands. */
  readonly active: boolean;
  readonly intent: HostPickIntent;
  /**
   * What this surface is saying about the row, as one value — see
   * `HostRowSurfaceState`. A union so "inert" and "refused with a word" cannot
   * both be true of one row.
   */
  readonly surfaceState: HostRowSurfaceState;
}): ReactNode {
  const { host } = props;
  // Includes "setting up" (M5): host-scope narration for a local host being
  // installed. When another host can serve the window that setup is NOT a
  // window-wide event — the global modal deliberately stays away, and this row
  // plus Settings' progress banner are where it shows instead.
  const statusWord = hostOptionStatusWord(host, props.surfaceState);
  // The ACTIVE tag exists to separate two marks that can disagree: what you are
  // VIEWING versus what this window runs on. Under `bind` they are the same
  // fact by definition, so the tag would restate the check it sits next to.
  const showActiveTag = props.intent === "view" && props.active;
  return (
    <>
      <HostGlyph
        host={host}
        className="size-4 shrink-0 text-muted-foreground"
      />
      <span className="sr-only">{hostOptionKindLabel(host)}</span>
      <span className="min-w-0 flex-1 truncate text-left">{host.name}</span>
      {props.picked && props.intent === "view" ? (
        <span className="sr-only">Currently viewing</span>
      ) : null}
      {showActiveTag ? <ActiveTag /> : null}
      {statusWord === null ? null : (
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          {statusWord}
        </span>
      )}
      <HostPresenceDot
        tone={host.health.tone}
        animate={host.health.live}
        className={undefined}
      />
      {props.picked ? (
        <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
      ) : (
        <span className="size-3.5 shrink-0" aria-hidden />
      )}
    </>
  );
}

/**
 * The accent is reserved for the BINDING — which host this window uses. It
 * never marks the viewing selection, so the two can always be told apart at a
 * glance even when they happen to be the same host.
 */
function ActiveTag(): ReactNode {
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm bg-primary/15 px-1 py-px",
        "text-[0.625rem] font-medium uppercase tracking-wide text-primary",
      )}
    >
      Active
    </span>
  );
}
