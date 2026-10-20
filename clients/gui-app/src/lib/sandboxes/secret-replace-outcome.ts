import type { EnvironmentSecretsReplaceValueResponse } from "@traycer/protocol/host/environment-schemas";
import {
  SECRET_REPLACE_STALE,
  SECRET_SAVED_OFFLINE,
} from "@/lib/sandboxes/secrets-page-copy";

/** What a replacement's answer means for the dialog: close, or say why not. */
export type ReplaceOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "note"; readonly text: string; readonly reread: boolean };

export function replaceOutcome(
  answer: EnvironmentSecretsReplaceValueResponse,
): ReplaceOutcome {
  switch (answer.outcome) {
    case "accepted":
      return { kind: "accepted" };
    case "stale":
      return { kind: "note", text: SECRET_REPLACE_STALE, reread: true };
    case "pending":
      return { kind: "note", text: SECRET_SAVED_OFFLINE, reread: false };
  }
}
