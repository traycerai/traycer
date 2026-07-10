import { useId, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Eye, EyeOff, ExternalLink } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderProfile,
  type ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { AccentDot } from "@/components/providers/accent-dot";
import { AccentColorSwatchGrid } from "@/components/providers/accent-color-swatch-grid";
import {
  duplicateProfileLabel,
  profileDisplayLabel,
} from "@/components/providers/provider-profile-model";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useProvidersStartLoginForClient } from "@/hooks/providers/use-providers-start-login-mutation";
import { useProvidersAwaitLoginForClient } from "@/hooks/providers/use-providers-await-login-mutation";
import { useProvidersCancelLoginForClient } from "@/hooks/providers/use-providers-cancel-login-mutation";
import { useRenameProviderProfileForClient } from "@/hooks/providers/use-rename-provider-profile-mutation";
import { useRecolorProviderProfileForClient } from "@/hooks/providers/use-recolor-provider-profile-mutation";
import { useRemoveProviderProfileForClient } from "@/hooks/providers/use-remove-provider-profile-mutation";
import { useRunnerHost } from "@/providers/use-runner-host";
import { redactEmail } from "@/lib/providers/redact-email";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { useProviderProfileLoginFlow } from "./use-provider-profile-login-flow";

type AddProfileUiStep = "identity" | "details";

export interface FailedProviderProfileAttempt {
  readonly providerId: ProviderCliState["providerId"];
  readonly message: string;
}

export function AddProviderProfileDialog({
  state,
  client,
  open,
  onOpenChange,
  onFailedAttempt,
  onProfileCreated,
}: {
  readonly state: ProviderCliState;
  /** The host this profile is created on. Callers resolve this themselves -
   *  Settings passes its selected/default host client, a tab-scoped surface
   *  (the picker's "Create new profile" flow) passes the TAB's host client -
   *  so a mutation here can never silently land on the wrong host. `null`
   *  while a tab-scoped client is still resolving; every mutation below
   *  no-ops gracefully until it's ready (`useHostMutation`'s existing
   *  null-client handling). */
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onFailedAttempt: (attempt: FailedProviderProfileAttempt) => void;
  /** Fires once the new profile's name/color are saved - the created
   *  profile's raw `profileId` (always its commit id too: a just-created
   *  profile is always `kind: "managed"`, never ambient). Lets the caller
   *  jump its own selection UI (e.g. the Settings profile-scoped section) to
   *  the new profile without polling `state.profiles` for what changed. */
  readonly onProfileCreated: (profileId: string) => void;
}): ReactNode {
  const runnerHost = useRunnerHost();
  const supportsShareSkillsAndPlugins = state.providerId === "claude-code";
  const [shareSkillsAndPlugins, setShareSkillsAndPlugins] = useState(
    supportsShareSkillsAndPlugins,
  );
  const savedRef = useRef(false);
  const [uiStep, setUiStep] = useState<AddProfileUiStep>("identity");
  const [seededProfileId, setSeededProfileId] = useState<string | null>(null);
  const [emailRevealed, setEmailRevealed] = useState(false);
  const [label, setLabel] = useState("");
  const [accentColor, setAccentColor] =
    useState<ProviderProfileAccentColor | null>(null);
  const startLogin = useProvidersStartLoginForClient(client);
  const awaitLogin = useProvidersAwaitLoginForClient({
    client,
    getCacheHostId: () => client?.getActiveHostId() ?? null,
  });
  const cancelLogin = useProvidersCancelLoginForClient(client);
  const renameProfile = useRenameProviderProfileForClient(client);
  const recolorProfile = useRecolorProviderProfileForClient(client);
  const removeProfile = useRemoveProviderProfileForClient(client);
  const flow = useProviderProfileLoginFlow({
    mode: "create",
    providerId: state.providerId,
    existingProfileId: null,
    startLogin,
    awaitLogin,
    cancelLogin,
    failureMessages: {
      notStarted:
        "Sign-in did not start. You can retry when the provider is available.",
      notFinished: "Sign-in did not finish. Retry when you are ready.",
    },
    onFailed: (message) =>
      onFailedAttempt({ providerId: state.providerId, message }),
  });
  const busy = flow.busy || renameProfile.isPending || recolorProfile.isPending;
  const trimmedLabel = label.trim();

  // Seed the naming/coloring draft exactly once per newly-resolved identity -
  // an "adjust state during render" sync (matches `ChatForkDialogBody`'s
  // `titleState` pattern), not a render-phase resync of an in-progress edit:
  // it only fires when `profileId` itself changes (a fresh login attempt),
  // never on every render while the user is editing.
  if (
    flow.state.kind === "identity" &&
    flow.state.profileId !== seededProfileId
  ) {
    setSeededProfileId(flow.state.profileId);
    setLabel(defaultProfileLabel(flow.state.profile));
    setAccentColor(flow.state.profile.accentColor);
    setUiStep("identity");
  }

  const close = (nextOpen: boolean): void => {
    if (!nextOpen && busy && flow.state.kind !== "waiting") return;
    if (!nextOpen && flow.state.kind === "waiting") {
      flow.cancel();
    } else if (
      !nextOpen &&
      flow.state.kind === "identity" &&
      !savedRef.current
    ) {
      // Login already finalized this profile on the host (authenticated,
      // pending marker stripped) before the naming/color step - closing here
      // without saving would otherwise orphan it forever, since the host's
      // cancelLogin only discards rows still marked pending.
      removeProfile.mutate({
        providerId: state.providerId,
        profileId: flow.state.profileId,
      });
    }
    onOpenChange(nextOpen);
  };

  const start = (): void => {
    flow.start({
      shareSkillsAndPlugins:
        supportsShareSkillsAndPlugins && shareSkillsAndPlugins,
    });
  };

  const saveAndClose = (): void => {
    if (flow.state.kind !== "identity") return;
    const profile = flow.state.profile;
    if (trimmedLabel.length === 0 || accentColor === null) return;
    const closeOnSuccess = (): void => {
      savedRef.current = true;
      onProfileCreated(profile.profileId);
      close(false);
    };
    const recolorIfNeeded = (): void => {
      if (accentColor === profile.accentColor) {
        closeOnSuccess();
        return;
      }
      recolorProfile.mutate(
        {
          providerId: state.providerId,
          profileId: profile.profileId,
          accentColor,
        },
        { onSuccess: closeOnSuccess },
      );
    };
    if (trimmedLabel !== profile.label) {
      renameProfile.mutate(
        {
          providerId: state.providerId,
          profileId: profile.profileId,
          label: trimmedLabel,
        },
        { onSuccess: recolorIfNeeded },
      );
      return;
    }
    recolorIfNeeded();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="w-[min(92vw,34rem)]">
        <DialogHeader>
          <DialogTitle>
            Add {PROVIDER_DISPLAY_NAMES[state.providerId]} profile
          </DialogTitle>
          <DialogDescription>
            Sign in with another subscription to use it side by side.
          </DialogDescription>
        </DialogHeader>
        {flow.state.kind === "start" ? (
          <AddProfileStartStep
            providerId={state.providerId}
            busy={busy}
            shareSkillsAndPlugins={shareSkillsAndPlugins}
            setShareSkillsAndPlugins={setShareSkillsAndPlugins}
            supportsShareSkillsAndPlugins={supportsShareSkillsAndPlugins}
            onStart={start}
          />
        ) : null}
        {flow.state.kind === "waiting" ? (
          <AddProfileWaitingStep
            loginUrl={flow.state.url}
            queuePending={flow.startPending}
            onOpenExternalLink={(url) => void runnerHost.openExternalLink(url)}
            onCancel={() => close(false)}
          />
        ) : null}
        {flow.state.kind === "identity" && uiStep === "identity" ? (
          <AddProfileIdentityStep
            profile={flow.state.profile}
            duplicateLabel={duplicateProfileLabel(
              flow.state.profile,
              flow.state.profiles,
            )}
            emailRevealed={emailRevealed}
            setEmailRevealed={setEmailRevealed}
          />
        ) : null}
        {flow.state.kind === "identity" && uiStep === "details" ? (
          <AddProfileDetailsStep
            providerId={state.providerId}
            profile={flow.state.profile}
            label={label}
            setLabel={setLabel}
            selectedColor={accentColor}
            setSelectedColor={setAccentColor}
            profiles={flow.state.profiles}
          />
        ) : null}
        {flow.state.kind === "failed" ? (
          <AddProfileFailureStep message={flow.state.message} onRetry={start} />
        ) : null}
        <AddProviderProfileDialogFooter
          waiting={flow.state.kind === "waiting"}
          startView={flow.state.kind === "start"}
          identityView={flow.state.kind === "identity" && uiStep === "identity"}
          detailsView={flow.state.kind === "identity" && uiStep === "details"}
          busy={busy}
          startPending={flow.startPending}
          savePending={renameProfile.isPending || recolorProfile.isPending}
          saveDisabled={trimmedLabel.length === 0 || accentColor === null}
          onCancel={() => close(false)}
          onStart={start}
          onContinueToDetails={() => setUiStep("details")}
          onSave={saveAndClose}
        />
      </DialogContent>
    </Dialog>
  );
}

function AddProviderProfileDialogFooter({
  waiting,
  startView,
  identityView,
  detailsView,
  busy,
  startPending,
  savePending,
  saveDisabled,
  onCancel,
  onStart,
  onContinueToDetails,
  onSave,
}: {
  readonly waiting: boolean;
  readonly startView: boolean;
  readonly identityView: boolean;
  readonly detailsView: boolean;
  readonly busy: boolean;
  readonly startPending: boolean;
  readonly savePending: boolean;
  readonly saveDisabled: boolean;
  readonly onCancel: () => void;
  readonly onStart: () => void;
  readonly onContinueToDetails: () => void;
  readonly onSave: () => void;
}): ReactNode {
  return (
    <DialogFooter>
      <Button
        type="button"
        variant="ghost"
        onClick={onCancel}
        disabled={busy ? !waiting : false}
      >
        Cancel
      </Button>
      {startView ? (
        <Button
          type="button"
          variant="secondary"
          onClick={onStart}
          disabled={busy}
        >
          {startPending ? <MutedAgentSpinner /> : null}
          Continue to sign-in
        </Button>
      ) : null}
      {identityView ? (
        <Button type="button" variant="secondary" onClick={onContinueToDetails}>
          Continue
        </Button>
      ) : null}
      {detailsView ? (
        <Button
          type="button"
          variant="secondary"
          onClick={onSave}
          disabled={busy || saveDisabled}
        >
          {savePending ? <MutedAgentSpinner /> : null}
          Save profile
        </Button>
      ) : null}
    </DialogFooter>
  );
}

function AddProfileStartStep({
  providerId,
  busy,
  shareSkillsAndPlugins,
  setShareSkillsAndPlugins,
  supportsShareSkillsAndPlugins,
}: {
  readonly providerId: ProviderCliState["providerId"];
  readonly busy: boolean;
  readonly shareSkillsAndPlugins: boolean;
  readonly setShareSkillsAndPlugins: (value: boolean) => void;
  readonly supportsShareSkillsAndPlugins: boolean;
  readonly onStart: () => void;
}): ReactNode {
  const shareSkillsAndPluginsId = useId();
  return (
    <div className="flex flex-col gap-3 text-ui-sm">
      <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-muted-foreground">
        This creates an isolated {PROVIDER_DISPLAY_NAMES[providerId]} profile on
        this host. You will confirm the account, then choose its name and color.
      </div>
      {supportsShareSkillsAndPlugins ? (
        <div className="flex items-start gap-2 text-muted-foreground">
          <Checkbox
            id={shareSkillsAndPluginsId}
            aria-label="Use terminal account skills and plugins"
            checked={shareSkillsAndPlugins}
            disabled={busy}
            onCheckedChange={(value) =>
              setShareSkillsAndPlugins(value === true)
            }
          />
          <label
            htmlFor={shareSkillsAndPluginsId}
            className="flex min-w-0 cursor-pointer flex-col gap-0.5 select-none"
          >
            <span className="text-foreground">
              Use terminal skills and plugins
            </span>
            <span>
              Recommended for Claude Code profiles. Keeps this profile on the
              terminal account's installed skills and plugins.
            </span>
          </label>
        </div>
      ) : null}
      {busy ? (
        <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 p-3 text-ui-xs text-muted-foreground">
          <MutedAgentSpinner />
          <span>
            Starting sign-in. If another sign-in for this provider is already
            running, this waits for it to finish.
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function AddProfileWaitingStep({
  loginUrl,
  queuePending,
  onOpenExternalLink,
  onCancel,
}: {
  readonly loginUrl: string | null;
  readonly queuePending: boolean;
  readonly onOpenExternalLink: (url: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-border/60 bg-muted/20 p-3">
        <div className="flex items-center gap-2 text-ui-sm text-foreground">
          <MutedAgentSpinner />
          <span>Waiting for browser sign-in</span>
        </div>
        <p className="mt-1 text-ui-xs text-muted-foreground">
          {queuePending
            ? "Another sign-in for this provider is running. This one will start after it finishes."
            : "Complete the provider sign-in in your browser. You can reopen the link if needed."}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {loginUrl !== null ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => onOpenExternalLink(loginUrl)}
          >
            <ExternalLink className="size-3.5" />
            Open sign-in page
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel sign-in
        </Button>
      </div>
    </div>
  );
}

export function AddProfileIdentityStep({
  profile,
  duplicateLabel,
  emailRevealed,
  setEmailRevealed,
}: {
  readonly profile: ProviderProfile;
  readonly duplicateLabel: string | null;
  readonly emailRevealed: boolean;
  readonly setEmailRevealed: (value: boolean) => void;
}): ReactNode {
  const email = profile.identity?.email ?? null;
  const tier = profile.identity?.tier ?? null;
  let identityText = "Authenticated profile";
  if (email !== null) {
    identityText = emailRevealed ? email : redactEmail(email);
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-border/60 bg-muted/20 p-3">
        <div className="text-ui-xs font-medium uppercase text-muted-foreground">
          Signed in as
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-ui-sm">
          <span className="min-w-0 truncate font-medium text-foreground">
            {identityText}
          </span>
          {email !== null ? (
            <button
              type="button"
              aria-label={emailRevealed ? "Hide email" : "Reveal email"}
              aria-pressed={emailRevealed}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              onClick={() => setEmailRevealed(!emailRevealed)}
            >
              {emailRevealed ? (
                <EyeOff className="size-3.5" />
              ) : (
                <Eye className="size-3.5" />
              )}
            </button>
          ) : null}
          {tier !== null && tier.length > 0 ? (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
              {tier}
            </Badge>
          ) : null}
        </div>
      </div>
      {duplicateLabel !== null ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-ui-xs text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>This is the same account as {duplicateLabel}.</span>
        </div>
      ) : null}
    </div>
  );
}

function AddProfileDetailsStep({
  providerId,
  profile,
  label,
  setLabel,
  selectedColor,
  setSelectedColor,
  profiles,
}: {
  readonly providerId: ProviderCliState["providerId"];
  readonly profile: ProviderProfile;
  readonly label: string;
  readonly setLabel: (label: string) => void;
  readonly selectedColor: ProviderProfileAccentColor | null;
  readonly setSelectedColor: (color: ProviderProfileAccentColor) => void;
  readonly profiles: readonly ProviderProfile[];
}): ReactNode {
  const labelInputId = useId();
  const duplicateColorProfile = profiles.find(
    (candidate) =>
      candidate.profileId !== profile.profileId &&
      candidate.accentColor === selectedColor,
  );
  const tombstone = profile.reusedTombstone ?? null;
  const previewLabel = label.trim().length > 0 ? label.trim() : "New profile";
  return (
    <div className="flex flex-col gap-4">
      <label
        htmlFor={labelInputId}
        className="flex flex-col gap-1.5 text-ui-sm font-medium text-foreground"
      >
        Profile name
        <Input
          id={labelInputId}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <div className="flex flex-col gap-2">
        <div className="text-ui-sm font-medium text-foreground">
          Accent color
        </div>
        <AccentColorSwatchGrid
          selectedColor={selectedColor}
          disabled={false}
          onSelectColor={setSelectedColor}
        />
        {tombstone !== null ? (
          <p className="text-ui-xs text-muted-foreground">
            Previously used by removed {tombstone.label}.
          </p>
        ) : null}
        {duplicateColorProfile !== undefined ? (
          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-ui-xs text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {profileDisplayLabel(duplicateColorProfile)} already uses this
              color. You can keep it, but matching colors may be harder to scan.
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-ui-xs font-medium uppercase text-muted-foreground">
          Preview
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="relative flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-ui-sm font-semibold text-foreground">
            <HarnessIcon harnessId={providerIdToGuiHarnessId(providerId)} />
            <AccentDot
              profileId={profile.profileId}
              accentColor={selectedColor}
              label={previewLabel}
              variant="corner"
              size="default"
              className={undefined}
            />
          </span>
          <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-ui-xs text-foreground">
            <AccentDot
              profileId={profile.profileId}
              accentColor={selectedColor}
              label={null}
              variant="inline"
              size="default"
              className={undefined}
            />
            <span className="min-w-0 truncate">{previewLabel}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function AddProfileFailureStep({
  message,
  onRetry,
}: {
  readonly message: string | null;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-ui-sm text-destructive">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>{message ?? "Sign-in did not finish."}</span>
      </div>
      <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function defaultProfileLabel(profile: ProviderProfile): string {
  const email = profile.identity?.email ?? null;
  if (email === null) return profile.label;
  const prefix = email.split("@")[0] ?? "";
  return prefix.length > 0 ? prefix : profile.label;
}
