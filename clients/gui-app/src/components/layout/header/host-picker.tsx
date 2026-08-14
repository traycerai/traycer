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
import {
  useHostOptions,
  type HostOptions,
} from "@/components/settings/host-scope/use-host-options";
import { resolveManageSubscriptionUrl } from "@/lib/auth/manage-subscription-url";
import { useRegisteredHostsPollLiveness } from "@/hooks/auth/use-registered-hosts-query";
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
  // The merged rows carry registry-derived health, and that observer is
  // deliberately NON-polling - a surface showing the dots opts the window into
  // the liveness poll for as long as it is on screen (the Settings sidebar's
  // rule, and the usage picker's). Without it, a dialog left open keeps an
  // Online dot from the last DTO after a shutdown or lease expiry.
  useRegisteredHostsPollLiveness();

  // Readiness is the DIRECTORY's, not the merged list's. This dialog exists to
  // point the window at a host, so the only rows it can act on are dialable
  // ones — and those all come from the directory. Waiting on the account
  // registry (a cloud call that can be slow, refused, or signed out) left it
  // spinning over a resolved directory: "Loading hosts…" above a machine that
  // was right there, precisely when the network is unhappy and someone is
  // trying to switch hosts because of it.
  if (options.hosts.length === 0 && !options.directoryResolved) {
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

  // Nothing to list AND the directory itself failed: "you have no hosts" would
  // be a claim we cannot make — the same "a FAILED list is not an empty
  // account" rule the switcher enforces, at its fourth consumer.
  if (options.hosts.length === 0 && options.directoryFailed) {
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
      <div className="flex flex-col gap-2">
        <p
          className="text-ui-sm text-muted-foreground"
          data-testid="host-picker-empty"
        >
          No hosts available.
        </p>
        {options.listsFailed ? (
          <HostPickerPartialFailure options={options} />
        ) : null}
      </div>
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
        <HostPickerPartialFailure options={options} />
      ) : null}
    </div>
  );
}

/**
 * One source answered and the other did not, so the rows above (or their
 * absence) are a partial picture. Said out loud rather than left to look
 * complete — the same footer the switcher grew for the same reason.
 */
function HostPickerPartialFailure(props: {
  readonly options: HostOptions;
}): ReactNode {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2">
      <span className="text-ui-xs text-muted-foreground">
        Some hosts may be missing
      </span>
      <button
        type="button"
        onClick={props.options.retryLists}
        className="shrink-0 rounded-md px-1 py-0.5 text-ui-xs text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        data-testid="host-picker-retry"
      >
        Try again
      </button>
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
