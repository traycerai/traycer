import { Globe2, RotateCcw, Search, TriangleAlert } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { BrowserCreatePicker } from "./browser-create-picker";
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
  if (model.loading)
    return (
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
    );
  if (model.status === "error")
    return (
      <div
        role="status"
        className="flex items-center gap-2 px-2 py-2 text-ui-xs text-muted-foreground"
      >
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">Couldn't load browser tabs.</span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={model.refresh}
        >
          <RotateCcw className="size-3.5" aria-hidden />
          Retry
        </Button>
      </div>
    );
  return model.matches.length === 0 ? (
    <BrowserListEmptyState {...props} />
  ) : null;
}

function BrowserListEmptyState(props: BrowserListFeedbackProps) {
  const { model } = props;
  const noSearchMatches = props.query.trim().length > 0;
  let message = "No browsers yet.";
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
