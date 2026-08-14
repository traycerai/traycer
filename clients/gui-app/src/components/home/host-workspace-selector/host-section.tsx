import { Check, Globe, Monitor, Server, type LucideIcon } from "lucide-react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostUnavailability,
  type HostUnavailability,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { cn } from "@/lib/utils";
import { DropdownMenuLabel } from "@/components/ui/dropdown-menu";

const HOST_KIND_ICONS: Record<HostDirectoryEntry["kind"], LucideIcon> = {
  remote: Globe,
  mock: Server,
  local: Monitor,
};

interface HostSectionProps {
  readonly entries: ReadonlyArray<HostDirectoryEntry>;
  readonly activeHostId: string | null;
  readonly onSelect: (hostId: string) => void;
  /**
   * A pending submission owns the host selection. The rows must go inert, not
   * just have their handler no-op: an interactive row that silently discards
   * the click reads as a broken control rather than a busy one.
   */
  readonly disabled: boolean;
}

/**
 * Host list for the worktree picker popovers (git-diff panel, terminal
 * creation, file tree). Clicking a row swaps the app-wide active host via
 * the directory binding; the host-scoped folder queries underneath refetch
 * automatically.
 */
export function HostSection(props: HostSectionProps) {
  return (
    <section
      aria-label="Host"
      data-testid="host-workspace-selector-host-section"
      className="w-full max-w-full min-w-0"
    >
      <DropdownMenuLabel className="px-1 text-ui-xs font-medium uppercase tracking-wide text-muted-foreground/70">
        Host
      </DropdownMenuLabel>
      <ul className="flex min-w-0 flex-col gap-0.5">
        {props.entries.length === 0 ? (
          <li className="rounded-md px-1.5 py-1 text-ui-sm text-muted-foreground">
            No hosts available.
          </li>
        ) : (
          props.entries.map((entry) => {
            const isActive = entry.hostId === props.activeHostId;
            return (
              <li key={entry.hostId} className="min-w-0">
                <button
                  type="button"
                  disabled={props.disabled}
                  data-testid={`host-workspace-selector-host-row-${entry.hostId}`}
                  data-selected={isActive ? "true" : "false"}
                  onClick={() => {
                    props.onSelect(entry.hostId);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-ui-sm transition-colors hover:bg-accent/50 hover:text-foreground",
                    isActive ? "text-foreground" : "text-muted-foreground",
                    "disabled:pointer-events-none disabled:opacity-60",
                  )}
                >
                  <HostKindIcon kind={entry.kind} />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {entry.label}
                  </span>
                  <HostStatusDot unavailability={hostUnavailability(entry)} />
                  {isActive ? (
                    <Check className="size-3.5 text-foreground" />
                  ) : null}
                </button>
              </li>
            );
          })
        )}
      </ul>
    </section>
  );
}

function HostKindIcon(props: { readonly kind: HostDirectoryEntry["kind"] }) {
  const Icon = HOST_KIND_ICONS[props.kind];
  return <Icon className="size-4 shrink-0 text-muted-foreground" />;
}

/**
 * DERIVATION, not a coarse read: this dot and its `aria-label` are the only
 * thing a person is told about the machine before they pick it, and three
 * unrelated situations used to collapse into one grey "Unavailable" — a host
 * that is genuinely off, a host the account's plan cannot reach remotely, and a
 * host the cloud simply failed to read. Calling the last two "Unavailable" sent
 * someone to restart a machine that was working, and hid the upgrade that was
 * the actual remedy.
 *
 * `indeterminate` renders as its own muted state rather than as unavailable —
 * the picker deliberately keeps such rows selectable (the transport dials on
 * it), so the dot must not contradict the row it sits on.
 *
 * A `busy` local host reaches this as `dialable` and keeps the reachable dot:
 * the shell proved the process is alive and only one probe went unanswered, so
 * greying it would be the picker telling someone their working machine is gone.
 * Distinguishing busy from available VISUALLY is the copy follow-up's job
 * (int #47), not this dot's.
 */
function HostStatusDot(props: {
  readonly unavailability: HostUnavailability | null;
}) {
  const presentation = HOST_STATUS_DOT[props.unavailability ?? "dialable"];
  return (
    <span
      aria-label={presentation.label}
      className={cn("size-1.5 rounded-full", presentation.className)}
    />
  );
}

const HOST_STATUS_DOT: Record<
  HostUnavailability | "dialable",
  { readonly label: string; readonly className: string }
> = {
  dialable: { label: "Available", className: "bg-emerald-500" },
  offline: { label: "Offline", className: "bg-muted-foreground/40" },
  "plan-restricted": {
    label: "Local only",
    className: "bg-muted-foreground/40",
  },
  indeterminate: {
    label: "Status unknown",
    className: "bg-muted-foreground/40",
  },
};
