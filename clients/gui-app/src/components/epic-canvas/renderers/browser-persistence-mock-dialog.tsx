import { memo } from "react";
import { KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * An in-app REPLICA of the macOS keychain ACL dialog (spec §7.2). It exists so
 * the real dialog is never the first time the user sees this sentence - which
 * is the whole point of the explainer: the wording, the three buttons and the
 * highlighted default all match what the OS is about to show.
 *
 * Deliberately inert: `aria-hidden` with a text alternative on the wrapper, so
 * a screen reader hears the sentence once rather than reading three buttons
 * that do nothing.
 */

function browserKeychainDialogText(appName: string): string {
  return `"${appName}" wants to access key "${appName} Safe Storage" in your keychain.`;
}

const MOCK_DIALOG_BUTTONS: readonly {
  readonly label: string;
  readonly primary: boolean;
}[] = [
  { label: "Always Allow", primary: true },
  { label: "Deny", primary: false },
  { label: "Allow", primary: false },
];

export const BrowserPersistenceMockDialog = memo(
  function BrowserPersistenceMockDialog(props: { readonly appName: string }) {
    const dialogText = browserKeychainDialogText(props.appName);
    return (
      <figure
        className="m-0 w-full min-w-0"
        aria-label={`Preview of the system dialog: ${dialogText}`}
      >
        <div
          aria-hidden
          className="flex w-full min-w-0 flex-col gap-2.5 rounded-lg border border-border bg-background/80 p-3 shadow-sm"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground/8 text-muted-foreground">
              <KeyRound className="size-4" />
            </span>
            <p className="min-w-0 flex-1 text-pretty text-ui-xs leading-snug text-foreground">
              {dialogText}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {MOCK_DIALOG_BUTTONS.map((button) => (
              <span
                key={button.label}
                className={cn(
                  "rounded-md px-2 py-1 text-ui-xs",
                  button.primary
                    ? "bg-primary font-medium text-primary-foreground ring-2 ring-primary/40"
                    : "border border-border bg-foreground/6 text-muted-foreground",
                )}
              >
                {button.label}
              </span>
            ))}
          </div>
        </div>
        <figcaption className="mt-1.5 text-ui-xs text-muted-foreground">
          Choose <span className="italic">Always Allow</span> so it never asks
          again. On staging builds it may ask again after reinstalling.
        </figcaption>
      </figure>
    );
  },
);
