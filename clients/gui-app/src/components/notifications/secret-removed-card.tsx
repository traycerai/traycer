import type { ReactNode } from "react";
import { secretRemovedOutcomeWord } from "@/components/settings/members/copy";

/**
 * Extra content for `secret.removed`: the outcome word. Details:
 * `kind: "secret", key: ""` (page-level).
 */
export function SecretRemovedCard(props: {
  readonly secretName: string;
  readonly outcome: "revoked" | "cleanup_requested" | "destroyed";
  readonly details: ReactNode;
}): ReactNode {
  return (
    <div
      className="flex flex-col gap-1.5 text-ui-xs"
      data-testid="secret-removed-card"
    >
      <p data-testid="secret-removed-name">{props.secretName}</p>
      <p data-testid="secret-removed-outcome">
        {secretRemovedOutcomeWord(props.outcome)}
      </p>
      {props.details}
    </div>
  );
}
