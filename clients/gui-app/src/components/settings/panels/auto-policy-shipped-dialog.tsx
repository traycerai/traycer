import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TraycerMarkdown } from "@/markdown";
import type { ShippedAutoPolicySections } from "@/components/settings/panels/auto-policy-shipped-document";

/**
 * The read-only view of the rules the judge already applies, before anybody
 * writes a policy.
 *
 * It exists because the shipped policy was invisible in the product: the editor
 * opened on four empty headings, and the document the judge actually reads
 * reached no client. A person deciding what to put in their own policy could
 * not see what was already covered.
 *
 * **The bullets are the host's document, the labels are ours.** The three
 * sections are rendered verbatim from `shippedDefaults`, so this can never
 * describe rules the host is not running - the failure mode a hand-maintained
 * list here would have. The headings are replaced, though: the document's own
 * are prompt text addressed to the judge ("Hard block (non-overridable)"), and
 * "non-overridable" over-promises to a user, who can always approve the action
 * on the card. The labels below say what is true of the person reading them -
 * you are ASKED, and your policy cannot stop the asking.
 *
 * The out-of-scope note is the one piece of prose NOT taken from the document.
 * The document's version is an instruction to the model ("If the only sentence
 * you can write for `reason` is...") and is not readable as an answer to "what
 * does this thing not do".
 */
export function AutoPolicyShippedDialog(props: {
  readonly sections: ShippedAutoPolicySections;
  /**
   * Opens the user's own policy. `null` disables the jump - the account policy
   * could not be read, and the editor is unreachable for the same reason the
   * settings row's Edit button is disabled.
   */
  readonly onEditPolicy: (() => void) | null;
  readonly onClose: () => void;
}): ReactNode {
  const { sections, onEditPolicy } = props;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="max-h-[min(85vh,52rem)] w-[min(92vw,46rem)] overflow-y-auto"
        data-testid="auto-policy-shipped-view"
      >
        <DialogHeader>
          <DialogTitle>{VIEW_TITLE}</DialogTitle>
          <DialogDescription>{VIEW_DESCRIPTION}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <ShippedSection
            testId="auto-policy-shipped-allow"
            label={ALLOW_LABEL}
            body={sections.allowExceptions}
            note={null}
          />
          <ShippedSection
            testId="auto-policy-shipped-soft"
            label={SOFT_BLOCK_LABEL}
            body={sections.softBlock}
            note={SOFT_BLOCK_NOTE}
          />
          <ShippedSection
            testId="auto-policy-shipped-hard"
            label={HARD_BLOCK_LABEL}
            body={sections.hardBlock}
            note={HARD_BLOCK_NOTE}
          />
          <section
            className="space-y-1"
            data-testid="auto-policy-shipped-scope"
          >
            <SectionLabel label={OUT_OF_SCOPE_LABEL} />
            <p className="text-ui-xs text-muted-foreground">
              {OUT_OF_SCOPE_NOTE}
            </p>
          </section>
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-ui-xs text-muted-foreground">
            {FOOTER_NOTE}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={props.onClose}
            >
              Close
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              data-testid="auto-policy-shipped-edit"
              disabled={onEditPolicy === null}
              onClick={() => {
                if (onEditPolicy !== null) onEditPolicy();
              }}
            >
              Edit policy
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One tier. A tier this build could not find in the document is not rendered
 * at all - an empty heading would read as "the judge blocks nothing here".
 */
function ShippedSection(props: {
  readonly testId: string;
  readonly label: string;
  readonly body: string;
  readonly note: string | null;
}): ReactNode {
  if (props.body.length === 0) return null;
  return (
    <section className="space-y-1" data-testid={props.testId}>
      <SectionLabel label={props.label} />
      <TraycerMarkdown
        className="text-foreground"
        proseSize="compact"
        components={null}
        remarkPlugins={null}
        rehypePlugins={null}
        quotable={false}
        isStreaming={false}
      >
        {props.body}
      </TraycerMarkdown>
      {props.note === null ? null : (
        <p className="text-ui-xs text-muted-foreground">{props.note}</p>
      )}
    </section>
  );
}

function SectionLabel(props: { readonly label: string }): ReactNode {
  return (
    <div className="font-semibold text-ui-xs uppercase tracking-wider text-muted-foreground">
      {props.label}
    </div>
  );
}

// Copy, as plain constants rather than JSX text: every line of it has an
// apostrophe, and `&apos;` five times over makes a sentence unreadable in the
// one place a reviewer has to read it as a sentence.
const VIEW_TITLE = "What the judge already blocks";
const VIEW_DESCRIPTION =
  "Traycer's shipped rules. They are the same on every machine, and they apply before your own policy.";
const ALLOW_LABEL = "Allowed without asking";
const SOFT_BLOCK_LABEL = "Always asks you";
const SOFT_BLOCK_NOTE =
  "Unless you've asked for that exact thing in this conversation.";
const HARD_BLOCK_LABEL = "Always asked, your policy can't turn these off";
const HARD_BLOCK_NOTE =
  "You can still approve any of these on the card. Your policy can't stop Traycer asking.";
const OUT_OF_SCOPE_LABEL = "Not the judge's job";
const OUT_OF_SCOPE_NOTE =
  "The judge doesn't decide whether an action is relevant to what you asked for. Work that is off-track, unnecessary or not what you meant is for you to correct - it isn't blocked.";
const FOOTER_NOTE = "Your own rules go on top of these.";
