import type { ReactNode } from "react";

/**
 * The reason a credential control is disabled (`useHostCredentialRefusal`),
 * under the control it disables; nothing when the host takes credentials.
 */
export function CredentialRefusalNote(props: {
  readonly refusal: string | null;
}): ReactNode {
  if (props.refusal === null) return null;
  return (
    <p
      data-testid="credential-refusal"
      className="text-ui-xs text-muted-foreground"
    >
      {props.refusal}
    </p>
  );
}
