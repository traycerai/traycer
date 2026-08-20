import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function DraftAuthorityBanner(props: {
  readonly ownerLabel: string;
  readonly claiming: boolean;
  readonly claimError: string | null;
  readonly publicationLabel: string | null;
  readonly onClaim: () => void;
}): ReactNode {
  return (
    <div
      data-testid="draft-authority-banner"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-ui-sm text-muted-foreground"
    >
      <p>
        Read-only. Owned by {props.ownerLabel}
        {props.publicationLabel === null
          ? "."
          : ` · ${props.publicationLabel}.`}
        {props.claimError === null ? null : (
          <span className="ml-1 text-destructive">{props.claimError}</span>
        )}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={props.claiming}
        onClick={props.onClaim}
      >
        {props.claiming ? "Taking over…" : "Edit here"}
      </Button>
    </div>
  );
}
