import { useRef, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CreateBotForm } from "@/components/home/bots/create-bot-form";
import type { HostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";

/** The section a new bot is created into. */
export interface NewBotTarget {
  readonly environmentId: string;
  readonly environmentLabel: string;
  /** The control that opened the dialog; focus returns to it on dismissal. */
  readonly opener: HTMLElement | null;
}

/**
 * The create form for one more bot in the person's own section, behind its +
 * in the channel sidebar. A team's + opens the team's main bot instead: a
 * team's bots are made in that bot's channel. On success the new channel
 * opens and the dialog closes, leaving focus to the channel; dismissed, it
 * returns focus to its opener while that is still on the page.
 *
 * The body scrolls between the header and the form's own controls, so a long
 * form stays inside the viewport.
 */
export function NewBotDialog(props: {
  readonly target: NewBotTarget | null;
  readonly connectableHostIds: ReadonlyArray<string>;
  readonly environmentBindings: HostEnvironmentBindings;
  readonly onClose: () => void;
}): ReactNode {
  const { target, onClose } = props;
  // Escape, Close, an outside press and the form's Cancel dismiss; a success
  // closes through `onClose` directly and keeps the destination's focus.
  const dismissedRef = useRef(false);
  const dismiss = (): void => {
    dismissedRef.current = true;
    onClose();
  };
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      {target === null ? null : (
        <DialogContent
          layout="banded"
          className="grid max-h-[min(86dvh,calc(100dvh-2rem))] w-full min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-lg"
          data-testid="new-bot-dialog"
          onOpenAutoFocus={() => {
            dismissedRef.current = false;
          }}
          onCloseAutoFocus={(event) => {
            // Opened through state, not a `DialogTrigger`: the primitive has
            // no trigger to return focus to.
            const opener = target.opener;
            if (!dismissedRef.current || opener === null) return;
            if (!opener.isConnected) return;
            event.preventDefault();
            opener.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle className="min-w-0 wrap-anywhere">New bot</DialogTitle>
            <DialogDescription>The bot gets its own channel.</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto px-5 py-4">
            <CreateBotForm
              environmentId={target.environmentId}
              environmentLabel={target.environmentLabel}
              connectableHostIds={props.connectableHostIds}
              environmentBindings={props.environmentBindings}
              onCreated={onClose}
              onCancel={dismiss}
            />
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
