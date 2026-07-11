import { useId, useState } from "react";
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
import { useRunnerHost } from "@/providers/use-runner-host";
import { envNamePlaceholder } from "./provider-env-name-placeholder";

type ProviderId = ProviderCliState["providerId"];

const API_KEY_DASHBOARD_URL: Partial<Record<ProviderId, string>> = {
  cursor: "https://cursor.com/dashboard/api?section=user-keys#user-api-keys",
  droid: "https://app.factory.ai/settings/api-keys",
  openrouter: "https://openrouter.ai/settings/keys",
  amp: "https://ampcode.com/settings",
  // Devin uses Windsurf API keys (WINDSURF_API_KEY / credentials.toml).
  devin: "https://app.devin.ai/",
};

function apiKeyStatusLabel(apiKey: ProviderCliState["apiKey"]): string {
  if (!apiKey.configured) return "Not set";
  return apiKey.source === "stored" ? "Key set" : "From environment";
}

// API-key-authenticated providers (Cursor) render a key field in addition to
// the binary picker. The raw key never leaves the host; `state.apiKey` only
// reports whether one is configured and where it came from.
export function ProviderApiKeySection({
  state,
}: {
  readonly state: ProviderCliState;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const setApiKey = useProvidersSetApiKey();
  const clearApiKey = useProvidersClearApiKey();
  const runnerHost = useRunnerHost();

  if (!state.apiKey.supported) return null;

  const providerId = state.providerId;
  const dashboardUrl = API_KEY_DASHBOARD_URL[providerId];
  const onSave = (): void => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || setApiKey.isPending) return;
    setApiKey.mutate(
      { providerId, apiKey: trimmed },
      { onSuccess: () => setDraft("") },
    );
  };

  return (
    <div className="mb-3 flex flex-col gap-2 rounded-lg border border-border/60 p-3">
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
      {dashboardUrl === undefined ? null : (
        <button
          type="button"
          onClick={() => {
            void runnerHost.openExternalLink(dashboardUrl);
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
          onChange={(e) => setDraft(e.target.value)}
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
