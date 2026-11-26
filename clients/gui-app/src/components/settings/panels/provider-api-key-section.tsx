import { providerApiKeyRefusal } from "@traycer/protocol/host/provider-api-key-issuer";
import { useId, useRef, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderCliStateV1014,
} from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useProvidersSetApiKey } from "@/hooks/providers/use-providers-set-api-key-mutation";
import { takeProviderApiKeyInput } from "@/hooks/providers/provider-api-key-input";
import { useProvidersClearApiKey } from "@/hooks/providers/use-providers-clear-api-key-mutation";
import { CredentialRefusalNote } from "@/components/providers/credential-refusal-note";
import { useHostCredentialRefusal } from "@/hooks/host/use-host-credential-refusal";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import { isProviderKeyRecordDraft } from "@traycer-clients/shared/host-client/provider-api-key-change";
import { useOpenLink } from "@/lib/links/open-link";
import { envNamePlaceholder } from "./provider-env-name-placeholder";
import {
  usePersonalHostName,
  usePersonalHostState,
} from "@/components/settings/personal/personal-page-context";
import {
  deviceKeyCustodyLine,
  hostRunsPersonal,
  PROVIDER_KEY_CUSTODY_SENTENCE,
  providerKeyIsPersonalSecret,
  providerKeyEnvironmentName,
  recordKeyCustodyLine,
  type ProviderKeyPrincipal,
} from "@/lib/providers/provider-key-custody";
import { HowTraycerHandlesThis } from "@/components/settings/members/how-traycer-handles-this";
import { dataHandlingNoticeText } from "@/components/settings/members/data-handling-notice-text";
import { UNNAMED_HOST_LABEL } from "@/lib/host/host-name";

type ProviderId = ProviderCliState["providerId"];

/**
 * Where the user gets a key, per provider. `null` means "no page to send them
 * to" and simply omits the link.
 *
 * EXHAUSTIVE on purpose. This was a `Partial<Record<…>>`, and the failure mode
 * of a partial record here is entirely silent: kiro takes a `KIRO_API_KEY`,
 * renders the whole key field, and had no entry - so its users saw an input box
 * and no way to find out where a key comes from, with nothing in the code
 * marking the omission as an omission. Every future key provider would have
 * inherited that. A total record makes the compiler ask.
 *
 * Only the five providers in the host's `API_KEY_ENV_VAR` map ever reach this
 * component (`state.apiKey.supported` is false for the rest), so the other
 * thirteen entries are `null` by construction rather than by research.
 */
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
  // Kiro keys are issued from the Kiro app / AWS console rather than a stable
  // public key page; left null rather than shipping a guessed URL that dead-ends
  // the user this entry exists to help. Fill it in once one is confirmed.
  kiro: null,
  droid: "https://app.factory.ai/settings/api-keys",
  kimi: null,
  copilot: null,
  kilocode: null,
  amp: "https://ampcode.com/settings",
  // Devin is NOT an API-key provider (it is absent from the host's
  // `API_KEY_ENV_VAR`, so `apiKey.supported` is false and this section never
  // renders for it). The old entry - a Windsurf-key URL - was unreachable, and
  // making this record total is what surfaced that.
  devin: null,
  pi: null,
  hermes: null,
  omp: null,
  // Reasonix keys are pasted into its own terminal `setup` wizard, which
  // writes them to Reasonix's global store - there is no Reasonix-hosted key
  // page to send the user to, and the provider key page it would name depends
  // on which model provider they configured.
  reasonix: null,
  // Antigravity is a subscription provider (Google sign-in), so it is absent
  // from the host's `API_KEY_ENV_VAR`, `apiKey.supported` is false and this
  // section never renders for it.
  antigravity: null,
  // Command Code is a subscription provider too (browser sign-in), absent
  // from the host's `API_KEY_ENV_VAR`, so this section never renders for it.
  commandcode: null,
};

/** The configuration this page's host runs; `null` outside Personal (a Local row) or before it answers. */
function usePageHostPrincipal(): ProviderKeyPrincipal {
  const hostState = usePersonalHostState();
  return hostState?.kind === "ready" ? hostState.status.principal : null;
}

function apiKeyStatusLabel(apiKey: ProviderCliState["apiKey"]): string {
  if (!apiKey.configured) return "Not set";
  return apiKey.source === "stored" ? "Key set" : "From a shell variable";
}

/** Show the saved refusal until the person enters a replacement draft. */
function apiKeyRowRefusal(
  state: ProviderCliState,
  draft: string,
  draftRefusal: string | null,
): string | null {
  if (draft.trim().length > 0) return draftRefusal;
  if (state.apiKey.configured && state.auth.status === "unauthenticated") {
    return state.auth.detail;
  }
  return null;
}

// API-key-authenticated providers render a key field in addition to the binary picker.
//
// The draft is OWNED BY THE CALLER rather than held here. This section renders
// inside the `account` tab, and Radix unmounts an inactive `TabsContent` - so
// a locally-held draft would be destroyed by an ordinary tab switch, silently
// blanking a key the user had already pasted. `ProviderDetail` holds it
// instead: that survives tab switches and is still discarded on a provider
// switch, which remounts it by `key`.
export function ProviderApiKeySection({
  state,
  hostId,
  draft,
  onDraftChange,
  expectedEnvironmentId,
  environmentName,
}: {
  readonly state: ProviderCliStateV1014;
  readonly hostId: string | null;
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  readonly expectedEnvironmentId: string | null;
  readonly environmentName: string | null;
}) {
  const inputId = useId();
  const sentApiKey = useRef<string | null>(null);
  const setApiKey = useProvidersSetApiKey(
    expectedEnvironmentId,
    () => takeProviderApiKeyInput(sentApiKey),
    () => {
      sentApiKey.current = null;
    },
    "account-save",
  );
  const clearApiKey = useProvidersClearApiKey(expectedEnvironmentId);
  const keptKey = state.apiKeyKeptLocally === true;
  const { canSave, canShare, canClear } = useProviderApiKeyCapabilities(
    hostId,
    keptKey,
    state.apiKey.source,
  );
  const openLink = useOpenLink();
  // A sandbox never takes a key: the field is disabled and the save is never
  // sent. Clearing a stored key sends nothing secret, so it stays.
  const credentialRefusal = useHostCredentialRefusal(null);
  const principal = usePageHostPrincipal();
  const personalSecret = providerKeyIsPersonalSecret(
    state.providerId,
    principal,
  );
  const hostName = usePersonalHostName() ?? UNNAMED_HOST_LABEL;

  const recordEnvironmentId = state.apiKey.recordEnvironmentId ?? null;
  if (!state.apiKey.supported) return null;

  const providerId = state.providerId;
  const dashboardUrl = API_KEY_DASHBOARD_URL[providerId];
  const keyRefusal = providerApiKeyRefusal(providerId, draft);
  const displayedRefusal = apiKeyRowRefusal(state, draft, keyRefusal);
  const trimmedDraft = draft.trim();
  const saveDisabled = isProviderApiKeySaveDisabled({
    keptKey,
    trimmedDraft,
    setPending: setApiKey.isPending,
    clearPending: clearApiKey.isPending,
    hasCredentialRefusal: credentialRefusal !== null,
    hasKeyRefusal: keyRefusal !== null,
  });
  const onSave = (
    intent: "save" | "share",
    environmentId: string | null,
  ): void => {
    if (saveDisabled) return;
    const options = { onSuccess: () => onDraftChange("") };
    if (intent === "share") {
      if (!canShare) return;
      sentApiKey.current = trimmedDraft;
      setApiKey.mutate(
        {
          providerId,
          intent,
          environmentId,
        },
        options,
      );
      return;
    }
    if (!canSave) return;
    sentApiKey.current = trimmedDraft;
    setApiKey.mutate(
      keptKey ? { providerId, intent: "keep" } : { providerId },
      options,
    );
  };
  const sharing = setApiKey.isPending && setApiKey.variables.intent === "share";
  const clearDisabled =
    clearApiKey.isPending || (keptKey && setApiKey.isPending);
  const shareButton = (environmentId: string | null): ReactNode => (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => onSave("share", environmentId)}
      disabled={saveDisabled}
    >
      {sharing ? <MutedAgentSpinner /> : null}
      Use everywhere
    </Button>
  );

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
        <ProviderApiKeyField
          inputId={inputId}
          providerId={providerId}
          source={state.apiKey.source}
          draft={draft}
          onDraftChange={onDraftChange}
          disabled={setApiKey.isPending || credentialRefusal !== null}
          displayedRefusal={displayedRefusal}
          onSave={() => onSave("save", null)}
        />
        {canSave ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onSave("save", null)}
            disabled={saveDisabled}
          >
            {setApiKey.isPending && !sharing ? <MutedAgentSpinner /> : null}
            Save
          </Button>
        ) : null}
        <ProviderApiKeyShareAction
          canShare={canShare}
          recordEnvironmentId={recordEnvironmentId}
          renderButton={shareButton}
        />
        {canClear ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (clearDisabled) return;
              clearApiKey.mutate(
                keptKey ? { providerId, usePersonal: true } : { providerId },
              );
            }}
            disabled={clearDisabled}
          >
            {clearApiKey.isPending ? <MutedAgentSpinner /> : null}
            Clear
          </Button>
        ) : null}
      </div>
      <p
        id={`${inputId}-refusal`}
        role="alert"
        hidden={displayedRefusal === null}
        className="text-ui-xs text-destructive"
      >
        {displayedRefusal}
      </p>
      <CredentialRefusalNote refusal={credentialRefusal} />
      {keptKey ? (
        <p className="text-ui-xs text-muted-foreground">
          {`${hostName} uses: ••••••••`}
        </p>
      ) : (
        <ApiKeySourceLines
          providerId={providerId}
          fromShell={state.apiKey.source === "env"}
          personalSecret={personalSecret}
          hostName={hostName}
          principal={principal}
          recordEnvironmentId={recordEnvironmentId}
          environmentName={environmentName}
        />
      )}
    </div>
  );
}

function useProviderApiKeyCapabilities(
  hostId: string | null,
  keptKey: boolean,
  source: ProviderCliState["apiKey"]["source"],
) {
  const supportsClearKeptApiKey = useHostSupportsMethod(
    hostId,
    "providers.clearKeptApiKey",
  );
  const supportsSetKeptApiKey = useHostSupportsMethod(
    hostId,
    "providers.setKeptApiKey",
  );
  const supportsBeginApiKeyChange = useHostSupportsMethod(
    hostId,
    "providers.beginApiKeyChange",
  );
  const supportsSettleApiKeyChange = useHostSupportsMethod(
    hostId,
    "providers.settleApiKeyChange",
  );
  return {
    canSave: !keptKey || supportsSetKeptApiKey,
    canShare:
      keptKey &&
      supportsSetKeptApiKey &&
      supportsBeginApiKeyChange &&
      supportsSettleApiKeyChange,
    canClear: keptKey ? supportsClearKeptApiKey : source === "stored",
  };
}

function isProviderApiKeySaveDisabled({
  keptKey,
  trimmedDraft,
  setPending,
  clearPending,
  hasCredentialRefusal,
  hasKeyRefusal,
}: {
  readonly keptKey: boolean;
  readonly trimmedDraft: string;
  readonly setPending: boolean;
  readonly clearPending: boolean;
  readonly hasCredentialRefusal: boolean;
  readonly hasKeyRefusal: boolean;
}): boolean {
  return (
    setPending ||
    (keptKey && clearPending) ||
    trimmedDraft.length === 0 ||
    (keptKey && !isProviderKeyRecordDraft(trimmedDraft)) ||
    hasCredentialRefusal ||
    hasKeyRefusal
  );
}

function ProviderApiKeyField({
  inputId,
  providerId,
  source,
  draft,
  onDraftChange,
  disabled,
  displayedRefusal,
  onSave,
}: {
  readonly inputId: string;
  readonly providerId: ProviderId;
  readonly source: ProviderCliState["apiKey"]["source"];
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  readonly disabled: boolean;
  readonly displayedRefusal: string | null;
  readonly onSave: () => void;
}): ReactNode {
  return (
    <Input
      id={inputId}
      type="password"
      autoComplete="off"
      className="w-full"
      placeholder={
        source === "stored"
          ? "Replace stored key…"
          : `Paste your ${PROVIDER_DISPLAY_NAMES[providerId]} API key`
      }
      value={draft}
      onChange={(e) => onDraftChange(e.target.value)}
      disabled={disabled}
      aria-invalid={displayedRefusal !== null}
      aria-describedby={
        displayedRefusal === null ? undefined : `${inputId}-refusal`
      }
      onKeyDown={(e) => {
        if (e.key === "Enter") onSave();
      }}
      font="mono"
      size="sm"
    />
  );
}

function ProviderApiKeyShareAction({
  canShare,
  recordEnvironmentId,
  renderButton,
}: {
  readonly canShare: boolean;
  readonly recordEnvironmentId: string | null;
  readonly renderButton: (environmentId: string | null) => ReactNode;
}): ReactNode {
  if (!canShare) return null;
  if (recordEnvironmentId !== null) return renderButton(recordEnvironmentId);
  return (
    <ShareProviderApiKeyWithPersonalTarget>
      {renderButton}
    </ShareProviderApiKeyWithPersonalTarget>
  );
}

function ShareProviderApiKeyWithPersonalTarget({
  children,
}: {
  readonly children: (environmentId: string | null) => ReactNode;
}): ReactNode {
  const { environmentId } = usePersonalEnvironment(true);
  return children(environmentId);
}

/** Under the key field, where the key comes from and where a saved one is kept. */
function ApiKeySourceLines(props: {
  readonly providerId: ProviderId;
  readonly fromShell: boolean;
  readonly personalSecret: boolean;
  readonly hostName: string;
  readonly principal: ProviderKeyPrincipal;
  readonly recordEnvironmentId: string | null;
  readonly environmentName: string | null;
}): ReactNode {
  const { providerId, fromShell, personalSecret } = props;
  const envVar = envNamePlaceholder(providerId);
  let custody: ReactNode;
  if (props.recordEnvironmentId !== null) {
    custody = (
      <>
        <p className="max-w-[72ch] text-ui-xs text-muted-foreground">
          {recordKeyCustodyLine(
            providerId,
            props.environmentName ??
              providerKeyEnvironmentName(props.principal),
          )}
        </p>
        {personalSecret ? (
          <HowTraycerHandlesThis noticeText={dataHandlingNoticeText()} />
        ) : null}
      </>
    );
  } else if (personalSecret) {
    custody = (
      <>
        <p className="max-w-[72ch] text-ui-xs text-muted-foreground">
          {PROVIDER_KEY_CUSTODY_SENTENCE}
        </p>
        <HowTraycerHandlesThis noticeText={dataHandlingNoticeText()} />
      </>
    );
  } else {
    custody = (
      <p className="text-ui-xs text-muted-foreground">
        {deviceKeyCustodyLine(
          props.hostName,
          PROVIDER_DISPLAY_NAMES[providerId],
          envVar,
          hostRunsPersonal(props.principal),
        )}
      </p>
    );
  }
  return (
    <>
      {fromShell ? (
        <p className="text-ui-xs text-muted-foreground">
          {`Using ${envVar} from your shell. Save a key here to override it.`}
        </p>
      ) : null}
      {custody}
    </>
  );
}
