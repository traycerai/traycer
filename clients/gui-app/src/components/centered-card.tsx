import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import type { AgentSpinnerVariant } from "@/components/ui/agent-spinner-variant";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Marker every card of this family carries (`data-surface`), so a test can
 * prove a surface is drawn THROUGH this component rather than merely
 * resembling it. The family's whole guarantee is that its members share one
 * geometry by construction; a class-list comparison would pin the current
 * spelling of that geometry, this pins the construction. Its own attribute
 * rather than `data-slot`, which is the primitive's (`card`) and is what its
 * styling keys on.
 */
export const HOST_BOOT_CARD_SURFACE = "host-boot-card";

/**
 * THE ONE SHAPE every pre-app host surface wears.
 *
 * A launch crosses several of them in sequence - the runtime-binding fallback
 * ("Starting Traycer…"), the gate's attach cover, the window narrator's
 * startup card, and on a bad day one of the gate's own terminal cards - and
 * they are necessarily different React trees: the first mounts above
 * `HostRuntimeProvider`, the next inside the gate frame, the narrator's beside
 * it. Nothing can make them one component.
 *
 * What CAN be shared is their geometry, and it has to be, because the user
 * does not see several components - they see one card that changes shape
 * mid-launch. Reported exactly that way, twice: "the UX design gap between
 * them, it looks very weird, non aligned", and later "a modal with only the
 * Open settings button and nothing else". Before this, the sequence went
 * `max-w-sm` centred with a small muted spinner, then `max-w-md` left-aligned
 * with a large foreground spinner floating on its own line - and the
 * narrator's card was `max-w-md` again while the two before it were `sm`.
 *
 * One width, one alignment, one spinner treatment - and one BODY for every
 * healthy wait (`LocalHostLoadingContent`: headline, bar, footer, whether or
 * not a lane has spoken yet), so across a healthy launch only the sentence
 * and the bar's fill change inside a box that does not move. Only a settled
 * failure ADDS to it (a title, diagnostics, actions), which reads as one
 * surface filling in rather than several modals taking turns.
 *
 * `pointer-events-auto` is unconditional and inert everywhere but one place:
 * the narrator's startup layer is `pointer-events-none` so toasts and the gate
 * frame's header stay clickable through it, and this card is what re-enables
 * itself inside that layer. Stating it here rather than at that one call site
 * keeps the card a self-contained thing to drop into any layer.
 */
export function HostBootCard(props: {
  readonly children: ReactNode;
  readonly testId: string | null;
  /**
   * Extra `data-*` markers for the card element (a narration's variant and
   * cause, for tests and for a screenshot's provenance). `{}` when none.
   */
  readonly dataset: Readonly<Record<`data-${string}`, string>>;
  /**
   * Caps the card at ITS LAYER's height and scrolls it inside, for a card
   * drawn in a FIXED layer that cannot grow the page. A card in the gate frame
   * or the runtime fallback sits in a `min-h-svh` column that scrolls as a
   * whole, so it passes `false`; the narrator's startup layer passes `true`,
   * because a failed face with the bootstrap log open can outgrow a small
   * window.
   *
   * `max-h-full`, against the layer - NOT a viewport unit. The layer starts
   * below the app header, so it is shorter than the viewport, and a cap
   * written in `svh` can exceed the space that actually exists: at the
   * supported 300% zoom on the 600px minimum window the CSS viewport is
   * ~200px, the layer ~160px, and an `85svh` card of 170px centred in it
   * overlapped the header and the window's bottom edge with its scrollable
   * controls clipped. A percentage of the layer's own content box cannot.
   * (Resolvable because the layer is a definite-height FLEX container - see
   * `WindowHostStartupCard` for why the layer is flex and not grid.)
   */
  readonly viewportCapped: boolean;
}): ReactNode {
  const testIdProps =
    props.testId === null ? {} : { "data-testid": props.testId };
  return (
    <Card
      {...props.dataset}
      {...testIdProps}
      data-surface={HOST_BOOT_CARD_SURFACE}
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-auto w-full max-w-sm shadow-sm",
        props.viewportCapped ? "max-h-full overflow-y-auto" : null,
      )}
    >
      {/* CENTRED, and narrow. Ruled by the user against rendered screenshots,
          twice: the released card centred its content and "the centered one
          was better looking". A wide `max-w-md` box with a left-aligned line
          in it leaves most of the card empty to the right, which is what "this
          alignment is bad" was about.

          This REVERSES the earlier branch-left decision recorded in
          `local-host-loading.tsx`. That decision was correct for what it was
          deciding - a DIALOG whose own left-aligned title and description sat
          above the body, where a centred body fought the heading above it. The
          boot card is not a dialog: when a face of it does carry a title (a
          settled failure), the title centres with everything else, the way an
          alert card reads. */}
      <CardContent className="flex flex-col items-center gap-4 py-6 text-center">
        {props.children}
      </CardContent>
    </Card>
  );
}

/**
 * The spinner and the line it belongs to - stacked and centred, the way the
 * released card drew them.
 *
 * The spinner is MUTED and text-sized on purpose. It was briefly `text-title-md
 * text-foreground`, which made it the loudest thing on a card whose whole job
 * is to be calm, and left it looking like an unanchored glyph rather than the
 * label's own activity indicator. This is a TEXT spinner (braille frames scaled
 * by font-size), so sizing it to the copy is what keeps the pair legible as one
 * unit.
 */
export function HostBootHeadline(props: {
  readonly message: string;
  readonly spinnerVariant: AgentSpinnerVariant | null;
  readonly spinnerTestId: string | null;
  readonly messageTestId: string | null;
}): ReactNode {
  return (
    <div className="flex flex-col items-center gap-3">
      {props.spinnerVariant === null ? null : (
        <AgentSpinningDots
          testId={props.spinnerTestId ?? undefined}
          variant={props.spinnerVariant}
          className="text-ui text-muted-foreground"
        />
      )}
      <p
        data-testid={props.messageTestId}
        className="text-ui font-medium text-foreground"
      >
        {props.message}
      </p>
    </div>
  );
}
