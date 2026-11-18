import type { AuthnSecretsReplaceValueResponse } from "@traycer-clients/shared/environment/configuration-secrets";
import { SECRET_REPLACE_STALE } from "@/lib/sandboxes/secrets-page-copy";

/** What a replacement's answer means for the dialog: close, or say why not. */
export type ReplaceOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "note"; readonly text: string; readonly reread: boolean };

export function replaceOutcome(
  answer: AuthnSecretsReplaceValueResponse,
): ReplaceOutcome {
  switch (answer.outcome) {
    case "accepted":
      return { kind: "accepted" };
    case "stale":
      return { kind: "note", text: SECRET_REPLACE_STALE, reread: true };
  }
}
