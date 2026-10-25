import type { ReactNode } from "react";
import { classifyCredential } from "@traycer/protocol/environment/credential-rule";
import type { PersonalRowNote } from "@/components/settings/personal/personal-page-context";
import { Button } from "@/components/ui/button";

/**
 * A row's note: "Pending", or "dev-box uses: error · Use everywhere"
 * where this host keeps its own value. A value that looks like a key is
 * never shown, and it has no Use everywhere: Personal refuses it as a
 * variable.
 */
export function PersonalRowNoteText(props: {
  readonly name: string;
  readonly note: PersonalRowNote;
  readonly disabled: boolean;
  readonly onUseEverywhere: (key: string, value: string) => void;
}): ReactNode {
  const { note } = props;
  if (note.kind === "pending") return "Pending";
  const keyShaped = classifyCredential({
    name: props.name,
    value: note.value,
  }).credentialLike;
  return (
    <span data-testid="env-row-own-value">
      {note.hostName} uses:{" "}
      <span className="font-mono">{keyShaped ? "••••••••" : note.value}</span>
      {keyShaped ? null : (
        <>
          {" · "}
          <Button
            type="button"
            variant="link"
            size="inline-xs"
            disabled={props.disabled}
            onClick={() => props.onUseEverywhere(props.name, note.value)}
          >
            Use everywhere
          </Button>
        </>
      )}
    </span>
  );
}
