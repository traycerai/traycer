import {
  useId,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderId,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import type { ProvidersGetProfileConfigResponse } from "@traycer/protocol/host/provider-profile-config-schemas";
import { useProvidersProfileConfig } from "@/hooks/providers/use-providers-profile-config-query";
import { useProvidersSetProfileEndpoint } from "@/hooks/providers/use-providers-set-profile-endpoint-mutation";
import { useProvidersTestProfileConnection } from "@/hooks/providers/use-providers-test-profile-connection-mutation";
import { useRelativeTimestamp } from "@/lib/relative-time";
import {
  profileCommitId,
  signedInMessage,
} from "@/components/providers/provider-profile-model";
import { providerCanStartProfileOauth } from "@/components/providers/provider-signin-availability";
import {
  emptyProfileEndpointDraft,
  type ProfileEndpointDraft,
} from "./profile-endpoint-draft";
import { ProviderApiKeySection } from "./provider-api-key-section";
import { ProfileEditAccountSection } from "./provider-profile-edit-dialog";

/**
 * D21/W2-T10b: the row's endpoint-capabilities summary - `providers.list@9.0`
 * wire field, sourced from the host's per-provider endpoint-projection
 * descriptor (`native-config/contract-registry/endpoint-projections.ts`).
 * `null` = this provider has no endpoint projection landed, so the endpoint
 * form has nothing to render. Replaces this file's former client-side
 * `PROVIDER_SUPPORTS_ENDPOINT_BASE_URL` / `PROVIDER_CREDENTIAL_STORED_IN_
 * NATIVE_CONFIG` guess tables (a genuine wire gap the original W2-T10 ticket
 * found rather than caused) now that the host publishes the real fact.
 */
export type ProviderEndpointCapabilities = NonNullable<
  ProviderCliState["endpointCapabilities"]
>;

/**
 * The typed endpoint form (D06): base URL, credential, credential kind
 * (Claude only), default model. Shared by the Account tab's apiKey arm and
 * the add-profile dialog's API key tab, which submits the same fields through
 * `providers.createApiKeyProfile` instead of `setProfileConfig` - the caller
 * owns the draft and the submit action; this component only renders it.
 */
export function ProfileEndpointForm(props: {
  readonly providerId: ProviderId;
  readonly endpointCapabilities: ProviderEndpointCapabilities | null;
  readonly draft: ProfileEndpointDraft;
  readonly onDraftChange: (next: ProfileEndpointDraft) => void;
  readonly credentialConfigured: boolean;
  readonly disabled: boolean;
}): ReactNode {
  const baseUrlId = useId();
  const credentialId = useId();
  const credentialKindId = useId();
  const modelId = useId();
  const {
    providerId,
    endpointCapabilities,
    draft,
    onDraftChange,
    credentialConfigured,
    disabled,
  } = props;
  const showBaseUrl = endpointCapabilities?.supportsBaseUrl ?? false;
  // D06: rendered only when the provider's own descriptor actually accepts
  // more than one credential kind (today, only claude-code's `["api_key",
  // "auth_token"]`) - read off the wire instead of a second `providerId ===
  // "claude-code"` check.
  const showCredentialKind =
    (endpointCapabilities?.credentialKinds.length ?? 0) > 1;
  const nativeConfigLabel = endpointCapabilities?.credentialStoredInNativeConfig
    ? PROVIDER_DISPLAY_NAMES[providerId]
    : null;

  return (
    <div className="flex flex-col gap-3">
      {showBaseUrl ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={baseUrlId}>Base URL</Label>
          <Input
            id={baseUrlId}
            value={draft.baseUrl}
            placeholder="https://api.example.com"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            onChange={(event) =>
              onDraftChange({ ...draft, baseUrl: event.target.value })
            }
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={credentialId}>Credential</Label>
        <Input
          id={credentialId}
          type="password"
          autoComplete="off"
          value={draft.credential}
          placeholder={
            credentialConfigured
              ? "Replace stored key…"
              : "Paste the credential"
          }
          disabled={disabled}
          onChange={(event) =>
            onDraftChange({ ...draft, credential: event.target.value })
          }
        />
      </div>
      {showCredentialKind ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={credentialKindId}>Credential kind</Label>
          <Select
            value={draft.credentialKind}
            onValueChange={(value) => {
              if (value !== "api_key" && value !== "auth_token") return;
              onDraftChange({ ...draft, credentialKind: value });
            }}
            disabled={disabled}
          >
            <SelectTrigger id={credentialKindId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="api_key">API key</SelectItem>
              <SelectItem value="auth_token">Auth token</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={modelId}>Default model</Label>
        <Input
          id={modelId}
          value={draft.defaultModel}
          placeholder="Free-form model id"
          autoComplete="off"
          disabled={disabled}
          onChange={(event) =>
            onDraftChange({ ...draft, defaultModel: event.target.value })
          }
        />
      </div>
      {nativeConfigLabel !== null ? (
        <p className="text-ui-xs text-muted-foreground">
          Stored in {nativeConfigLabel}&apos;s own config.
        </p>
      ) : null}
    </div>
  );
}

type ProfileEndpointLastTest = NonNullable<
  ProviderProfile["endpoint"]
>["lastTest"];

function TestedOkBadge({ at }: { readonly at: number }): ReactNode {
  const relative = useRelativeTimestamp(at);
  return (
    <Badge variant="secondary">Tested {relative.toLocaleLowerCase()}</Badge>
  );
}

/** D10: the row's stored test verdict - absent, passing, or failing with the
 *  host-scrubbed reason verbatim (never re-truncated here). */
function ProfileEndpointTestBadge({
  lastTest,
}: {
  readonly lastTest: ProfileEndpointLastTest;
}): ReactNode {
  if (lastTest === null) return <Badge variant="outline">Not tested</Badge>;
  if (lastTest.ok) return <TestedOkBadge at={lastTest.at} />;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Badge variant="destructive">Test failed</Badge>
      {lastTest.reason !== null ? (
        <p className="text-ui-xs text-destructive">{lastTest.reason}</p>
      ) : null}
    </div>
  );
}

/**
 * The apiKey arm's endpoint draft, hydrated from the loaded profile config.
 *
 * During-render hydration (same shape as `provider-custom-model-provider-dialog.tsx`'s
 * `useRelockAgainstCatalog`): adopt the loaded config into the draft the
 * moment the ROW being edited changes, never on every render and never via
 * an effect - an effect would paint one stale frame (the previous profile's
 * draft, or the empty one) before correcting itself.
 *
 * Keyed on `hydrationKey` - `(providerId, profileId)` - and NOT on the
 * response object. The user is typing into this form while the config query
 * is live, so keying on the response identity means any background change to
 * the config - a save elsewhere, this form's own `setQueryData`, a refetch
 * that structurally differs - silently discards what they have typed.
 */
function useHydratedEndpointDraft(
  hydrationKey: string,
  config: ProvidersGetProfileConfigResponse | undefined,
): readonly [
  ProfileEndpointDraft,
  Dispatch<SetStateAction<ProfileEndpointDraft>>,
] {
  const [draft, setDraft] = useState<ProfileEndpointDraft>(
    emptyProfileEndpointDraft(),
  );
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  if (config !== undefined && hydratedFor !== hydrationKey) {
    setHydratedFor(hydrationKey);
    const endpoint = config.config.endpoint;
    setDraft({
      baseUrl: endpoint?.baseUrl ?? "",
      credential: "",
      credentialKind: endpoint?.credentialKind ?? "api_key",
      defaultModel: endpoint?.defaultModel ?? "",
    });
  }
  return [draft, setDraft];
}

/**
 * The Account tab's `authType: "apiKey"` arm: the typed endpoint form plus
 * Save (`providers.setProfileConfig`) and Test connection
 * (`providers.testProfileConnection`). Both RPCs are optional methods (D21) -
 * `supportsSetConfig` false means an old host with no apiKey rows to select in
 * the first place (`providers.list` ≤8 strips them), kept as a fail-closed
 * fallback rather than an assumed-unreachable branch.
 */
function ApiKeyProfileAccountArm({
  state,
  profile,
  hostId,
}: {
  readonly state: ProviderCliState;
  readonly profile: ProviderProfile;
  readonly hostId: string | null;
}): ReactNode {
  const providerId = state.providerId;
  const profileId = profile.profileId;
  const supportsSetConfig = useHostSupportsMethod(
    hostId,
    "providers.setProfileConfig",
  );
  const supportsTest = useHostSupportsMethod(
    hostId,
    "providers.testProfileConnection",
  );
  const configQuery = useProvidersProfileConfig({
    providerId,
    profileId,
    enabled: supportsSetConfig,
  });
  const setEndpoint = useProvidersSetProfileEndpoint();
  const testConnection = useProvidersTestProfileConnection();
  const [draft, setDraft] = useHydratedEndpointDraft(
    `${providerId}:${profileId}`,
    configQuery.data,
  );

  if (!supportsSetConfig) {
    return (
      <div className="rounded-lg border border-border/60 p-3 text-ui-sm text-muted-foreground">
        This host does not support editing profile endpoints yet.
      </div>
    );
  }

  const credentialConfigured =
    configQuery.data?.config.endpoint?.credentialConfigured ?? false;

  const onSave = (): void => {
    if (setEndpoint.isPending) return;
    const trimmedBaseUrl = draft.baseUrl.trim();
    const trimmedModel = draft.defaultModel.trim();
    const trimmedCredential = draft.credential.trim();
    setEndpoint.mutate(
      {
        providerId,
        profileId,
        baseUrl: trimmedBaseUrl.length === 0 ? null : trimmedBaseUrl,
        credentialKind: draft.credentialKind,
        defaultModel: trimmedModel.length === 0 ? null : trimmedModel,
        credentialUpdate:
          trimmedCredential.length === 0
            ? { kind: "unchanged" }
            : { kind: "set", value: trimmedCredential },
      },
      {
        onSuccess: () =>
          setDraft((current) => ({ ...current, credential: "" })),
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <ProfileEndpointForm
        providerId={providerId}
        endpointCapabilities={state.endpointCapabilities ?? null}
        draft={draft}
        onDraftChange={setDraft}
        credentialConfigured={credentialConfigured}
        disabled={setEndpoint.isPending}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={setEndpoint.isPending}
          onClick={onSave}
        >
          {setEndpoint.isPending ? <MutedAgentSpinner /> : null}
          Save
        </Button>
        {supportsTest ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={testConnection.isPending}
            onClick={() => {
              if (testConnection.isPending) return;
              testConnection.mutate({ providerId, profileId });
            }}
          >
            {testConnection.isPending ? <MutedAgentSpinner /> : null}
            Test connection
          </Button>
        ) : null}
        <ProfileEndpointTestBadge
          lastTest={profile.endpoint?.lastTest ?? null}
        />
      </div>
    </div>
  );
}

interface DefaultAccountEndpointDraft {
  readonly baseUrl: string;
  readonly defaultModel: string;
}

/**
 * The Default account's optional "Endpoint" section (D25/D06): base URL and
 * default model only - the credential lives in the key field
 * `ProviderApiKeySection` already renders above this, so it is not repeated
 * here.
 */
function DefaultAccountEndpointSection({
  state,
  hostId,
}: {
  readonly state: ProviderCliState;
  readonly hostId: string | null;
}): ReactNode {
  const providerId = state.providerId;
  const baseUrlId = useId();
  const modelId = useId();
  const supportsSetConfig = useHostSupportsMethod(
    hostId,
    "providers.setProfileConfig",
  );
  const showBaseUrl = state.endpointCapabilities?.supportsBaseUrl ?? false;
  const configQuery = useProvidersProfileConfig({
    providerId,
    profileId: null,
    enabled: supportsSetConfig && showBaseUrl,
  });
  const setEndpoint = useProvidersSetProfileEndpoint();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DefaultAccountEndpointDraft>({
    baseUrl: "",
    defaultModel: "",
  });
  // Keyed on the row, not the response - see the profile form above.
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  if (configQuery.data !== undefined && hydratedFor !== providerId) {
    setHydratedFor(providerId);
    const endpoint = configQuery.data.config.endpoint;
    setDraft({
      baseUrl: endpoint?.baseUrl ?? "",
      defaultModel: endpoint?.defaultModel ?? "",
    });
  }

  if (!supportsSetConfig || !showBaseUrl) return null;

  const onSave = (): void => {
    if (setEndpoint.isPending) return;
    const trimmedBaseUrl = draft.baseUrl.trim();
    const trimmedModel = draft.defaultModel.trim();
    setEndpoint.mutate({
      providerId,
      profileId: null,
      baseUrl: trimmedBaseUrl.length === 0 ? null : trimmedBaseUrl,
      credentialKind:
        configQuery.data?.config.endpoint?.credentialKind ?? "api_key",
      defaultModel: trimmedModel.length === 0 ? null : trimmedModel,
      credentialUpdate: { kind: "unchanged" },
    });
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="w-fit">
          Endpoint
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 pt-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={baseUrlId}>Base URL</Label>
          <Input
            id={baseUrlId}
            value={draft.baseUrl}
            placeholder="https://api.example.com"
            autoComplete="off"
            spellCheck={false}
            disabled={setEndpoint.isPending}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                baseUrl: event.target.value,
              }))
            }
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={modelId}>Default model</Label>
          <Input
            id={modelId}
            value={draft.defaultModel}
            placeholder="Free-form model id"
            autoComplete="off"
            disabled={setEndpoint.isPending}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                defaultModel: event.target.value,
              }))
            }
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="w-fit"
          disabled={setEndpoint.isPending}
          onClick={onSave}
        >
          {setEndpoint.isPending ? <MutedAgentSpinner /> : null}
          Save
        </Button>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The Default account arm (D12): today's key field, unchanged, plus the
 *  optional Endpoint section above. */
function DefaultAccountAccountTab({
  state,
  hostId,
  apiKeyDraft,
  onApiKeyDraftChange,
}: {
  readonly state: ProviderCliState;
  readonly hostId: string | null;
  readonly apiKeyDraft: string;
  readonly onApiKeyDraftChange: (draft: string) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <ProviderApiKeySection
        state={state}
        draft={apiKeyDraft}
        onDraftChange={onApiKeyDraftChange}
      />
      <DefaultAccountEndpointSection state={state} hostId={hostId} />
    </div>
  );
}

/** The `authType: "oauth"` arm: the exact sign-in / switch-account panel the
 *  Manage dialog uses, mounted inline instead of only behind "Manage". */
function OAuthProfileAccountArm({
  state,
  profile,
  hostId,
  isSelectedHostLocal,
}: {
  readonly state: ProviderCliState;
  readonly profile: ProviderProfile;
  readonly hostId: string | null;
  readonly isSelectedHostLocal: boolean;
}): ReactNode {
  const [switchingAccount, setSwitchingAccount] = useState(false);
  // D22: admission asks "can this be signed into by SOME mode" - same
  // resolution as the switcher's Add-profile gate.
  const canOauth = providerCanStartProfileOauth(
    state,
    "device",
    isSelectedHostLocal,
  );
  return (
    <ProfileEditAccountSection
      providerId={state.providerId}
      state={state}
      profile={profile}
      hostId={hostId}
      isSelectedHostLocal={isSelectedHostLocal}
      switchingAccount={switchingAccount}
      startInReauth={false}
      canOauth={canOauth}
      savePending={false}
      invalid={false}
      onStartSwitchingAccount={() => setSwitchingAccount(true)}
      onCancelSwitchingAccount={() => setSwitchingAccount(false)}
      onCloseAfterSignIn={() => setSwitchingAccount(false)}
      onFinishSignIn={(signedIn) => {
        setSwitchingAccount(false);
        toast.success(signedInMessage(signedIn));
      }}
    />
  );
}

/**
 * The Account tab (D25): the first tab for every provider, dispatching on the
 * SELECTED row's kind/authType. Replaces `case "account":` in
 * `providers-settings-panel.tsx`, which used to mount `ProviderApiKeySection`
 * unconditionally.
 */
export function ProfileAccountTab({
  state,
  hostId,
  profileId,
  isSelectedHostLocal,
  apiKeyDraft,
  onApiKeyDraftChange,
}: {
  readonly state: ProviderCliState;
  readonly hostId: string | null;
  /** The switcher's current selection (D25) - `null` = the Default account,
   *  matching `profileCommitId`. */
  readonly profileId: string | null;
  readonly isSelectedHostLocal: boolean;
  readonly apiKeyDraft: string;
  readonly onApiKeyDraftChange: (draft: string) => void;
}): ReactNode {
  const selectedProfile =
    state.profiles.find((profile) => profileCommitId(profile) === profileId) ??
    state.profiles.at(0) ??
    null;

  if (selectedProfile === null || selectedProfile.kind === "ambient") {
    return (
      <DefaultAccountAccountTab
        state={state}
        hostId={hostId}
        apiKeyDraft={apiKeyDraft}
        onApiKeyDraftChange={onApiKeyDraftChange}
      />
    );
  }
  if (selectedProfile.authType === "oauth") {
    return (
      <OAuthProfileAccountArm
        state={state}
        profile={selectedProfile}
        hostId={hostId}
        isSelectedHostLocal={isSelectedHostLocal}
      />
    );
  }
  return (
    <ApiKeyProfileAccountArm
      state={state}
      profile={selectedProfile}
      hostId={hostId}
    />
  );
}
