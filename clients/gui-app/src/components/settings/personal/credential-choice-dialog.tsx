import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { navigateToSettingsSection } from "@/lib/settings-navigation";

/**
 * The question a variable save asks before a value that looks like a
 * credential is stored (flow 2; the rule is `@traycer/protocol`'s
 * `classifyCredential`, the one the host's migration and the dashboard ask
 * too). Nothing is stored until the person answers: "Keep as a variable"
 * stores it as typed, "Make it a secret" stores nothing and opens Secrets.
 */
export function CredentialChoiceDialog(props: {
  /** The variable's name, or `null` when no question is open. */
  readonly name: string | null;
  readonly onKeepAsVariable: () => void;
  readonly onDismiss: () => void;
}): ReactNode {
  return (
    <Dialog
      open={props.name !== null}
      onOpenChange={(open) => {
        if (!open) props.onDismiss();
      }}
    >
      <DialogContent data-testid="credential-choice-dialog">
        <DialogHeader>
          <DialogTitle>This looks like a secret</DialogTitle>
          <DialogDescription>
            {props.name ?? ""} looks like a key, token or password. As a
            variable, every host you use gets it as a plain value. As a secret,
            agents can use it without reading it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={props.onKeepAsVariable}
          >
            Keep as a variable
          </Button>
          <Button
            type="button"
            onClick={() => {
              navigateToSettingsSection("secrets");
              props.onDismiss();
            }}
          >
            Make it a secret
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
