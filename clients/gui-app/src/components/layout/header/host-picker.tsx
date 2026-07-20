import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useHostBinding } from "@/lib/host";
import {
  registerHostPickerDirectory,
  useHostPickerList,
} from "@/hooks/host/use-host-picker-list";
import { useRefreshHostDirectoryOnOpen } from "@/hooks/host/use-refresh-host-directory-on-open";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { useRunnerHost } from "@/providers/use-runner-host";

/**
 * Generic shell-agnostic host picker.
 *
 * Rendered as a dialog gated by `IRunnerHost.hostPicker.isOpen`. Shells
 * open the picker through `runnerHost.hostPicker.requestOpen()` (the
 * GUI's provisional "Switch host" action does the same). Selection
 * routes through `HostDirectoryService.selectById(...)`, which feeds
 * `HostRuntime.onSelectionChange(...)` and rebinds `HostClient`
 * (Decision 14 - host-scoped cache invalidation fires automatically).
 *
 * The component is always mounted inside `<TraycerApp />` and short-
 * circuits to `null` when the runtime binding is not yet ready (auth
 * still booting) so the shell affordance does not render pre-binding.
 */
export function HostPicker() {
  const runnerHost = useRunnerHost();
  const binding = useHostBinding();
  const [isOpen, setIsOpen] = useState<boolean>(runnerHost.hostPicker.isOpen);
  const directory = binding === null ? null : binding.directory;
  useRefreshHostDirectoryOnOpen(isOpen, directory);

  useEffect(() => {
    const subscription = runnerHost.hostPicker.onChange((next) => {
      setIsOpen(next);
    });
    return () => {
      subscription.dispose();
    };
  }, [runnerHost]);

  if (binding === null) {
    return null;
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (next) {
          runnerHost.hostPicker.requestOpen();
        } else {
          runnerHost.hostPicker.requestClose();
        }
      }}
    >
      <DialogContent data-testid="host-picker">
        <DialogHeader>
          <DialogTitle>Select host</DialogTitle>
          <DialogDescription>
            Pick the host this window should talk to. The selection updates the
            active connection immediately.
          </DialogDescription>
        </DialogHeader>
        <HostPickerList
          onSelect={(id) => {
            binding.directory.selectById(id);
            runnerHost.hostPicker.requestClose();
          }}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              runnerHost.hostPicker.requestClose();
            }}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface HostPickerListProps {
  readonly onSelect: (hostId: string) => void;
}

function HostPickerList(props: HostPickerListProps) {
  const binding = useHostBinding();
  const directory = binding === null ? null : binding.directory;
  const hostClient = binding === null ? null : binding.hostClient;
  const [revision, setRevision] = useState<number>(0);
  const directoryId =
    directory === null ? null : registerHostPickerDirectory(directory);

  useEffect(() => {
    if (directory === null) {
      return;
    }
    const subscription = directory.onChange(() => {
      setRevision((prev) => prev + 1);
    });
    return () => {
      subscription.dispose();
    };
  }, [directory]);

  useEffect(() => {
    if (hostClient === null) {
      return;
    }
    const unsubscribe = hostClient.onChange(() => {
      setRevision((prev) => prev + 1);
    });
    return () => {
      unsubscribe();
    };
  }, [hostClient]);

  const query = useHostPickerList(directoryId, revision);

  if (directory === null || query.isLoading) {
    return (
      <p
        className="flex items-center gap-2 text-ui-sm text-muted-foreground"
        data-testid="host-picker-loading"
      >
        <AgentSpinningDots
          testId={undefined}
          variant="orbit"
          className="text-muted-foreground"
        />
        Loading hosts…
      </p>
    );
  }

  if (query.isError) {
    return (
      <div
        className="flex items-center gap-2 text-ui-sm text-destructive"
        data-testid="host-picker-error"
      >
        <span>Failed to load hosts.</span>
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Failed to load hosts",
            message: null,
            code: null,
            source: "Host picker",
          })}
          presentation="icon"
          className="text-current"
        />
      </div>
    );
  }

  const entries = query.data === undefined ? [] : query.data;
  if (entries.length === 0) {
    return (
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="host-picker-empty"
      >
        No hosts available.
      </p>
    );
  }

  const activeId = hostClient === null ? null : hostClient.getActiveHostId();

  return (
    <div
      role="radiogroup"
      aria-label="Available hosts"
      className="flex flex-col gap-2"
    >
      {entries.map((entry) => {
        const selected = activeId === entry.hostId;
        return (
          <HostPickerOption
            key={entry.hostId}
            entry={entry}
            selected={selected}
            onSelect={props.onSelect}
          />
        );
      })}
    </div>
  );
}

interface HostPickerOptionProps {
  readonly entry: {
    readonly hostId: string;
    readonly label: string;
    readonly kind: string;
  };
  readonly selected: boolean;
  readonly onSelect: (hostId: string) => void;
}

function HostPickerOption(props: HostPickerOptionProps) {
  const { entry, selected } = props;
  return (
    <Button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid={`host-picker-option-${entry.hostId}`}
      data-selected={selected}
      variant={selected ? "secondary" : "outline"}
      onClick={() => {
        props.onSelect(entry.hostId);
      }}
      className="h-auto min-h-12 w-full justify-start gap-3 whitespace-normal px-4 py-3 text-left"
    >
      <span className="min-w-0 flex-1 truncate text-ui font-medium">
        {entry.label}
      </span>
      <HostKindBadge kind={entry.kind} />
    </Button>
  );
}

function HostKindBadge(props: { readonly kind: string }) {
  const label = hostKindLabel(props.kind);
  return (
    <Badge
      variant="outline"
      className="shrink-0 border-border/70 bg-background/60 text-muted-foreground"
    >
      {label}
    </Badge>
  );
}

function hostKindLabel(kind: string): string {
  if (kind === "local") {
    return "Local";
  }
  if (kind === "remote") {
    return "Remote";
  }
  return kind;
}
