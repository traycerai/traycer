import type { ReactNode } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { formatInstallDate } from "@/components/settings/panels/host-settings-panel-model";
import { cn } from "@/lib/utils";

/**
 * One installable host version, reduced to what a row shows.
 *
 * The two surfaces that list versions read from genuinely different places —
 * the recovery console asks the LOCAL CLI bridge (`host available --json` on
 * this box, via `IHostManagement`), and the Overview asks the SCOPED HOST over
 * `host.update.check`, which is the only way to answer the question for a
 * machine in a datacenter. Their payloads differ in shape and in what they can
 * know: the bridge snapshot carries a `platformKey` and the manifest URL it
 * read, the RPC manifest carries neither, because the host's CLI already
 * projected the entry to its own platform before emitting it.
 *
 * What a person reads off a row is identical either way, so this is the shared
 * half: each caller projects its own payload to these fields, and neither has
 * to pretend to be the other to reuse the markup. An earlier pass tried the
 * other direction — synthesising a bridge-shaped snapshot from the RPC manifest
 * — which meant inventing a `platformKey` and a `manifestUrl` the host never
 * sent, on a page whose whole premise is that it does not make facts up.
 */
export interface HostVersionRow {
  readonly version: string;
  readonly releasedAt: string;
  readonly yanked: boolean;
  readonly isLatest: boolean;
  readonly isInstalled: boolean;
  /**
   * Why this version cannot be installed HERE, or `null` when it can. Carries
   * the reason rather than a boolean so the disabled button can say what a
   * person would otherwise have to guess: no asset for this platform, an
   * unavailable one, or a publisher's own note.
   */
  readonly unavailableReason: string | null;
}

/**
 * The version list itself: rows, per-row Install, and the preview/full toggle.
 *
 * Deliberately presentational. Which versions exist, which one is installed and
 * what "install" means are all the caller's business — this decides only how a
 * row looks and when its button is dead.
 */
export function HostVersionRows(props: {
  readonly rows: readonly HostVersionRow[];
  /** Rows beyond the preview slice, so the toggle can say whether it is worth it. */
  readonly totalCount: number;
  readonly showAll: boolean;
  readonly onToggleShowAll: () => void;
  /** The version whose install is in flight, or `null`. */
  readonly installingVersion: string | null;
  /** Something else holds the surface (another mutation, a degraded host). */
  readonly disabled: boolean;
  readonly onInstall: (version: string) => void;
}): ReactNode {
  const { rows } = props;
  if (rows.length === 0) {
    return (
      <div className="text-ui-sm text-muted-foreground">
        No versions available.
      </div>
    );
  }
  return (
    <>
      <ul
        className="flex flex-col divide-y divide-border/40 overflow-hidden rounded-md border border-border/40"
        data-testid="host-version-rows"
      >
        {rows.map((row) => (
          <VersionRow
            key={row.version}
            row={row}
            installing={props.installingVersion === row.version}
            // Any install in flight freezes every row, not just its own. These
            // all drive one detached swap on one host, and a second request
            // mid-swap retargets an update already running.
            disabled={props.disabled || props.installingVersion !== null}
            onInstall={props.onInstall}
          />
        ))}
      </ul>
      {props.totalCount > rows.length || props.showAll ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onToggleShowAll}
            data-testid="host-version-rows-toggle"
          >
            {props.showAll ? "Show recent" : "Show all"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function VersionRow(props: {
  readonly row: HostVersionRow;
  readonly installing: boolean;
  readonly disabled: boolean;
  readonly onInstall: (version: string) => void;
}): ReactNode {
  const { row } = props;
  const blocked =
    row.isInstalled || row.yanked || row.unavailableReason !== null;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-ui-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-code-xs">v{row.version}</span>
        {row.isLatest ? (
          <VersionPill className="bg-emerald-900/40 text-emerald-300">
            latest
          </VersionPill>
        ) : null}
        {row.isInstalled ? (
          <VersionPill className="bg-sky-900/40 text-sky-300">
            installed
          </VersionPill>
        ) : null}
        {row.yanked ? (
          <VersionPill className="bg-rose-900/40 text-rose-300">
            yanked
          </VersionPill>
        ) : null}
        <span className="text-ui-xs text-muted-foreground">
          {formatInstallDate(row.releasedAt)}
        </span>
        {row.unavailableReason === null ? null : (
          <span className="text-ui-xs text-muted-foreground">
            {row.unavailableReason}
          </span>
        )}
      </div>
      <TooltipWrapper
        label={row.unavailableReason ?? undefined}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span className="inline-flex">
          <Button
            variant="secondary"
            size="sm"
            disabled={props.disabled || blocked}
            // The version lives in a SIBLING element, so every row's button
            // otherwise reads as the same bare "Install" to a screen reader.
            aria-label={`Install ${row.version}`}
            onClick={() => props.onInstall(row.version)}
          >
            {props.installing ? (
              <AgentSpinningDots
                className="mr-2 size-3"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Install
          </Button>
        </span>
      </TooltipWrapper>
    </li>
  );
}

function VersionPill(props: {
  readonly className: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <span className={cn("rounded px-2 py-0.5 text-ui-xs", props.className)}>
      {props.children}
    </span>
  );
}
