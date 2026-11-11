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

export function AddComputerDialog(props: {
  readonly teamName: string;
  readonly teamSelector: string;
  readonly unattended: ReactNode;
  readonly testId: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const { copied, copy } = useClipboardCopy({
    resetMs: 2_000,
    onSuccess: null,
    onError: null,
  });
  const selector = /^[A-Za-z0-9_/-]+$/.test(props.teamSelector)
    ? props.teamSelector
    : `'${props.teamSelector.replaceAll("'", "'\\''")}'`;
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
            The team can run agents and read or change files on this computer.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col items-start gap-3">
          <p className="text-ui-sm text-muted-foreground">
            Run this on the computer, then sign in as a team member.
          </p>
          <pre
            className="w-full whitespace-pre-wrap break-all rounded-md border border-border/60 bg-foreground/3 p-3 font-mono text-ui-xs"
            data-testid={`${props.testId}-command`}
          >
            {command}
          </pre>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => copy(command)}
            data-testid={`${props.testId}-copy`}
          >
            {copied ? "Copied" : "Copy command"}
          </Button>
          <p className="text-ui-xs text-muted-foreground">
            Already installed? Run{" "}
            <code className="break-all">traycer host use {selector}</code> on
            it.
          </p>
          {props.unattended}
        </div>
      </DialogContent>
    </Dialog>
  );
}
