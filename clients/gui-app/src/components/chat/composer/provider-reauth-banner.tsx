import { AlertTriangle, Check, Copy, ExternalLink } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useId, useMemo, useState } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderLoginCapability,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { providerSignedOutMessage } from "@traycer/protocol/host/provider-display";
import type { ProviderReauthReason } from "./use-provider-reauth-gate";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { RefreshIconButton } from "@/components/refresh-icon-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  CodePasteField,
  CodePasteRestartNotice,
} from "@/components/settings/panels/code-paste-field";
import {
  useProviderProfileLoginFlow,
  type ProviderProfileLoginFlow,
} from "@/components/settings/panels/use-provider-profile-login-flow";
import { waitingStepCopy } from "@/components/settings/panels/waiting-step-copy";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useProvidersCancelLogin } from "@/hooks/providers/use-providers-cancel-login-mutation";
import { useProvidersSetEnvOverride } from "@/hooks/providers/use-providers-set-env-override-mutation";
import { useProvidersSetApiKey } from "@/hooks/providers/use-providers-set-api-key-mutation";
import { useProvidersStartLogin } from "@/hooks/providers/use-providers-start-login-mutation";
import { useProvidersAwaitLogin } from "@/hooks/providers/use-providers-await-login-mutation";
import { useProvidersSubmitLoginCode } from "@/hooks/providers/use-providers-submit-login-code-mutation";
import { useProvidersTouchLogin } from "@/hooks/providers/use-providers-touch-login-mutation";
import { useTabRefreshProviders } from "@/hooks/providers/use-tab-refresh-providers";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { HostRuntimeContext, useHostBinding } from "@/lib/host/runtime";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { handleSignInLinkCopyError } from "@/components/settings/panels/provider-sign-in-link";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";

function noop(): void {}

// Static destructive icon shared by every banner state. Hoisted to module scope
// so it isn't rebuilt on each render.
const BANNER_HEADER_ICON = (
  <AlertTriangle
    className="mt-0.5 size-3.5 shrink-0 text-destructive"
    aria-hidden
  />
);

interface ProviderReauthBannerProps {
  readonly providerId: ProviderId;
  /**
   * Live provider state from the composer's tab-scoped re-auth gate
   * (`useProviderReauthGate`). The banner reads its reconnect capability from
   * here rather than owning a second subscription; the gate unmounts the banner
   * the instant the provider flips back to `authenticated`.
   */
  readonly state: ProviderCliState | null;
  readonly reason: ProviderReauthReason;
  /** The blocked managed profile id; null only for provider-wide auth. */
  readonly profileId: string | null;
  /** The blocked profile's own label - only set for `profile_unauthenticated`. */
  readonly profileLabel: string | null;
  /**
   * Confirm-first fallback to the ambient/host login for the two
   * profile-specific reasons - `null` for `provider_unauthenticated` (already
   * ambient, so there is no fallback to offer). Never called automatically.
   */
  readonly onContinueOnAmbient: (() => void) | null;
}

// A profile-specific block (missing/removed, or that profile's own auth is
// signed out) has no provider-wide OAuth/token form to fall into - the
// managed profile's config dir is what would need reconnecting, and that
// flow already lives in Settings -> Providers (ticket 04/06), not duplicated
// here. This banner only offers the confirm-first ambient fallback plus a
// link to the existing per-profile reconnect UI.
function ProfileUnavailableBanner({
  providerId,
  reason,
  profileId,
  profileLabel,
  hostId,
  onContinueOnAmbient,
}: {
  readonly providerId: ProviderId;
  readonly reason: Extract<
    ProviderReauthReason,
    "profile_missing" | "profile_unauthenticated"
  >;
  readonly profileId: string | null;
  readonly profileLabel: string | null;
  readonly hostId: string;
  readonly onContinueOnAmbient: () => void;
}) {
  const providerLabel = PROVIDER_DISPLAY_NAMES[providerId];
  const message =
    reason === "profile_missing"
      ? `This chat's ${providerLabel} profile is no longer available.`
      : `"${profileLabel ?? providerLabel}" is signed out.`;
  const { openSettings } = useSystemTabModalActions();
  const openProviderSettings = (): void => {
    if (profileId !== null) {
      useProvidersFocusStore.getState().setProfileFocus({
        harnessId: providerIdToGuiHarnessId(providerId),
        hostId,
        profileId,
        startSignIn: reason === "profile_unauthenticated",
      });
    } else {
      useProvidersFocusStore
        .getState()
        .setFocusHarnessId(providerIdToGuiHarnessId(providerId));
    }
    openSettings({ section: "providers", resetToGeneral: false });
  };
  return (
    <ReauthBannerShell icon={BANNER_HEADER_ICON} action={null}>
      <span className="text-foreground/90">{message}</span>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="secondary" onClick={onContinueOnAmbient}>
          Continue on Terminal account
        </Button>
        <Button size="sm" variant="ghost" onClick={openProviderSettings}>
          {reason === "profile_unauthenticated"
            ? "Sign in"
            : "Manage in Settings"}
        </Button>
      </div>
    </ReauthBannerShell>
  );
}

// Destructive chrome shared by every banner state, mirroring the inline
// `ErrorSegment` frame so a signed-out provider keeps a familiar weight above
// the composer whether or not the tab's host is reachable. The status line
// rides above the box in every state, so it lives here rather than at each call.
// `action` is a top-right slot for the manual Refresh control; the unreachable
// state passes `null` (no tab client to re-probe with).
function ReauthBannerShell({
  icon,
  action,
  children,
}: {
  readonly icon: ReactNode;
  readonly action: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="mb-3 flex w-full flex-col gap-1.5">
      <div className="flex w-full flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-ui-sm">
        <div className="flex items-start gap-2">
          {icon}
          <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
          <div className="flex shrink-0 items-center gap-1">
            {action}
            <ReportIssueAction
              context={createReportIssueContext({
                title: "Provider needs to be reconnected",
                message: null,
                code: null,
                source: "Provider sign-in",
              })}
              presentation="icon"
              className="-my-1 -mr-1 text-destructive"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// Manual re-check: the gate no longer auto-force-refreshes on activate (that
// re-ran the flaky standalone probe and flickered the banner). This hands the
// user an explicit "I reconnected - check again" affordance. Uses the
// tab-scoped refresh (same hook the token form uses) so it targets the host
// that ran (and will re-run) the turn explicitly, not via the context override.
function BannerRefreshButton() {
  const refreshProviders = useTabRefreshProviders();
  return (
    <RefreshIconButton
      onRefresh={refreshProviders}
      label="Check sign-in status"
      className="-my-1 -mr-1"
    />
  );
}

// The reconnect methods to offer a signed-out (web-login) provider. `canOauth`
// requires a local host (the `<cli> auth login` loopback runs on the host's
// machine) plus a real (non-empty) OAuth login command (an empty `oauthArgs`
// would spawn the bare binary, which can't browser-OAuth headlessly); `envVars`
// are the credential vars the
// paste form can write (an API key / OAuth token) via `providers.setEnvOverride`,
// which works on any host. Both are reconnect affordances - distinct from a
// *rejected* credential, which never reaches here (it surfaces as a generic error
// row; API-key-only providers like Cursor have no capability and no banner).
function deriveLoginOptions(
  state: ProviderCliState | null,
  isLocalHost: boolean,
): {
  readonly envVars: ReadonlyArray<string>;
  readonly canOauth: boolean;
} {
  const loginCapability: ProviderLoginCapability | null =
    state !== null ? state.loginCapability : null;
  const envVars: ReadonlyArray<string> =
    loginCapability !== null && loginCapability.token !== null
      ? loginCapability.token.vars
      : [];
  const oauthArgs = loginCapability !== null ? loginCapability.oauthArgs : null;
  // A real login needs a non-empty subcommand. `null` = no OAuth; `[]` is also
  // inert because the host would spawn the bare binary under piped stdio, which
  // for an interactive-TUI CLI (e.g. droid) opens no browser and hangs the
  // banner on "Waiting for browser sign-in…".
  const canOauth = isLocalHost && oauthArgs !== null && oauthArgs.length > 0;
  return { envVars, canOauth };
}

/**
 * Composer-level re-authentication banner for a provider whose CLI is signed
 * out on the tab's host. Rendered (and unmounted) by `useProviderReauthGate`
 * purely from live auth state - there is no "reconnected" success state here,
 * because reconnecting simply clears the gate and removes the banner.
 *
 * The banner addresses the tab's host, not the app-wide active host: it
 * re-provides `HostRuntimeContext` bound to the tab client so the `providers.*`
 * login/refresh mutations target the host that ran (and will re-run) the turn.
 */
export function ProviderReauthBanner({
  providerId,
  state,
  reason,
  profileId,
  profileLabel,
  onContinueOnAmbient,
}: ProviderReauthBannerProps) {
  const tabHostId = useTabHostId();
  const directory = useHostDirectoryList();
  const tabClient = useTabHostClient();
  const realBinding = useHostBinding();

  const tabEntry = useMemo(
    () =>
      (directory.data ?? []).find((entry) => entry.hostId === tabHostId) ??
      null,
    [directory.data, tabHostId],
  );
  // OAuth runs a localhost loopback on the host's machine, so the reconnect
  // button is only offered when the tab's host is local; remote hosts fall
  // through to the "reconnect from the CLI" stub.
  const isLocalHost = tabEntry?.kind === "local";
  const scopedBinding = useMemo(
    () =>
      tabClient !== null && realBinding !== null
        ? { ...realBinding, hostClient: tabClient }
        : null,
    [tabClient, realBinding],
  );

  const message = providerSignedOutMessage(providerId);

  // A profile-specific block has no host-scoped OAuth/token mutation to set
  // up (see `ProfileUnavailableBanner`'s comment) - render it standalone,
  // independent of the tab-host-reachability plumbing below that only the
  // ambient `provider_unauthenticated` path needs.
  if (reason !== "provider_unauthenticated") {
    if (onContinueOnAmbient === null) {
      throw new Error(
        "ProviderReauthBanner: onContinueOnAmbient is required for a profile-specific reason.",
      );
    }
    return (
      <ProfileUnavailableBanner
        providerId={providerId}
        reason={reason}
        profileId={profileId}
        profileLabel={profileLabel}
        hostId={tabHostId}
        onContinueOnAmbient={onContinueOnAmbient}
      />
    );
  }

  // The tab's host is momentarily unreachable (directory/client still
  // resolving, or genuinely offline): re-auth can't be driven from here.
  if (scopedBinding === null) {
    return (
      <ReauthBannerShell icon={BANNER_HEADER_ICON} action={null}>
        <span className="text-foreground/90">{message}</span>
        <span className="text-ui-xs text-muted-foreground">
          This chat&apos;s machine is unavailable. Reconnect once it&apos;s back
          online.
        </span>
      </ReauthBannerShell>
    );
  }

  return (
    <HostRuntimeContext.Provider value={scopedBinding}>
      <ReauthBannerInner
        providerId={providerId}
        state={state}
        isLocalHost={isLocalHost}
        message={message}
      />
    </HostRuntimeContext.Provider>
  );
}

function ReauthBannerInner({
  providerId,
  state,
  isLocalHost,
  message,
}: {
  readonly providerId: ProviderId;
  readonly state: ProviderCliState | null;
  readonly isLocalHost: boolean;
  readonly message: string;
}) {
  const providerLabel = PROVIDER_DISPLAY_NAMES[providerId];
  const { envVars, canOauth } = deriveLoginOptions(state, isLocalHost);
  // Providers with a host-side encrypted API-key store (Cursor / Droid) save the
  // pasted key as that secret (`providers.setApiKey`) rather than a plaintext env
  // override, matching how Settings > Providers stores it.
  const apiKeySupported = state?.apiKey.supported ?? false;

  // No reconnect method available from here: a provider with no web login, or an
  // OAuth-only provider on a remote host (loopback unreachable) with no paste
  // vars. Direct the user to the CLI.
  if (!canOauth && envVars.length === 0 && !apiKeySupported) {
    return (
      <ReauthBannerShell
        icon={BANNER_HEADER_ICON}
        action={<BannerRefreshButton />}
      >
        <span className="text-foreground/90">{message}</span>
        <span className="text-ui-xs text-muted-foreground">
          Reconnect {providerLabel} from its CLI to continue.
        </span>
      </ReauthBannerShell>
    );
  }

  return (
    <ReauthBannerShell
      icon={BANNER_HEADER_ICON}
      action={<BannerRefreshButton />}
    >
      <span className="text-foreground/90">{message}</span>
      {canOauth ? (
        <OAuthReauthForm
          providerId={providerId}
          providerLabel={providerLabel}
          loginCapability={state?.loginCapability ?? null}
        />
      ) : null}
      {envVars.length > 0 || apiKeySupported ? (
        <TokenReauthForm
          providerId={providerId}
          envVars={envVars}
          secondary={canOauth}
          apiKeySupported={apiKeySupported}
        />
      ) : null}
    </ReauthBannerShell>
  );
}

/**
 * Drives the ambient (no-profile-picker) OAuth reconnect through the same
 * `useProviderProfileLoginFlow` state machine the add-profile dialog and
 * Settings reauth panel use (`mode: "reauth"`, `existingProfileId: null` -
 * see that hook's doc comment for how it resolves this without a profile).
 * This gets keepalive, code-paste validation, and bounded auto-restart for
 * free; on success there is still no distinct "reconnected" state here -
 * the flow returns to `start` and the reauth gate's own live subscription
 * unmounts this banner, exactly like before code paste existed.
 */
function OAuthReauthForm({
  providerId,
  providerLabel,
  loginCapability,
}: {
  readonly providerId: ProviderId;
  readonly providerLabel: string;
  readonly loginCapability: ProviderLoginCapability | null;
}) {
  const startLogin = useProvidersStartLogin();
  const awaitLogin = useProvidersAwaitLogin();
  const cancelLogin = useProvidersCancelLogin();
  const submitLoginCode = useProvidersSubmitLoginCode();
  const touchLogin = useProvidersTouchLogin();

  const flow = useProviderProfileLoginFlow({
    mode: "reauth",
    providerId,
    // No profile picker yet - re-auth always targets the ambient login, not
    // a Traycer-managed profile.
    existingProfileId: null,
    loginCapability,
    startLogin,
    awaitLogin,
    cancelLogin,
    submitLoginCode,
    touchLogin,
    failureMessages: {
      notStarted: "Sign-in did not start. Try again.",
      notFinished: "Sign-in did not finish. Try again.",
    },
    // No section banner here (unlike the add-profile dialog) - a landed
    // `failed` state renders inline below instead.
    onFailed: noop,
  });

  const onAuthenticate = (): void => {
    flow.start({ label: null, shareSkillsAndPlugins: false });
  };

  if (flow.state.kind === "waiting") {
    return (
      <OAuthWaitingRow
        loginUrl={flow.state.url}
        codePaste={flow.codePaste}
        cancelPending={flow.cancelPending}
        cancelDisabled={flow.commitPending}
        onCancel={flow.cancel}
      />
    );
  }

  if (flow.state.kind === "failed") {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-ui-xs text-destructive">
          {flow.state.message}
        </span>
        <div>
          <Button size="sm" variant="secondary" onClick={onAuthenticate}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  // "start" and "cancelled" both fall back to the Authenticate button - a
  // cancelled ambient reconnect reverts straight to it, same as before code
  // paste existed. "starting" keeps showing it too, pending/disabled, the
  // same way the original single-mutation form did (no separate
  // intermediate row).
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          size="sm"
          variant="secondary"
          onClick={onAuthenticate}
          disabled={flow.startPending}
        >
          {flow.startPending ? <MutedAgentSpinner /> : null}
          Authenticate {providerLabel}
        </Button>
      </div>
      <p className="text-ui-xs text-muted-foreground">
        Opens your browser to sign in to {providerLabel}.
      </p>
    </div>
  );
}

// Compact counterpart of `AddProfileWaitingStep`: one browser-approval status
// with code paste available as a conditional fallback. The same field, copy,
// restart notice, and mutation-derived status are shared across all surfaces.
function OAuthWaitingRow({
  loginUrl,
  codePaste,
  cancelPending,
  cancelDisabled,
  onCancel,
}: {
  readonly loginUrl: string | null;
  readonly codePaste: ProviderProfileLoginFlow["codePaste"];
  readonly cancelPending: boolean;
  readonly cancelDisabled: boolean;
  readonly onCancel: () => void;
}) {
  const openExternalLink = useRunnerOpenExternalLink();
  const { copied, copy } = useClipboardCopy({
    resetMs: 1600,
    onSuccess: null,
    onError: handleSignInLinkCopyError,
  });
  const processingCode = codePaste.phase !== "idle";
  const { title, guidance } = waitingStepCopy({
    phase: codePaste.phase,
    queuePending: false,
    cancelRequested: false,
  });
  return (
    <div className="flex flex-col gap-2.5" aria-live="polite">
      {codePaste.restartNotice !== null ? (
        <CodePasteRestartNotice message={codePaste.restartNotice} />
      ) : null}
      <div className="flex items-start gap-2 text-ui-sm text-foreground">
        <MutedAgentSpinner />
        <div className="min-w-0">
          <div className="font-medium">{title}</div>
          {guidance !== null ? (
            <p className="mt-0.5 text-ui-xs leading-relaxed text-muted-foreground">
              {guidance}
            </p>
          ) : null}
        </div>
      </div>
      {!processingCode && loginUrl !== null ? (
        <div className="flex items-center gap-1.5 pl-5">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => openExternalLink.mutate(loginUrl)}
          >
            <ExternalLink className="size-3.5" />
            Open browser again
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={copied ? "Copied sign-in link" : "Copy sign-in link"}
            onClick={() => copy(loginUrl)}
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </Button>
        </div>
      ) : null}
      {codePaste.enabled ? (
        <div className="border-t border-border/50 pt-2.5">
          {!processingCode ? (
            <div className="mb-2">
              <p className="text-ui-xs font-medium text-foreground">
                Didn&apos;t return automatically?
              </p>
              <p className="mt-0.5 text-ui-xs text-muted-foreground">
                If the browser shows a code, paste it here.
              </p>
            </div>
          ) : null}
          <CodePasteField
            key={codePaste.attemptId}
            codePaste={codePaste}
            disabled={false}
            visibleLabel={false}
          />
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          disabled={cancelPending || cancelDisabled}
          onClick={onCancel}
        >
          {cancelPending ? <MutedAgentSpinner /> : null}
          Cancel
        </Button>
      </div>
    </div>
  );
}

// Paste a fresh credential into the provider's reconnect path, then immediately
// force-probe auth. Providers with a host-side encrypted API-key store (Cursor /
// Droid) save it as that secret via `providers.setApiKey` — the same path as
// Settings > Providers; OAuth-token providers (Claude Code / Grok) write the
// chosen credential var via `providers.setEnvOverride`. If the probe returns
// authenticated the gate unmounts this banner; if still unauthenticated (bad
// token) we stay mounted and show an inline error so the user can retry without a
// page reload.
function TokenReauthForm({
  providerId,
  envVars,
  secondary,
  apiKeySupported,
}: {
  readonly providerId: ProviderId;
  readonly envVars: ReadonlyArray<string>;
  // True when rendered beneath the OAuth button as the fallback option.
  readonly secondary: boolean;
  // True when the provider has an encrypted host-side API-key store (Cursor /
  // Droid), so the pasted key is saved as that secret instead of a plaintext env
  // override.
  readonly apiKeySupported: boolean;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [pickedVar, setPickedVar] = useState("");
  const [probing, setProbing] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const setEnvOverride = useProvidersSetEnvOverride();
  const setApiKey = useProvidersSetApiKey();
  const refreshProviders = useTabRefreshProviders();
  const queryClient = useQueryClient();
  const tabHostId = useTabHostId();

  // Derive the active variable instead of syncing state via an effect: keep the
  // user's pick while it's still offered, else default to the first var.
  const activeVar =
    pickedVar !== "" && envVars.includes(pickedVar)
      ? pickedVar
      : (envVars[0] ?? "");
  const activeCredentialLabel = activeVar === "" ? "API key" : activeVar;

  const busy = setEnvOverride.isPending || setApiKey.isPending || probing;

  // Shared post-write step: force-probe auth after the credential is stored.
  // `useTabRefreshProviders` writes the fresh probe result into the query cache
  // synchronously in its `onSuccess` before `mutateAsync` resolves, so by the
  // time the `.then()` runs the cache already holds the updated auth status. Read
  // it directly rather than using `finally` (which fires on both success and
  // failure, causing a false "not accepted" flash when the token is valid and the
  // gate is about to unmount this component).
  const afterWrite = (): void => {
    setDraft("");
    setProbing(true);
    void refreshProviders()
      .then(() => {
        setProbing(false);
        const data = queryClient.getQueryData<
          ResponseOfMethod<HostRpcRegistry, "providers.list">
        >(
          hostQueryKeys.method<HostRpcRegistry, "providers.list">(
            tabHostId,
            "providers.list",
            {},
          ),
        );
        const providerState = data?.providers.find(
          (p) => p.providerId === providerId,
        );
        if (providerState?.auth.status === "unauthenticated") {
          setTokenError("Token not accepted — double-check and try again.");
        }
        // If authenticated, the gate reads the updated cache and unmounts this
        // banner. No action needed here.
      })
      .catch(() => {
        setProbing(false);
        setTokenError("Couldn't verify token — please try again.");
      });
  };

  const onSave = (): void => {
    const trimmed = draft.trim();
    if (
      trimmed.length === 0 ||
      (!apiKeySupported && activeVar === "") ||
      busy
    ) {
      return;
    }
    setTokenError(null);
    if (apiKeySupported) {
      // Cursor / Droid: store as the encrypted host-side secret, exactly like
      // Settings > Providers.
      setApiKey.mutate(
        { providerId, apiKey: trimmed },
        { onSuccess: afterWrite },
      );
    } else {
      setEnvOverride.mutate(
        { providerId, key: activeVar, value: trimmed },
        { onSuccess: afterWrite },
      );
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={inputId}
        className="text-ui-xs font-medium text-foreground"
      >
        {secondary
          ? "Or paste an API key or token"
          : "Reconnect with an API key or token"}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {envVars.length > 1 ? (
          <Select value={activeVar} onValueChange={setPickedVar}>
            <SelectTrigger
              size="sm"
              aria-label="Credential type"
              className="w-[min(60vw,16rem)] font-mono text-ui-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {envVars.map((envVar) => (
                <SelectItem
                  key={envVar}
                  value={envVar}
                  className="font-mono text-ui-xs"
                >
                  {envVar}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          className="min-w-0 flex-1 font-mono text-ui-sm"
          placeholder={`Paste your ${activeCredentialLabel}`}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (tokenError !== null) setTokenError(null);
          }}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave();
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={onSave}
          disabled={busy || draft.trim().length === 0}
        >
          {busy ? <MutedAgentSpinner /> : null}
          {probing ? "Checking…" : "Save"}
        </Button>
      </div>
      {tokenError !== null ? (
        <p className="text-ui-xs text-destructive">{tokenError}</p>
      ) : null}
    </div>
  );
}
