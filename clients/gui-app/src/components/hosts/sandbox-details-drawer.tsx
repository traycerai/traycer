import type { ReactNode } from "react";
import { toast } from "sonner";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  sandboxConfigurationOf,
  useSandboxConfigurations,
  useSandboxWakeString,
} from "@/hooks/sandboxes/use-sandbox-configurations";
import { useSandboxCosts } from "@/hooks/sandboxes/use-sandbox-costs-query";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useSampledNow } from "@/lib/relative-time";
import { sandboxDetailsEntry } from "@/lib/sandboxes/sandbox-details-provider";
import { formatSandboxDate } from "@/lib/sandboxes/sandbox-row-lines";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  closeSandboxDetails,
  useSandboxDetailsStore,
} from "@/stores/sandboxes/sandbox-details-store";

/**
 * The Details drawer for one sandbox, opened by `openSandboxDetails` from a
 * Sandboxes row, a failed row, the hover card or a notification. Mounted once
 * at the app root. Cloud-backed: it reads the sandbox list and the cost
 * ledger, so it opens for a host that is offline, and reading it never wakes
 * or spends. It lists nothing it was not opened for.
 */
export function SandboxDetailsDrawerHost(): ReactNode {
  const sandboxId = useSandboxDetailsStore((s) => s.sandboxId);
  return (
    <Sheet
      open={sandboxId !== null}
      onOpenChange={(open) => {
        if (!open) closeSandboxDetails();
      }}
    >
      <SheetContent
        side="right"
        className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        data-testid="sandbox-details-drawer"
      >
        {sandboxId === null ? null : (
          <SandboxDetailsBody sandboxId={sandboxId} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function SandboxDetailsBody(props: { readonly sandboxId: string }): ReactNode {
  const list = useSandboxList();
  const summary =
    list.data?.sandboxes.find((row) => row.id === props.sandboxId) ?? null;
  if (summary === null) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>Details</SheetTitle>
          <SheetDescription>
            {list.data === undefined
              ? "Loading this sandbox's details…"
              : "This sandbox is no longer listed: it was destroyed."}
          </SheetDescription>
        </SheetHeader>
        <p className="px-4 text-ui-xs text-muted-foreground">
          {`Support reference ${props.sandboxId}`}
        </p>
      </>
    );
  }
  return <SandboxDetailsSections summary={summary} />;
}

function SandboxDetailsSections(props: {
  readonly summary: SandboxSummary;
}): ReactNode {
  const { summary } = props;
  const costs = useSandboxCosts();
  const wake = useSandboxWakeString(summary);
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const configurations = useSandboxConfigurations();
  const now = useSampledNow();
  const entry = sandboxDetailsEntry({
    summary,
    cost:
      costs.data?.sandboxes.find((cost) => cost.sandboxId === summary.id) ??
      null,
    wakeString: wake,
    viewerUserId,
    // Personal only once every team answered: a team row from a server
    // that names no creator is never the viewer's.
    personal:
      configurations.complete &&
      sandboxConfigurationOf(summary, configurations.configurations)?.kind ===
        "personal",
    now,
  });
  const clipboard = useClipboardCopy({
    resetMs: 2000,
    onSuccess: null,
    onError: () => toast.error("Couldn't copy the diagnostics."),
  });
  return (
    <>
      <SheetHeader>
        <SheetTitle className="wrap-anywhere">{summary.displayName}</SheetTitle>
        <SheetDescription>Details</SheetDescription>
      </SheetHeader>
      <section
        aria-label="Status"
        className="flex flex-col gap-2 px-4 pb-4"
        data-testid="sandbox-details-status"
      >
        <h3 className="text-ui-sm font-medium">Status</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-xs">
          {entry.status.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="wrap-anywhere">{row.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section
        aria-label="History"
        className="flex flex-col gap-2 border-t border-border/60 px-4 py-4"
        data-testid="sandbox-details-history"
      >
        <h3 className="text-ui-sm font-medium">History</h3>
        <ol className="flex list-none flex-col gap-1 p-0 text-ui-xs">
          {entry.history.map((event) => (
            <li
              key={`${event.at}:${event.label}:${event.value}`}
              className="wrap-anywhere"
            >
              {event.at === null ? (
                event.label
              ) : (
                <>
                  <span className="text-muted-foreground">
                    {formatSandboxDate(event.at, true)}
                  </span>
                  {` · ${event.label}`}
                </>
              )}
              {event.value.length === 0 ? null : ` ${event.value}`}
            </li>
          ))}
        </ol>
      </section>
      <section
        aria-label="Export diagnostics"
        className="flex flex-col items-start gap-2 border-t border-border/60 px-4 py-4"
      >
        <h3 className="text-ui-sm font-medium">Export diagnostics</h3>
        <p className="text-ui-xs text-muted-foreground">
          Status and History as data, with no values, sessions or paths.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="sandbox-details-export"
          onClick={() =>
            clipboard.copy(JSON.stringify(entry.export(), null, 2))
          }
        >
          {clipboard.copied ? "Copied" : "Copy diagnostics"}
        </Button>
      </section>
    </>
  );
}
