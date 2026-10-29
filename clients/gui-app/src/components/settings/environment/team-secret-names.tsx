import type { ReactNode } from "react";

/**
 * Viewers see names and whether they are set, with no credential actions. The
 * list heads nothing of its own: the page it sits on already names the
 * section, and the page's standing line says what the reader's role can do, so
 * neither a "Secrets" heading nor a claim about editors is repeated here.
 */
export function TeamSecretNames(props: {
  readonly secrets: readonly {
    readonly name: string;
    readonly revoked: boolean;
  }[];
}): ReactNode {
  if (props.secrets.length === 0) {
    return (
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="secrets-none"
      >
        No secrets.
      </p>
    );
  }
  return (
    <ul
      className="divide-y divide-border/60 rounded-lg border border-border/60"
      aria-label="Secrets"
    >
      {props.secrets.map((secret) => (
        <li key={secret.name} className="flex flex-col gap-1 p-3">
          <span className="font-mono text-ui-sm">{secret.name}</span>
          <span className="text-ui-xs text-muted-foreground">
            {secret.revoked ? "Removing · no longer usable" : "Set"}
          </span>
        </li>
      ))}
    </ul>
  );
}
