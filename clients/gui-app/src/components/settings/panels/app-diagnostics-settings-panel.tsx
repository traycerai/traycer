import { useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { SettingsGroup } from "@/components/settings/settings-group";
import { LogDetailGroup } from "@/components/settings/panels/diagnostics-log-detail-group";
import {
  BridgeLogEntry,
  LogInfoLine,
  RecentLogsFrame,
} from "@/components/settings/panels/diagnostics-log-entries";
import { useSupportSnapshotQuery } from "@/components/settings/panels/diagnostics-log-tail";
import {
  useDesktopLogLevelControl,
  type LogLevelControl,
} from "@/components/settings/panels/log-level-controls";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { CopyTextButton } from "@/components/copy-text-button";
import {
  describeDesktopJsHeapIsolate,
  getDesktopHeapSnapshotBridge,
  getDesktopJsHeapBridge,
  type DesktopJsHeapBreakdown,
  type DesktopJsHeapIsolate,
} from "@/lib/resources/desktop-app-resource-usage";
import { formatMemoryBytes } from "@/lib/resources/format-resource-usage";
import { getLogLevelsBridge } from "@/lib/desktop-log-levels";
import { runnerMutationKeys } from "@/lib/query-keys/runner-mutation-keys";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { resolveDesktopSupportBridge } from "@/lib/windows/desktop-capabilities";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { cn } from "@/lib/utils";
import type { DesktopSupportBridge } from "@/lib/windows/types";

const PANEL_DESCRIPTION =
  "Logging and memory capture for the Traycer app itself - this window, whichever host it points at. The level defaults to Info; raise it to Debug when capturing a problem for support, then set it back.";

/**
 * Diagnostics for the APP, in the one place there is only ever one of it.
 *
 * Everything here describes this desktop window: its own log verbosity, its own
 * log file, its own heap. None of it varies with the sidebar's host picker, and
 * that is the whole reason this page exists. All three used to render on the
 * host-scoped Diagnostics page, which meant a person with four hosts saw four
 * copies of one App log level select, four Capture heap snapshot buttons and
 * four Desktop Log entries — each pair of them writing the same single value,
 * and none of them belonging to the host named at the top of the screen.
 *
 * The rule the sidebar encodes is "if it varies by host it sits under the
 * picker" (see `settings-sections.ts`). These three never did.
 *
 * No `HostScopeGate` and no `useHostScope`: there is nothing here a host could
 * be too old for, unreachable for, or answer differently about. The page's only
 * capability question is whether it is running inside the desktop shell at all,
 * asked twice — once per bridge — so a shell missing one still gets the other.
 */
export function AppDiagnosticsSettingsPanel(): ReactNode {
  const compact = useSettingsDensity() === "compact";
  const desktopControl = useDesktopLogLevelControl();
  const runnerHost = useRunnerHost();
  const support = useMemo(
    () => resolveDesktopSupportBridge(runnerHost),
    [runnerHost],
  );
  // Same rule the host rows follow: no source, no row. A shell without the
  // log-levels bridge would otherwise get a select that can never load.
  const levelsAvailable = getLogLevelsBridge() !== null;
  const controls = useMemo(
    (): readonly LogLevelControl[] => (levelsAvailable ? [desktopControl] : []),
    [levelsAvailable, desktopControl],
  );

  return (
    <SettingsPanelShell
      title="Diagnostics"
      description={PANEL_DESCRIPTION}
      fillHeight
      bodyClassName="overflow-visible rounded-none border-none bg-transparent"
    >
      <div
        className={cn(
          "flex h-full min-h-0 flex-col",
          compact ? "gap-2.5" : "gap-3",
        )}
      >
        <LogDetailGroup
          controls={controls}
          emptyState={
            <LogInfoLine>
              Log level controls are only available on the desktop app.
            </LogInfoLine>
          }
        />
        <MemoryDiagnosticsGroup />
        <RecentLogsFrame>
          {support === null ? (
            <LogInfoLine>
              Recent logs are only available on the desktop app.
            </LogInfoLine>
          ) : (
            <DesktopAppLogEntry support={support} />
          )}
        </RecentLogsFrame>
      </div>
    </SettingsPanelShell>
  );
}

/**
 * This app's own log file, from the local support bridge.
 *
 * Reveal rather than Copy path, unlike every host-owned entry:
 * `shell.showItemInFolder` opens a path on THIS machine, which is exactly what
 * this file is.
 */
function DesktopAppLogEntry(props: {
  readonly support: DesktopSupportBridge;
}): ReactNode {
  const listQuery = useSupportSnapshotQuery(props.support);
  const entry =
    listQuery.data?.logs.find((log) => log.target === "desktop") ?? null;
  if (listQuery.isPending) return <LogInfoLine>Loading logs…</LogInfoLine>;
  if (listQuery.isError) {
    return <LogInfoLine>Couldn&apos;t load log details.</LogInfoLine>;
  }
  // The snapshot answered without the entry it has always carried. Stated
  // rather than rendered as an empty card, which reads as "still loading"
  // forever.
  if (entry === null) return <LogInfoLine>No app log file found.</LogInfoLine>;
  return <BridgeLogEntry entry={entry} support={props.support} />;
}

/**
 * One serialization scope for BOTH memory diagnostics - see the `scope` note
 * below for why `scope` and not `mutationKey`.
 *
 * They share it because they contend for the same renderer isolate, not merely
 * for the same button. A heap capture freezes that isolate for as long as the
 * walk takes (tens of seconds on the long-lived sessions worth capturing),
 * which is longer than `JS_HEAP_MEASURE_TIMEOUT_MS`; a measurement started
 * underneath one would have its protocol reads stall behind the freeze and
 * report a measurement failure for a window that is perfectly measurable a
 * moment later. Queuing the second action is the honest answer.
 */
const MEMORY_DIAGNOSTICS_MUTATION_SCOPE = "runner-memory-diagnostics";

/**
 * On-demand heap capture for memory reports. The renderer freezes while V8
 * walks the heap and the file runs to gigabytes on exactly the long-lived
 * sessions worth capturing, so this is a deliberate button rather than
 * anything automatic - and the warning is stated up front, not after the fact.
 * The resulting path is shown for copying rather than revealed in the file
 * manager: no reveal capability is exposed for arbitrary paths.
 */
function MemoryDiagnosticsGroup(): ReactNode {
  const bridge = useMemo(() => getDesktopHeapSnapshotBridge(), []);
  // The two capabilities are gated independently, like every other pair of
  // desktop bridges on this page: a shell that carries one and not the other
  // still gets the one it has.
  const jsHeapAvailable = useMemo(() => getDesktopJsHeapBridge() !== null, []);
  const [snapshotPath, setSnapshotPath] = useState<string | null>(null);

  const captureMutation = useMutation({
    mutationKey: runnerMutationKeys.captureHeapSnapshot(),
    // `scope` is what actually serializes mutations in TanStack Query -
    // `mutationKey` alone does not. Without it the only thing standing
    // between a double-click and two concurrent multi-gigabyte heap walks
    // is the `disabled` prop, which cannot help a second mounted panel.
    scope: { id: MEMORY_DIAGNOSTICS_MUTATION_SCOPE },
    mutationFn: (): Promise<string | null> =>
      bridge === null ? Promise.resolve(null) : bridge.takeHeapSnapshot(),
    onSuccess: (path) => {
      setSnapshotPath(path);
      if (path === null) {
        toast.error("Couldn't capture a heap snapshot");
      }
    },
    onError: (error) => {
      // Clear the previous run's path. Leaving it rendered under a failure
      // toast offers a Copy button for a file this capture never wrote -
      // the user pastes it into a report as the snapshot they just took.
      setSnapshotPath(null);
      toastFromRunnerError(error, "Couldn't capture a heap snapshot");
    },
  });

  if (bridge === null && !jsHeapAvailable) {
    return (
      <SettingsGroup
        title="Memory"
        tone="default"
        dataTestId={undefined}
        fill={false}
      >
        <LogInfoLine>
          Memory snapshots are only available on the desktop app.
        </LogInfoLine>
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      title="Memory"
      tone="default"
      dataTestId={undefined}
      fill={false}
    >
      {bridge === null ? null : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
            <span className="min-w-0 flex-1 text-ui-xs text-muted-foreground">
              Captures a heap snapshot of this window for a memory report. The
              app stops responding while the snapshot is written, and the file
              can be several gigabytes.
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={captureMutation.isPending}
              onClick={() => captureMutation.mutate()}
              data-testid="diagnostics-capture-heap-snapshot"
            >
              {captureMutation.isPending ? (
                <AgentSpinningDots
                  className="text-current"
                  testId={undefined}
                  variant={undefined}
                />
              ) : null}
              Capture heap snapshot
            </Button>
          </div>
          {snapshotPath === null ? null : (
            <div className="flex items-start gap-2 px-4 pb-3">
              <pre
                className="min-w-0 flex-1 overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-code-xs text-muted-foreground"
                data-testid="diagnostics-heap-snapshot-path"
              >
                {snapshotPath}
              </pre>
              <CopyTextButton
                value={snapshotPath}
                label="Copy"
                ariaLabel="Copy heap snapshot path"
                disabled={false}
              />
            </div>
          )}
        </>
      )}
      <JsHeapReadout />
    </SettingsGroup>
  );
}

interface JsHeapTotals {
  readonly usedBytes: number;
  readonly totalBytes: number;
  readonly embedderBytes: number | null;
  readonly backingStorageBytes: number | null;
}

/**
 * Column totals. The two out-of-heap columns stay `null` until some isolate
 * reports one, so a build whose protocol omits those experimental fields shows
 * an empty column rather than a confident zero.
 */
function sumJsHeapIsolates(
  isolates: ReadonlyArray<DesktopJsHeapIsolate>,
): JsHeapTotals {
  let usedBytes = 0;
  let totalBytes = 0;
  let embedderBytes: number | null = null;
  let backingStorageBytes: number | null = null;
  for (const isolate of isolates) {
    usedBytes += isolate.usedBytes;
    totalBytes += isolate.totalBytes;
    if (isolate.embedderBytes !== null) {
      embedderBytes = (embedderBytes ?? 0) + isolate.embedderBytes;
    }
    if (isolate.backingStorageBytes !== null) {
      backingStorageBytes =
        (backingStorageBytes ?? 0) + isolate.backingStorageBytes;
    }
  }
  return { usedBytes, totalBytes, embedderBytes, backingStorageBytes };
}

function formatOptionalMemoryBytes(value: number | null): string {
  return value === null ? "—" : formatMemoryBytes(value);
}

/**
 * The per-isolate companion to the heap snapshot. A snapshot walks the page's
 * own V8 isolate and nothing else; the renderer also runs one isolate per
 * dedicated worker (an epic runtime per live epic session, the diff
 * highlighter pool), and a window whose snapshot explains a fraction of its
 * footprint is usually carrying the rest there. This readout is cheap - a few
 * protocol round trips, no freeze - and lists every isolate with what it holds,
 * so the snapshot can be read against the number it was missing.
 */
function JsHeapReadout(): ReactNode {
  const bridge = useMemo(() => getDesktopJsHeapBridge(), []);
  const [breakdown, setBreakdown] = useState<DesktopJsHeapBreakdown | null>(
    null,
  );

  const measureMutation = useMutation({
    mutationKey: runnerMutationKeys.measureJsHeaps(),
    // Serialized for the same reason the heap capture is: the measurement
    // attaches `webContents.debugger`, and a second call while the first holds
    // the attachment is refused in main (`isAttached()`), which would read as
    // a failure toast and clear a readout that was fine.
    scope: { id: MEMORY_DIAGNOSTICS_MUTATION_SCOPE },
    mutationFn: (): Promise<DesktopJsHeapBreakdown | null> =>
      bridge === null ? Promise.resolve(null) : bridge.measureJsHeaps(),
    onSuccess: (result) => {
      setBreakdown(result);
      if (result === null) {
        toast.error("Couldn't measure this window's JS heaps");
      }
    },
    onError: (error) => {
      setBreakdown(null);
      toastFromRunnerError(error, "Couldn't measure this window's JS heaps");
    },
  });

  if (bridge === null) return null;

  const totals = sumJsHeapIsolates(breakdown?.isolates ?? []);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-4 py-2.5">
        <span className="min-w-0 flex-1 text-ui-xs text-muted-foreground">
          Lists every JS heap in this window: the page and each worker it runs.
          A heap snapshot covers the page only, so this is what accounts for the
          rest. Embedder and backing sit outside the JS heap — Blink&apos;s own
          objects, and ArrayBuffer/WebAssembly stores such as a highlighter
          worker&apos;s regex engine.
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={measureMutation.isPending}
          onClick={() => measureMutation.mutate()}
          data-testid="diagnostics-measure-js-heaps"
        >
          {measureMutation.isPending ? (
            <AgentSpinningDots
              className="text-current"
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Measure JS heaps
        </Button>
      </div>
      {breakdown === null ? null : (
        <div className="px-4 pb-3" data-testid="diagnostics-js-heap-breakdown">
          <table className="w-full border-collapse text-ui-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-normal">
                  Isolate
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">
                  Live
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">
                  Committed
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-normal">
                  Embedder
                </th>
                <th scope="col" className="py-1 text-right font-normal">
                  Backing
                </th>
              </tr>
            </thead>
            <tbody>
              {breakdown.isolates.map((isolate, index) => (
                <tr
                  key={`${isolate.url}:${String(index)}`}
                  className="border-t border-border/40"
                >
                  <td className="py-1 pr-3">
                    {describeDesktopJsHeapIsolate(isolate)}
                    {isolate.kind === "worker" ? (
                      <span className="ml-2 font-mono text-code-xs text-muted-foreground">
                        {isolate.url.slice(isolate.url.lastIndexOf("/") + 1)}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1 pr-3 text-right font-mono tabular-nums">
                    {formatMemoryBytes(isolate.usedBytes)}
                  </td>
                  <td className="py-1 pr-3 text-right font-mono tabular-nums">
                    {formatMemoryBytes(isolate.totalBytes)}
                  </td>
                  <td className="py-1 pr-3 text-right font-mono tabular-nums">
                    {formatOptionalMemoryBytes(isolate.embedderBytes)}
                  </td>
                  <td className="py-1 text-right font-mono tabular-nums">
                    {formatOptionalMemoryBytes(isolate.backingStorageBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border/60 text-muted-foreground">
                <td className="py-1 pr-3">
                  {breakdown.isolates.length === 1
                    ? "1 isolate"
                    : `${String(breakdown.isolates.length)} isolates`}
                  {breakdown.workingSetBytes === null
                    ? null
                    : ` · process working set ${formatMemoryBytes(breakdown.workingSetBytes)}`}
                </td>
                <td className="py-1 pr-3 text-right font-mono tabular-nums">
                  {formatMemoryBytes(totals.usedBytes)}
                </td>
                <td className="py-1 pr-3 text-right font-mono tabular-nums">
                  {formatMemoryBytes(totals.totalBytes)}
                </td>
                <td className="py-1 pr-3 text-right font-mono tabular-nums">
                  {formatOptionalMemoryBytes(totals.embedderBytes)}
                </td>
                <td className="py-1 text-right font-mono tabular-nums">
                  {formatOptionalMemoryBytes(totals.backingStorageBytes)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  );
}
