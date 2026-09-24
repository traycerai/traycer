/**
 * The composer's identity dropdown, beside the harness/model picker.
 *
 * Writes through the toolbar store's `setIdentityId`, so the choice rides the
 * same settings tuple as the model: `queueSettingsUpdate` on a live chat,
 * `epic.createChat`'s initial message on a new one, and the per-host last-run
 * memory in `composer-run-settings-store`. See `composer-identity-model.ts`
 * for which host it reads and when it hides.
 */
import { useRef } from "react";
import { useStore } from "zustand";
import { ChevronDown, IdCard, Plus, Settings2, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  ToolbarIconButton,
  ToolbarPillButton,
} from "@/components/home/toolbar/toolbar-buttons";
import {
  composerIdentityLabel,
  composerIdentityTitle,
  selectedIdentityIdOf,
  useComposerIdentityModel,
} from "@/components/home/pickers/composer-identity-model";
import { focusActiveComposer } from "@/lib/composer/composer-focus-registry";
import { cn } from "@/lib/utils";
import type { ComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

/** Radix radio values are strings; this one can never be an identity id,
 *  whose grammar starts with an alphanumeric. */
const NONE_VALUE = "-none";

interface ComposerIdentityPickerProps {
  readonly store: ComposerToolbarStore;
  /** The composer's run target; see `useComposerIdentityModel`. */
  readonly hostId: string | null;
  readonly disabled: boolean;
}

export function ComposerIdentityPicker(props: ComposerIdentityPickerProps) {
  const { store, hostId, disabled } = props;
  const model = useComposerIdentityModel(store, hostId);
  const setIdentityId = useStore(store, (s) => s.setIdentityId);
  // Set when an entry opens the Identities dialog, so closing the menu does
  // not pull focus back into the composer from under the dialog.
  const openingDialog = useRef(false);
  if (model === null) return null;
  const { resolution, identities, listFailed } = model;
  const label = composerIdentityLabel(resolution);

  const openDialog = (mode: "list" | "create") => {
    openingDialog.current = true;
    useDesktopDialogStore
      .getState()
      .openIdentitiesFor({ hostId: model.hostId, mode });
  };

  return (
    <div className="flex min-w-0 shrink items-center">
      <DropdownMenu>
        <TooltipWrapper
          label={`Identity: ${label}`}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <DropdownMenuTrigger asChild>
            <ToolbarPillButton
              aria-label={`Identity: ${label}`}
              disabled={disabled}
              data-testid="composer-identity-trigger"
              data-identity-state={resolution.kind}
              className={cn(
                "max-w-[min(28cqw,11rem)] disabled:cursor-not-allowed disabled:opacity-50",
                resolution.kind === "removed" && "text-warning-foreground",
              )}
            >
              <IdCard className="size-4 shrink-0" />
              {resolution.kind === "none" ? null : (
                <span className="min-w-0 flex-1 truncate whitespace-nowrap @max-lg:hidden">
                  {label}
                </span>
              )}
              {resolution.kind === "none" ? null : (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground @max-lg:hidden" />
              )}
            </ToolbarPillButton>
          </DropdownMenuTrigger>
        </TooltipWrapper>
        <DropdownMenuContent
          align="end"
          className="min-w-[min(90vw,16rem)] max-w-[min(90vw,22rem)]"
          onCloseAutoFocus={(event) => {
            if (openingDialog.current) {
              openingDialog.current = false;
              event.preventDefault();
              return;
            }
            if (focusActiveComposer()) event.preventDefault();
          }}
        >
          <DropdownMenuLabel>Identity</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={selectedIdentityIdOf(resolution) ?? NONE_VALUE}
            onValueChange={(next) => {
              if (disabled) return;
              setIdentityId(next === NONE_VALUE ? null : next);
            }}
          >
            <DropdownMenuRadioItem
              value={NONE_VALUE}
              data-testid="composer-identity-option-none"
            >
              None
            </DropdownMenuRadioItem>
            {resolution.kind === "removed" ? (
              <DropdownMenuRadioItem
                value={resolution.identityId}
                disabled
                data-testid="composer-identity-option-removed"
              >
                Removed identity
              </DropdownMenuRadioItem>
            ) : null}
            {identities?.map((identity) => (
              <DropdownMenuRadioItem
                key={identity.identityId}
                value={identity.identityId}
                data-testid="composer-identity-option"
                data-identity-id={identity.identityId}
              >
                <span className="min-w-0 truncate">
                  {composerIdentityTitle(identity)}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <IdentityListStatus
            loaded={identities !== undefined}
            failed={listFailed}
          />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="composer-identity-new"
            onSelect={() => openDialog("create")}
          >
            <Plus />
            New identity
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="composer-identity-manage"
            onSelect={() => openDialog("list")}
          >
            <Settings2 />
            Manage identities
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {resolution.kind === "removed" ? (
        <TooltipWrapper
          label="Clear removed identity"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <ToolbarIconButton
            aria-label="Clear removed identity"
            data-testid="composer-identity-clear"
            disabled={disabled}
            className="size-6 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => setIdentityId(null)}
          >
            <X className="size-3.5" />
          </ToolbarIconButton>
        </TooltipWrapper>
      ) : null}
    </div>
  );
}

function IdentityListStatus(props: {
  readonly loaded: boolean;
  readonly failed: boolean;
}) {
  if (props.loaded) return null;
  return (
    <div
      className="flex items-center gap-2 px-1.5 py-1 text-ui-xs text-muted-foreground"
      data-testid="composer-identity-list-status"
    >
      {props.failed ? (
        "Couldn't load identities from this host."
      ) : (
        <>
          <MutedAgentSpinner />
          Loading identities
        </>
      )}
    </div>
  );
}
