/**
 * Docs: see ../SETTINGS.md (Providers → Agent selection guide).
 * Update that file whenever this settings surface changes.
 */
import type { ReactNode } from "react";
import { useEffect, useReducer, useRef } from "react";
import { Check, TriangleAlert } from "lucide-react";
import {
  AGENT_SELECTION_GUIDE_DESCRIPTION,
  AGENT_SELECTION_GUIDE_TITLE,
  AgentSelectionGuideEditorSurface,
} from "@/components/agent-selection-guide-editor-surface";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useAgentSelectionGuideGlobalQuery } from "@/hooks/agent/use-agent-selection-guide-global-query";
import { useAgentSelectionGuideSetGlobalMutation } from "@/hooks/agent/use-agent-selection-guide-set-global-mutation";
import { useAgentSelectionGuideResetGlobalMutation } from "@/hooks/agent/use-agent-selection-guide-reset-global-mutation";

const SAVE_DEBOUNCE_MS = 600;

type AgentsGuideEditorState = {
  readonly value: string;
  readonly savedContent: string;
  readonly confirmOpen: boolean;
  readonly saveInFlight: boolean;
  readonly resetInFlight: boolean;
  readonly saveError: boolean;
};

type AgentsGuideEditorAction =
  | { readonly type: "edit"; readonly value: string }
  | { readonly type: "confirm-open-changed"; readonly open: boolean }
  | { readonly type: "save-started" }
  | { readonly type: "save-queued" }
  | { readonly type: "save-succeeded"; readonly content: string }
  | { readonly type: "save-failed" }
  | { readonly type: "save-idle" }
  | { readonly type: "reset-started" }
  | { readonly type: "reset-queued" }
  | { readonly type: "reset-succeeded"; readonly content: string }
  | { readonly type: "reset-failed" }
  | { readonly type: "reset-idle" }
  | { readonly type: "reset-idle-before-save" };

function createAgentsGuideEditorState(
  initialContent: string,
): AgentsGuideEditorState {
  return {
    value: initialContent,
    savedContent: initialContent,
    confirmOpen: false,
    saveInFlight: false,
    resetInFlight: false,
    saveError: false,
  };
}

function agentsGuideEditorReducer(
  state: AgentsGuideEditorState,
  action: AgentsGuideEditorAction,
): AgentsGuideEditorState {
  switch (action.type) {
    case "edit":
      return { ...state, value: action.value };
    case "confirm-open-changed":
      return { ...state, confirmOpen: action.open };
    case "save-started":
      return { ...state, saveInFlight: true, saveError: false };
    case "save-queued":
      return { ...state, saveError: false };
    case "save-succeeded":
      return { ...state, savedContent: action.content };
    case "save-failed":
      return { ...state, saveError: true };
    case "save-idle":
      return { ...state, saveInFlight: false };
    case "reset-started":
      return { ...state, resetInFlight: true, saveError: false };
    case "reset-queued":
      return { ...state, resetInFlight: true, saveError: false };
    case "reset-succeeded":
      return {
        ...state,
        value: action.content,
        savedContent: action.content,
      };
    case "reset-failed":
      return { ...state, saveError: true };
    case "reset-idle":
      return { ...state, resetInFlight: false, saveInFlight: false };
    case "reset-idle-before-save":
      return { ...state, resetInFlight: false };
  }
}

export function AgentSelectionGuideSection() {
  // Device-scoped file: remount the editor with fresh content whenever the
  // active host changes so a host swap never carries one machine's edits.
  const hostId = useReactiveActiveHostId();
  const query = useAgentSelectionGuideGlobalQuery();

  let panelContent: ReactNode;
  if (query.isError) {
    panelContent = (
      <AgentSelectionGuideMessage>
        <div className="text-ui-sm text-muted-foreground">
          Couldn't load agent instructions for this host.
          <ReportIssueAction
            context={createReportIssueContext({
              title: "Couldn't load agent instructions",
              message: null,
              code: null,
              source: "Agent instructions",
            })}
            presentation="link"
            className="ml-1 h-auto p-0"
          />
        </div>
      </AgentSelectionGuideMessage>
    );
  } else if (query.data === undefined) {
    panelContent = (
      <AgentSelectionGuideMessage>
        <EditorSkeleton />
      </AgentSelectionGuideMessage>
    );
  } else {
    panelContent = (
      <AgentsGuideEditor
        key={hostId}
        initialContent={query.data.content}
        generatedDefaultContent={query.data.generatedDefaultContent}
      />
    );
  }

  return <div className="shrink-0 px-5 py-5">{panelContent}</div>;
}

function AgentSelectionGuideMessage(props: { readonly children: ReactNode }) {
  return (
    <section
      aria-labelledby="agent-selection-guide-heading"
      className="flex flex-col gap-3"
    >
      <div className="min-w-0">
        <h2
          id="agent-selection-guide-heading"
          className="text-ui-md font-semibold text-foreground"
        >
          {AGENT_SELECTION_GUIDE_TITLE}
        </h2>
        <p className="mt-1 text-ui-xs text-muted-foreground">
          {AGENT_SELECTION_GUIDE_DESCRIPTION}
        </p>
      </div>
      {props.children}
    </section>
  );
}

function AgentsGuideEditor(props: {
  readonly initialContent: string;
  readonly generatedDefaultContent: string;
}) {
  const { initialContent, generatedDefaultContent } = props;
  const setMutation = useAgentSelectionGuideSetGlobalMutation();
  const resetMutation = useAgentSelectionGuideResetGlobalMutation();
  const [state, dispatch] = useReducer(
    agentsGuideEditorReducer,
    initialContent,
    createAgentsGuideEditorState,
  );
  const debounceRef = useRef<number | null>(null);
  const latestRef = useRef(initialContent);
  const savedRef = useRef(initialContent);
  const inFlightRef = useRef(false);
  const queuedSaveRef = useRef<string | null>(null);
  const queuedResetRef = useRef(false);
  const mountedRef = useRef(true);

  // Drop a pending debounced save when unmounting (blur already flushes the
  // common close paths) so the timer can't fire into an unmounted component.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, []);

  const clearPendingDebounce = (): void => {
    if (debounceRef.current === null) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = null;
  };

  const runSave = (content: string): void => {
    if (inFlightRef.current) {
      queuedSaveRef.current = content;
      if (mountedRef.current) dispatch({ type: "save-queued" });
      return;
    }
    inFlightRef.current = true;
    if (mountedRef.current) dispatch({ type: "save-started" });
    void setMutation
      .mutateAsync({ content })
      .then((result) => {
        savedRef.current = result.content;
        if (!mountedRef.current) return;
        dispatch({ type: "save-succeeded", content: result.content });
      })
      .catch(() => {
        if (mountedRef.current) dispatch({ type: "save-failed" });
      })
      .finally(() => {
        inFlightRef.current = false;
        const queuedSave = queuedSaveRef.current;
        queuedSaveRef.current = null;
        if (queuedResetRef.current) {
          queuedResetRef.current = false;
          runReset();
          return;
        }
        if (queuedSave !== null && queuedSave !== savedRef.current) {
          runSave(queuedSave);
          return;
        }
        if (mountedRef.current) dispatch({ type: "save-idle" });
      });
  };

  const runReset = (): void => {
    if (inFlightRef.current) {
      queuedResetRef.current = true;
      queuedSaveRef.current = null;
      if (mountedRef.current) dispatch({ type: "reset-queued" });
      return;
    }
    inFlightRef.current = true;
    if (mountedRef.current) dispatch({ type: "reset-started" });
    void resetMutation
      .mutateAsync({})
      .then((result) => {
        latestRef.current = result.content;
        savedRef.current = result.content;
        if (!mountedRef.current) return;
        dispatch({ type: "reset-succeeded", content: result.content });
      })
      .catch(() => {
        if (mountedRef.current) dispatch({ type: "reset-failed" });
      })
      .finally(() => {
        inFlightRef.current = false;
        const queuedSave = queuedSaveRef.current;
        queuedSaveRef.current = null;
        if (queuedSave !== null && queuedSave !== savedRef.current) {
          if (mountedRef.current) dispatch({ type: "reset-idle-before-save" });
          runSave(queuedSave);
          return;
        }
        if (mountedRef.current) dispatch({ type: "reset-idle" });
      });
  };

  const saveLatest = (): void => {
    if (inFlightRef.current || latestRef.current !== savedRef.current) {
      runSave(latestRef.current);
    }
  };

  const onChange = (next: string): void => {
    dispatch({ type: "edit", value: next });
    latestRef.current = next;
    clearPendingDebounce();
    debounceRef.current = window.setTimeout(saveLatest, SAVE_DEBOUNCE_MS);
  };

  // Flush immediately on blur (e.g. closing settings) so the last edit is never
  // lost to a pending debounce.
  const onBlur = (): void => {
    clearPendingDebounce();
    saveLatest();
  };

  const onRevert = (): void => {
    clearPendingDebounce();
    runReset();
    dispatch({ type: "confirm-open-changed", open: false });
  };

  const isAtDefault = state.value === generatedDefaultContent;
  const isDirty = state.value !== state.savedContent;
  // A failed save/reset leaves the editor dirty; surface that as an error
  // rather than a spinner that would otherwise run forever.
  const hasError = state.saveError && isDirty;
  const isSaving =
    !hasError && (state.saveInFlight || state.resetInFlight || isDirty);
  const disabled = state.resetInFlight;

  return (
    <>
      <AgentSelectionGuideEditorSurface
        titleId="agent-selection-guide-heading"
        value={state.value}
        onValueChange={onChange}
        onBlur={onBlur}
        disabled={disabled}
        placeholder={undefined}
        ariaLabel="Global agent selection instructions"
        testId="agents-selection-guide-input"
        textareaClassName="max-h-[min(32vh,16rem)] min-h-[min(20vh,10rem)]"
        className=""
        revertDisabled={
          isAtDefault || state.saveInFlight || state.resetInFlight
        }
        onRevert={() => dispatch({ type: "confirm-open-changed", open: true })}
        revertTestId="agents-selection-guide-revert"
        status={<SaveStatus saving={isSaving} error={hasError} />}
      />
      <ConfirmDestructiveDialog
        open={state.confirmOpen}
        onOpenChange={(open) =>
          dispatch({ type: "confirm-open-changed", open })
        }
        title="Revert to default instructions?"
        description="This replaces your global agent selection instructions with defaults based on the providers currently available on this device. Your custom instructions will be lost. Workspace-level files are not affected."
        cascadeSummary={null}
        actionLabel="Revert to default"
        isPending={state.resetInFlight}
        onConfirm={onRevert}
      />
    </>
  );
}

function SaveStatus(props: {
  readonly saving: boolean;
  readonly error: boolean;
}) {
  if (props.error) {
    return (
      <span className="inline-flex items-center gap-1.5 text-ui-xs text-destructive">
        <TriangleAlert className="size-3.5" />
        Not saved
      </span>
    );
  }
  if (props.saving) {
    return (
      <span className="inline-flex items-center gap-1.5 text-ui-xs text-muted-foreground">
        <AgentSpinningDots
          className="text-muted-foreground"
          testId="agents-selection-guide-saving-spinner"
          variant={undefined}
        />
        Saving…
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-ui-xs text-muted-foreground">
      <Check className="size-3.5 text-[var(--term-ansi-green)]" />
      Saved
    </span>
  );
}

function EditorSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-[min(22vh,11rem)] animate-pulse rounded-md bg-muted/40" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted/30" />
    </div>
  );
}
