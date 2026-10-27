import { Globe2, RotateCcw, Search, TriangleAlert } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BrowserCreatePicker } from "./browser-create-picker";
import { isBrowserDeviceOffline } from "./browser-device-availability";
import type { BrowserListModel } from "./use-browser-list-model";

interface BrowserListFeedbackProps {
  readonly model: BrowserListModel;
  readonly epicId: string;
  readonly tabId: string;
  readonly query: string;
  readonly onClearSearch: () => void;
  readonly onOpened: (() => void) | null;
}

/** Shared state and recovery controls for the desktop rail and task switcher. */
export function BrowserListFeedback(props: BrowserListFeedbackProps) {
  const { model } = props;
  if (model.status === "inaccessible")
    return (
      <p role="status" className="px-2 py-3 text-ui-sm text-muted-foreground">
        Browser access is unavailable for this task.
      </p>
    );
  const stale = model.status === "cached" || model.status === "unavailable";
  const emptyUnavailable =
    model.rows.length === 0 && (stale || model.directoryUnavailable);
  const showEmpty =
    !model.loading &&
    !model.legacyUnavailable &&
    !emptyUnavailable &&
    model.matches.length === 0;
  return (
    <>
      <BrowserListNotices model={model} />
      <BrowserLegacyViewNotice model={model} />
      {model.loading ? (
        <div
          role="status"
          className="flex items-center gap-2 px-2 py-1.5 text-ui-sm text-muted-foreground"
        >
          <AgentSpinningDots
            className="shrink-0"
            testId={undefined}
            variant={undefined}
            tone="muted"
          />
          <span>Loading browsers…</span>
        </div>
      ) : null}
      {model.legacyUnavailable ? (
        <BrowserOwnerUnavailable model={model} />
      ) : null}
      {showEmpty ? <BrowserListEmptyState {...props} /> : null}
    </>
  );
}

function BrowserListNotices(props: { readonly model: BrowserListModel }) {
  const { model } = props;
  const stale = model.status === "cached" || model.status === "unavailable";
  let incompleteMessage =
    "Some device tabs may be missing while devices update or sync.";
  if (model.options.isLoading || !model.options.listsResolved)
    incompleteMessage = "Loading devices. Some browser tabs may be missing.";
  if (model.status === "unsupported")
    incompleteMessage =
      "Viewing one device. Update it to see tabs across devices.";
  return (
    <>
      {stale ? (
        <div
          role="status"
          className="flex items-center gap-2 px-2 py-2 text-ui-xs text-muted-foreground"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {model.rows.length === 0
              ? "Couldn't load saved browser tabs."
              : "Saved browser tabs may be out of date."}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh browser list"
            onClick={model.refresh}
          >
            <RotateCcw className="size-3.5" aria-hidden />
          </Button>
        </div>
      ) : null}
      {model.directoryUnavailable ? (
        <div
          role="status"
          className="space-y-1 px-2 py-2 text-ui-xs text-muted-foreground"
        >
          <p>Some devices couldn't be loaded. Browser tabs may be missing.</p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={model.options.retryLists}
          >
            Retry loading devices
          </Button>
        </div>
      ) : null}
      {!model.directoryUnavailable &&
      (model.incomplete || model.status === "unsupported") ? (
        <div
          className="space-y-1 px-2 py-2 text-ui-xs text-muted-foreground"
          data-testid="browser-list-incomplete"
        >
          <p role="status">{incompleteMessage}</p>
          <BrowserLegacyDevicePicker model={model} />
        </div>
      ) : null}
    </>
  );
}

function BrowserLegacyViewNotice(props: { readonly model: BrowserListModel }) {
  const { model } = props;
  if (model.legacyHostId === null || model.status === "local-only") return null;
  const name =
    model.options.hosts.find((host) => host.hostId === model.live.hostId)
      ?.name ?? model.live.hostId;
  return (
    <div className="flex items-center justify-between gap-2 px-2 text-ui-xs text-muted-foreground">
      <span>
        {model.legacyView ? `Viewing tabs on ${name}` : "Browsing device tabs"}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => model.preferences.setLegacyHost(null)}
      >
        {model.legacyView ? "All devices" : "Done"}
      </Button>
    </div>
  );
}

function BrowserListEmptyState(props: BrowserListFeedbackProps) {
  const { model } = props;
  const noSearchMatches = props.query.trim().length > 0;
  let message = model.legacyView
    ? "No browsers on this device."
    : "No browsers yet.";
  if (model.incomplete) message = "No saved browser tabs available yet.";
  if (model.filteredEmpty) message = "Browsers on offline devices are hidden.";
  if (noSearchMatches) message = "No matching browsers.";
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center text-muted-foreground"
      data-testid="browser-list-empty-state"
    >
      {noSearchMatches ? (
        <Search className="size-6 text-muted-foreground/45" aria-hidden />
      ) : (
        <Globe2 className="size-8 text-muted-foreground/45" aria-hidden />
      )}
      <p className="text-ui-sm">{message}</p>
      {noSearchMatches ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onClearSearch}
        >
          Clear search
        </Button>
      ) : null}
      {model.hiddenOfflineMatches ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => model.preferences.setShowOffline(true)}
        >
          Include offline devices
        </Button>
      ) : null}
      {!noSearchMatches && !model.filteredEmpty ? (
        <BrowserCreatePicker
          epicId={props.epicId}
          tabId={props.tabId}
          onOpened={props.onOpened}
          trigger="label"
          testId="browser-empty-add"
        />
      ) : null}
    </div>
  );
}

function BrowserLegacyDevicePicker(props: {
  readonly model: BrowserListModel;
}) {
  const { model } = props;
  const revoked = new Set(model.catalog?.inventory.revokedHostIds ?? []);
  const hosts = model.options.hosts.filter(
    (host) =>
      host.entry?.kind !== "pool" &&
      host.health.state !== "removed" &&
      !revoked.has(host.hostId),
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="xs">
          Browse a device
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(90vw,28rem)]">
        <DropdownMenuLabel>Browse device tabs</DropdownMenuLabel>
        {hosts.map((host) => (
          <DropdownMenuItem
            key={host.hostId}
            disabled={isBrowserDeviceOffline(host)}
            onSelect={() => model.preferences.setLegacyHost(host.hostId)}
          >
            <span className="min-w-0 flex-1 truncate">{host.name}</span>
            {host.health.state === "unknown" ? (
              <span className="text-ui-xs text-muted-foreground">
                Availability unknown
              </span>
            ) : null}
          </DropdownMenuItem>
        ))}
        {model.options.isLoading ? (
          <DropdownMenuItem disabled>Loading devices…</DropdownMenuItem>
        ) : null}
        {model.options.listsFailed ? (
          <DropdownMenuItem onSelect={model.options.retryLists}>
            Retry loading devices
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BrowserOwnerUnavailable(props: { readonly model: BrowserListModel }) {
  const { live } = props.model;
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-3 px-4 py-8 text-center text-ui-sm text-muted-foreground"
    >
      <TriangleAlert className="size-7 text-destructive/70" aria-hidden />
      <p>Browsers unavailable.</p>
      {live.errorMessage === null ? null : (
        <p className="text-ui-xs">{live.errorMessage}</p>
      )}
      {live.lifecycle === "unsupported" ? null : (
        <Button type="button" variant="outline" size="sm" onClick={live.retry}>
          <RotateCcw className="size-3.5" aria-hidden />
          Retry
        </Button>
      )}
    </div>
  );
}
