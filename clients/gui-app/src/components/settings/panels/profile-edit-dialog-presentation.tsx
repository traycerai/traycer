import type { ReactNode } from "react";
import { Trash2 } from "lucide-react";
import type {
  ProviderProfile,
  ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import { ProviderProfileCard } from "@/components/providers/provider-profile-card";
import { profileDisplayLabel } from "@/components/providers/provider-profile-model";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

/** Shared form and removal flow; each scope supplies its own writes and optional account controls. */
export function ProfileEditDialogPresentation(props: {
  readonly profile: ProviderProfile;
  readonly profiles: readonly ProviderProfile[];
  readonly title: string;
  readonly description: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly switchingAccount: boolean;
  readonly label: string;
  readonly onLabelChange: (label: string) => void;
  readonly accentColor: ProviderProfileAccentColor | null;
  readonly onSelectColor: (color: ProviderProfileAccentColor) => void;
  readonly savePending: boolean;
  readonly changed: boolean;
  readonly invalid: boolean;
  readonly onSave: () => void;
  readonly removePending: boolean;
  readonly removeDisabledReason: string | null;
  readonly removeAriaLabel: string;
  readonly onRequestRemove: () => void;
  readonly confirmRemoveOpen: boolean;
  readonly onConfirmRemoveOpenChange: (open: boolean) => void;
  readonly removeDescription: string;
  readonly onConfirmRemove: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <>
      <Dialog
        open={props.open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && (props.savePending || props.switchingAccount))
            return;
          props.onOpenChange(nextOpen);
        }}
      >
        <DialogContent
          layout="banded"
          className="flex max-h-[min(85dvh,40rem)] w-[min(92vw,30rem)] flex-col overflow-hidden sm:max-w-none"
          showCloseButton={!props.switchingAccount}
        >
          <DialogHeader className="gap-1.5">
            <DialogTitle>{props.title}</DialogTitle>
            <DialogDescription>{props.description}</DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 pb-5">
            <ProviderProfileCard
              key={props.profile.profileId}
              profile={props.profile}
              profiles={props.profiles}
              label={props.label}
              onLabelChange={props.onLabelChange}
              selectedColor={props.accentColor}
              onSelectColor={props.onSelectColor}
              disabled={props.savePending || props.switchingAccount}
            />

            {props.children}
          </div>

          <DialogFooter className={props.switchingAccount ? "hidden" : ""}>
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <TooltipWrapper
                label={props.removeDisabledReason}
                side="top"
                sideOffset={6}
                align="start"
              >
                <span className="inline-flex">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive-ghost"
                    aria-label={props.removeAriaLabel}
                    disabled={
                      props.removeDisabledReason !== null ||
                      props.removePending ||
                      props.savePending
                    }
                    onClick={props.onRequestRemove}
                  >
                    <Trash2 className="size-3.5" />
                    Remove profile
                  </Button>
                </span>
              </TooltipWrapper>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={props.savePending}
                  onClick={() => props.onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={
                    props.savePending || props.invalid || !props.changed
                  }
                  onClick={props.onSave}
                >
                  {props.savePending ? <MutedAgentSpinner /> : null}
                  Save changes
                </Button>
              </div>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDestructiveDialog
        blockedReason={null}
        open={props.confirmRemoveOpen}
        onOpenChange={props.onConfirmRemoveOpenChange}
        title={`Remove ${profileDisplayLabel(props.profile)}?`}
        description={props.removeDescription}
        cascadeSummary={null}
        actionLabel="Remove"
        isPending={props.removePending}
        onConfirm={props.onConfirmRemove}
      />
    </>
  );
}
