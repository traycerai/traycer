import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useHostBinding } from "@/lib/host";
import { HostOptionList } from "@/components/settings/host-scope/host-option-list";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { resolveManageSubscriptionUrl } from "@/lib/auth/manage-subscription-url";
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

/**
 * The dialog's body: the same merged host list every other picker reads, drawn
 * with the same rows, at the density a modal wants.
 *
 * It used to run its own directory query and its own invalidation effects, and
 * draw its own row — a third icon set, a third word for "offline", and a
 * `Paid plan` badge nothing else in the app used. All three now come from the
 * shared list, so this component is down to what is genuinely the dialog's:
 * which states it shows while the list is still arriving.
 */
function HostPickerList(props: HostPickerListProps): ReactNode {
  const options = useHostOptions();

  if (options.isLoading) {
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

  // A FAILED list is not an empty account — the rule this app has now fixed at
  // the gate, in the switcher's empty state and in its footer. This is its
  // fourth consumer, and it splits the same two ways: nothing came back at all,
  // or one source answered and the picture is partial.
  if (options.listsFailed && options.hosts.length === 0) {
    return (
      <div
        className="flex items-center gap-2 text-ui-sm text-destructive"
        data-testid="host-picker-error"
      >
        <span>Failed to load hosts.</span>
        <button
          type="button"
          onClick={options.retryLists}
          className="rounded-md px-1 py-0.5 text-ui-sm text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          data-testid="host-picker-retry"
        >
          Try again
        </button>
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

  if (options.hosts.length === 0) {
    return (
      <p
        className="text-ui-sm text-muted-foreground"
        data-testid="host-picker-empty"
      >
        No hosts available.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {options.hosts.some((host) => host.planRestricted) ? (
        <RemoteHostsUpsellNotice />
      ) : null}
      <HostOptionList
        hosts={options.hosts}
        // This dialog binds the window to a host, so the row it checks is the
        // active one and a host it cannot dial is not a legal answer.
        pickedHostId={options.activeHostId}
        activeHostId={options.activeHostId}
        intent="bind"
        onSelect={props.onSelect}
        disabled={false}
        density="roomy"
        label="Available hosts"
        testIdPrefix="host-picker-option"
        emptyLabel="No hosts available."
      />
      {options.listsFailed ? (
        <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2">
          <span className="text-ui-xs text-muted-foreground">
            Some hosts may be missing
          </span>
          <button
            type="button"
            onClick={options.retryLists}
            className="shrink-0 rounded-md px-1 py-0.5 text-ui-xs text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            data-testid="host-picker-retry"
          >
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shown when the list contains remote hosts the current (free) plan cannot
 * connect to. Presentation-side twin of CS's `plan_restricted` attach-grant
 * denial — the server enforces the gate regardless of this notice.
 */
function RemoteHostsUpsellNotice() {
  const runnerHost = useRunnerHost();
  return (
    <p
      className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-ui-sm text-muted-foreground"
      data-testid="host-picker-remote-upsell"
    >
      Remote hosts require a paid plan.{" "}
      <button
        type="button"
        className="text-primary hover:underline"
        data-testid="host-picker-remote-upsell-upgrade"
        onClick={() => {
          void runnerHost.openExternalLink(
            resolveManageSubscriptionUrl(runnerHost.authnBaseUrl),
          );
        }}
      >
        Upgrade
      </button>{" "}
      to connect to your other machines from here.
    </p>
  );
}
