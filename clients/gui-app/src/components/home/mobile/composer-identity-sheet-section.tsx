/**
 * The phone mirror of `ComposerIdentityPicker`: the same choices as flat rows
 * inside `ComposerOptionsSheet`, because a Radix dropdown nested in the vaul
 * drawer is the layering that sheet exists to avoid. Reads the same model, so
 * the two surfaces cannot disagree about what is selected or removed.
 */
import type { ReactNode } from "react";
import { IdCard, Plus, Settings2, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  OptionRow,
  OptionsSectionLabel,
} from "@/components/home/mobile/composer-options-sheet";
import {
  composerIdentityTitle,
  selectedIdentityIdOf,
  type ComposerIdentityModel,
} from "@/components/home/pickers/composer-identity-model";
import type { IdentitiesDialogMode } from "@/stores/dialogs/desktop-dialog-store";

interface ComposerIdentitySheetSectionProps {
  readonly model: ComposerIdentityModel;
  readonly disabled: boolean;
  readonly onSelect: (identityId: string | null) => void;
  /** Opens the Identities dialog; the caller closes the sheet first. */
  readonly onOpenIdentities: (mode: IdentitiesDialogMode) => void;
}

const ICON_CLASS = "mt-0.5 size-4 shrink-0 text-muted-foreground";

export function ComposerIdentitySheetSection(
  props: ComposerIdentitySheetSectionProps,
): ReactNode {
  const { model, disabled, onSelect, onOpenIdentities } = props;
  const { resolution, identities, listFailed } = model;
  const selectedId = selectedIdentityIdOf(resolution);
  return (
    <div data-testid="composer-options-identity">
      <div role="radiogroup" aria-label="Identity">
        <OptionsSectionLabel>Identity</OptionsSectionLabel>
        {resolution.kind === "removed" ? (
          <div
            className="flex items-start gap-3 px-3 py-2.5"
            data-testid="composer-options-identity-removed"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-ui-sm font-medium text-warning-foreground">
                Removed identity
              </span>
              <span className="text-ui-xs text-muted-foreground">
                This chat&apos;s identity no longer exists.
              </span>
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              data-testid="composer-options-identity-clear"
              onClick={() => onSelect(null)}
            >
              <X />
              Clear
            </Button>
          </div>
        ) : null}
        <OptionRow
          icon={<IdCard className={ICON_CLASS} />}
          label="None"
          description="Run without an identity."
          metaLine={null}
          notice={null}
          selected={selectedId === null}
          disabled={disabled}
          testId="composer-options-identity-none"
          onSelect={() => onSelect(null)}
        />
        {identities?.map((identity) => (
          <OptionRow
            key={identity.identityId}
            icon={<IdCard className={ICON_CLASS} />}
            label={composerIdentityTitle(identity)}
            description={identity.description ?? ""}
            metaLine={null}
            notice={null}
            selected={selectedId === identity.identityId}
            disabled={disabled}
            testId={`composer-options-identity-${identity.identityId}`}
            onSelect={() => onSelect(identity.identityId)}
          />
        ))}
        {identities === undefined ? (
          <p className="flex items-center gap-2 px-3 py-2 text-ui-xs text-muted-foreground">
            {listFailed ? (
              "Couldn't load identities from this host."
            ) : (
              <>
                <MutedAgentSpinner />
                Loading identities
              </>
            )}
          </p>
        ) : null}
      </div>
      <SheetAction
        icon={<Plus className={ICON_CLASS} />}
        label="New identity"
        testId="composer-options-identity-new"
        onSelect={() => onOpenIdentities("create")}
      />
      <SheetAction
        icon={<Settings2 className={ICON_CLASS} />}
        label="Manage identities"
        testId="composer-options-identity-manage"
        onSelect={() => onOpenIdentities("list")}
      />
    </div>
  );
}

function SheetAction(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly testId: string;
  readonly onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      data-testid={props.testId}
      className="flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left text-ui-sm font-medium text-foreground transition-colors active:bg-accent/60"
      onClick={props.onSelect}
    >
      {props.icon}
      {props.label}
    </button>
  );
}
