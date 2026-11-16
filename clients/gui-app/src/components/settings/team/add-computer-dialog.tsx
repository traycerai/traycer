import { TEAM_TRANSFER_DISCLOSURE } from "@traycer/protocol/host/environment/team-transfer-disclosure";
import { CLI_NPM_PACKAGE_NAME } from "@traycer-clients/shared/cli-install/package-manager-upgrade-command";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";

/** Board C12's Proposal, character for character; the owner has not ruled it. */
const RUN_ON_THE_COMPUTER =
  "Run this on the computer. If nobody is signed in to Traycer there, it asks you to sign in.";

export function AddComputerDialog(props: {
  readonly teamName: string;
  readonly teamSelector: string;
  readonly unattended: ReactNode;
  readonly testId: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const selector = /^[A-Za-z0-9_/-]+$/.test(props.teamSelector)
    ? props.teamSelector
    : `'${props.teamSelector.replaceAll("'", "'\\''")}'`;
  const windowsSelector = /^[A-Za-z0-9_/-]+$/.test(props.teamSelector)
    ? props.teamSelector
    : `'${props.teamSelector.replaceAll("'", "''")}'`;
  const command = `traycer host install --team ${selector}`;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid={`${props.testId}-action`}
        >
          Add a computer
        </Button>
      </DialogTrigger>
      <DialogContent className="w-full sm:max-w-prose">
        <DialogHeader>
          <DialogTitle>Add a computer to {props.teamName}</DialogTitle>
          <DialogDescription>
            The team will own this computer.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-2 pl-5 text-ui-sm">
          {TEAM_TRANSFER_DISCLOSURE.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="flex min-w-0 flex-col items-start gap-3">
          <p className="text-ui-xs text-muted-foreground">
            Install the Traycer CLI first if needed:{" "}
            <code className="break-all">
              npm install -g {CLI_NPM_PACKAGE_NAME}
            </code>
            .
          </p>
          <p className="text-ui-sm text-muted-foreground">
            {RUN_ON_THE_COMPUTER}
          </p>
          <InstallCommand
            command={command}
            label={
              selector === windowsSelector ? null : "macOS and Linux command"
            }
            testId={props.testId}
          />
          {selector === windowsSelector ? null : (
            <InstallCommand
              command={`traycer host install --team ${windowsSelector}`}
              label="Windows (PowerShell) command"
              testId={`${props.testId}-windows`}
            />
          )}
          <p className="text-ui-xs text-muted-foreground">
            Already installed? Run{" "}
            <code className="break-all">traycer host use {selector}</code>{" "}
            {selector === windowsSelector ? "on it." : "on macOS and Linux."}
            {selector === windowsSelector ? null : (
              <>
                {" "}
                In Windows (PowerShell), run{" "}
                <code className="break-all">
                  traycer host use {windowsSelector}
                </code>
                .
              </>
            )}
          </p>
          {props.unattended}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InstallCommand(props: {
  readonly command: string;
  readonly label: string | null;
  readonly testId: string;
}): ReactNode {
  const copyLabel =
    props.label === null ? "Copy command" : `Copy ${props.label}`;
  const { copied, copy } = useClipboardCopy({
    resetMs: 2_000,
    onSuccess: null,
    onError: null,
  });
  return (
    <>
      {props.label === null ? null : (
        <p className="text-ui-xs font-medium">{props.label}</p>
      )}
      <pre
        className="w-full whitespace-pre-wrap break-all rounded-md border border-border/60 bg-foreground/3 p-3 font-mono text-ui-xs"
        data-testid={`${props.testId}-command`}
      >
        {props.command}
      </pre>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => copy(props.command)}
        data-testid={`${props.testId}-copy`}
      >
        {copied ? "Copied" : copyLabel}
      </Button>
    </>
  );
}
