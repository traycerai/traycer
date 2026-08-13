import { Check, Globe, Monitor, Server, type LucideIcon } from "lucide-react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { cn } from "@/lib/utils";
import { DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { isHostReachable } from "@traycer-clients/shared/host-client/host-directory";

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
                  <HostStatusDot status={entry.status} />
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

function HostStatusDot(props: {
  readonly status: HostDirectoryEntry["status"];
}) {
  return (
    <span
      // Reachability, not probe freshness. A `busy` host is one this picker can
      // still select and dial, so it keeps the reachable dot; giving it the
      // grey "Unavailable" affordance would be the picker telling the user
      // their working machine is gone. Distinguishing busy from available
      // visually is the copy follow-up's (int #47), not this dot's.
      aria-label={isHostReachable(props.status) ? "Available" : "Unavailable"}
      className={cn(
        "size-1.5 rounded-full",
        isHostReachable(props.status)
          ? "bg-emerald-500"
          : "bg-muted-foreground/40",
      )}
    />
  );
}
