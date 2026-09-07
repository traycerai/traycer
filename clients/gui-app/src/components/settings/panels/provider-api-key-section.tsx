import { useId } from "react";
import { ExternalLink } from "lucide-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProvidersSetApiKey } from "@/hooks/providers/use-providers-set-api-key-mutation";
import { useProvidersClearApiKey } from "@/hooks/providers/use-providers-clear-api-key-mutation";
import { useOpenLink } from "@/lib/links/open-link";
import { envNamePlaceholder } from "./provider-env-name-placeholder";

type ProviderId = ProviderCliState["providerId"];

/** Only the five providers in the host's `API_KEY_ENV_VAR` map ever reach this component
 * (`state.apiKey.supported` is false for the rest). */
const API_KEY_DASHBOARD_URL: Record<ProviderId, string | null> = {
  "claude-code": null,
  codex: null,
  opencode: null,
  cursor: "https://cursor.com/dashboard/api?section=user-keys#user-api-keys",
  traycer: null,
  openrouter: "https://openrouter.ai/settings/keys",
  huggingface: "https://huggingface.co/settings/tokens",
  grok: null,
  qwen: null,
  // Kiro keys are issued from the Kiro app / AWS console rather than a stable public key page; left null rather
  // than shipping a guessed URL that dead-ends the user this entry exists to help.
  kiro: null,
  droid: "https://app.factory.ai/settings/api-keys",
  kimi: null,
  copilot: null,
  kilocode: null,
  amp: "https://ampcode.com/settings",
  // Devin is not an API-key provider (it is absent from the host's `API_KEY_ENV_VAR`, so `apiKey.supported` is
  // false and this section never renders for it).
  devin: null,
  pi: null,
  hermes: null,
  omp: null,
  // Reasonix keys are pasted into its own terminal `setup` wizard, which writes them to Reasonix's global store.
  reasonix: null,
};

function apiKeyStatusLabel(apiKey: ProviderCliState["apiKey"]): string {
  if (!apiKey.configured) return "Not set";
  return apiKey.source === "stored" ? "Key set" : "From environment";
}

// The raw key never leaves the host; `state.apiKey` only reports whether one is configured and where it came
// from. The draft is owned BY the caller rather than held here.
export function ProviderApiKeySection({
  state,
  draft,
  onDraftChange,
}: {
  readonly state: ProviderCliState;
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
}) {
  const inputId = useId();
  const setApiKey = useProvidersSetApiKey();
  const clearApiKey = useProvidersClearApiKey();
  const openLink = useOpenLink();

  if (!state.apiKey.supported) return null;

  const providerId = state.providerId;
  const dashboardUrl = API_KEY_DASHBOARD_URL[providerId];
  const onSave = (): void => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || setApiKey.isPending) return;
    setApiKey.mutate(
      { providerId, apiKey: trimmed },
      { onSuccess: () => onDraftChange("") },
    );
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={inputId}
          className="text-ui-sm font-medium text-foreground"
        >
          API key
        </label>
        <span className="text-ui-xs text-muted-foreground">
          {apiKeyStatusLabel(state.apiKey)}
        </span>
      </div>
      {dashboardUrl === null ? null : (
        <button
          type="button"
          onClick={() => {
            void openLink(dashboardUrl, "docs", null);
          }}
          className="inline-flex w-fit items-center gap-1.5 text-ui-xs font-medium text-primary transition-colors hover:text-primary/80 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded"
        >
          Create an API key
          <ExternalLink className="size-3" />
        </button>
      )}
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          className="w-full font-mono text-ui-sm"
          placeholder={
            state.apiKey.source === "stored"
              ? "Replace stored key…"
              : `Paste your ${PROVIDER_DISPLAY_NAMES[providerId]} API key`
          }
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          disabled={setApiKey.isPending}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave();
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={onSave}
          disabled={setApiKey.isPending || draft.trim().length === 0}
        >
          {setApiKey.isPending ? <MutedAgentSpinner /> : null}
          Save
        </Button>
        {state.apiKey.source === "stored" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (!clearApiKey.isPending) clearApiKey.mutate({ providerId });
            }}
            disabled={clearApiKey.isPending}
          >
            {clearApiKey.isPending ? <MutedAgentSpinner /> : null}
            Clear
          </Button>
        ) : null}
      </div>
      <p className="text-ui-xs text-muted-foreground">
        {state.apiKey.source === "env"
          ? `Using ${envNamePlaceholder(providerId)} from your shell environment. Save a key here to override it.`
          : `Stored encrypted on this device. Falls back to ${envNamePlaceholder(providerId)} from your shell when unset.`}
      </p>
    </div>
  );
}
