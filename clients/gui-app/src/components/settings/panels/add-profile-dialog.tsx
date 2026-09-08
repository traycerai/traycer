import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import type { ProfileSeedSource } from "@traycer/protocol/host/provider-profile-config-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useProvidersCreateApiKeyProfileForClient } from "@/hooks/providers/use-providers-create-api-key-profile-mutation";
import { ProfileEndpointForm } from "./profile-account-tab";
import {
  emptyProfileEndpointDraft,
  parseMaxContextSize,
  type ProfileEndpointDraft,
} from "./profile-endpoint-draft";
import {
  ProviderSignInPanel,
  type FailedProviderProfileAttempt,
} from "./add-provider-profile-dialog";
import { nextAvailableAccentColor } from "@/lib/providers/profile-accent-color";
import { providerSupportsTerminalLogin } from "@/components/providers/provider-signin-availability";

type StartFromValue = "defaultAccount" | "empty" | `profile:${string}`;

/**
 * Parses a Radix `Select`'s raw `string` into the union, or `null` when it is
 * not one of this dialog's own values. A cast here would let an unrecognized
 * string reach `startFromValueToSeed`'s `slice`, which would put
 * `{kind:"profile", profileId:"<garbage>"}` on the wire; `profileIds` is the
 * live managed set the options were built from, so a stale id is refused too.
 */
function parseStartFromValue(
  value: string,
  profileIds: ReadonlySet<string>,
): StartFromValue | null {
  if (value === "defaultAccount" || value === "empty") return value;
  if (!value.startsWith("profile:")) return null;
  const profileId = value.slice("profile:".length);
  return profileIds.has(profileId) ? `profile:${profileId}` : null;
}

function startFromValueToSeed(value: StartFromValue): ProfileSeedSource {
  if (value === "defaultAccount") return { kind: "defaultAccount" };
  if (value === "empty") return { kind: "empty" };
  return { kind: "profile", profileId: value.slice("profile:".length) };
}

/**
 * D25: the single add-profile dialog - step 1 (name + "Start from"), step 2
 * (Sign in / API key tabs). Wraps `ProviderSignInPanel`
 * (`add-provider-profile-dialog.tsx`, formerly `AddProviderProfileDialog`)
 * as the Sign in tab's body rather than forking it - that file still owns
 * the whole OAuth login state machine (waiting step, code paste, the
 * post-auth naming step, accent-color assignment).
 *
 * "Start from" (`ProfileSeedSource`) has a wire effect on both step-2 tabs
 * (D32/W2-T10b): the API key tab's `providers.createApiKeyProfile` call, and
 * the Sign in tab's `providers.startLogin@1.3` `startFrom` (threaded through
 * `ProviderSignInPanel`'s `startFrom` prop into `useProviderProfileLoginFlow`).
 * `providers.startTerminalLogin` does not carry a seed field yet, so for a
 * terminal-login provider the "Start from" choice applies to the API key tab
 * only - step 1 says so under the control rather than ignoring it silently.
 * Recorded as a D32 deferral.
 */
export function AddProfileDialog({
  state,
  client,
  hostId,
  isSelectedHostLocal,
  open,
  onOpenChange,
  onFailedAttempt,
  onProfileCreated,
}: {
  readonly state: ProviderCliState;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly isSelectedHostLocal: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onFailedAttempt: (
    attempt: FailedProviderProfileAttempt | null,
  ) => void;
  readonly onProfileCreated: (profileId: string) => void;
}): ReactNode {
  const nameId = useId();
  const startFromId = useId();
  // Stable callback ref focuses the name field when step 1 mounts, without
  // the banned `autoFocus` prop (same pattern as `ShellFlagChips`).
  const focusNameInput = useCallback((node: HTMLInputElement | null): void => {
    node?.focus();
  }, []);
  const [step, setStep] = useState<"start" | "method">("start");
  const [label, setLabel] = useState("");
  const [startFromValue, setStartFromValue] =
    useState<StartFromValue>("defaultAccount");
  const [activeTab, setActiveTab] = useState<"signin" | "apiKey">("signin");
  const [apiKeyDraft, setApiKeyDraft] = useState<ProfileEndpointDraft>(() =>
    emptyProfileEndpointDraft(),
  );
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  // Routes a Dialog-level dismissal (Escape, outside click, the X button)
  // through whichever step-2 panel is mounted. Only `ProviderSignInPanel`
  // needs to guard one (an in-flight login must not be dropped silently), so
  // this defaults to a plain pass-through and the panel overwrites it for as
  // long as it stays mounted (see that file's `closeRequestRef` effect,
  // which restores this default on unmount/tab switch).
  const closeRequestRef = useRef<(open: boolean) => void>((next) =>
    onOpenChange(next),
  );
  // Picked once, at mount - stable across the two tabs and across the
  // sign-in flow's own naming/finalize steps.
  const [accentColor] = useState<ProviderProfileAccentColor>(() =>
    nextAvailableAccentColor(state.profiles),
  );
  const supportsCreateApiKeyProfile = useHostSupportsMethod(
    hostId,
    "providers.createApiKeyProfile",
  );
  const createApiKeyProfile = useProvidersCreateApiKeyProfileForClient(client);
  const trimmedLabel = label.trim();
  const managedProfiles = state.profiles.filter(
    (profile) => profile.kind !== "ambient",
  );
  const managedProfileIds = new Set(
    managedProfiles.map((profile) => profile.profileId),
  );
  // D32 seeding rides `providers.createApiKeyProfile` and
  // `providers.startLogin@1.3`. `providers.startTerminalLogin` carries no
  // seed field yet, so for a terminal-login provider the choice applies to
  // the API key tab and NOT to the Sign in tab. The control stays (a
  // terminal-login provider still gets API-key profiles - D11) and says so;
  // a silently-ignored picker is the one end state that is not acceptable.
  // Recorded as a D32 deferral.
  const seedIgnoredOnSignIn = providerSupportsTerminalLogin(
    state.loginCapability,
  );

  const handleOpenChange = (next: boolean): void => {
    if (next) {
      onOpenChange(next);
      return;
    }
    if (step === "method" && activeTab === "signin") {
      closeRequestRef.current(next);
      return;
    }
    if (createApiKeyProfile.isPending) return;
    onOpenChange(next);
  };

  const submitApiKey = (): void => {
    if (trimmedLabel.length === 0) return;
    if (apiKeyDraft.credential.trim().length === 0) return;
    setApiKeyError(null);
    createApiKeyProfile.mutate(
      {
        providerId: state.providerId,
        label: trimmedLabel,
        accentColor,
        startFrom: startFromValueToSeed(startFromValue),
        endpoint: {
          baseUrl:
            apiKeyDraft.baseUrl.trim().length === 0
              ? null
              : apiKeyDraft.baseUrl.trim(),
          credentialKind: apiKeyDraft.credentialKind,
          defaultModel:
            apiKeyDraft.defaultModel.trim().length === 0
              ? null
              : apiKeyDraft.defaultModel.trim(),
          maxContextSize: parseMaxContextSize(apiKeyDraft.maxContextSize),
        },
        credential: apiKeyDraft.credential,
      },
      {
        onSuccess: (data) => {
          // D10: a failed test comes back as an ORDINARY `ok:false` (the
          // host deletes the draft), never a thrown `HostRpcError` - this
          // must stay open and show the reason, not report success.
          if (!data.ok) {
            setApiKeyError(data.reason);
            return;
          }
          setApiKeyDraft(emptyProfileEndpointDraft());
          onFailedAttempt(null);
          onProfileCreated(data.profileId);
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add profile</DialogTitle>
          <DialogDescription>
            Add another {PROVIDER_DISPLAY_NAMES[state.providerId]} profile
            alongside the default account.
          </DialogDescription>
        </DialogHeader>

        {step === "start" ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={nameId}>Profile name</Label>
              <Input
                ref={focusNameInput}
                id={nameId}
                value={label}
                maxLength={64}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={startFromId}>Start from</Label>
              <Select
                value={startFromValue}
                onValueChange={(value) => {
                  const parsed = parseStartFromValue(value, managedProfileIds);
                  if (parsed === null) return;
                  setStartFromValue(parsed);
                }}
              >
                <SelectTrigger id={startFromId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="defaultAccount">
                    Default account
                  </SelectItem>
                  {managedProfiles.map((profile) => (
                    <SelectItem
                      key={profile.profileId}
                      value={`profile:${profile.profileId}`}
                    >
                      {profile.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="empty">Empty</SelectItem>
                </SelectContent>
              </Select>
              {seedIgnoredOnSignIn ? (
                <p className="text-ui-xs text-muted-foreground">
                  Applies to the API key tab only. Signing in from a terminal
                  starts an empty profile.
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                disabled={trimmedLabel.length === 0}
                onClick={() => setStep("method")}
              >
                Continue
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <Tabs
            value={activeTab}
            onValueChange={(value) => {
              if (value !== "signin" && value !== "apiKey") return;
              setActiveTab(value);
            }}
          >
            <TabsList className="w-full">
              <TabsTrigger value="signin" className="flex-1">
                Sign in
              </TabsTrigger>
              {supportsCreateApiKeyProfile ? (
                <TabsTrigger value="apiKey" className="flex-1">
                  API key
                </TabsTrigger>
              ) : null}
            </TabsList>
            <TabsContent value="signin">
              <ProviderSignInPanel
                state={state}
                client={client}
                label={label}
                onLabelChange={setLabel}
                accentColor={accentColor}
                hostId={hostId}
                isSelectedHostLocal={isSelectedHostLocal}
                startFrom={startFromValueToSeed(startFromValue)}
                onFailedAttempt={onFailedAttempt}
                onProfileCreated={onProfileCreated}
                onRequestClose={onOpenChange}
                closeRequestRef={closeRequestRef}
              />
            </TabsContent>
            {supportsCreateApiKeyProfile ? (
              <TabsContent value="apiKey">
                <div className="flex flex-col gap-4">
                  <ProfileEndpointForm
                    providerId={state.providerId}
                    endpointCapabilities={state.endpointCapabilities ?? null}
                    draft={apiKeyDraft}
                    onDraftChange={setApiKeyDraft}
                    credentialConfigured={false}
                    disabled={createApiKeyProfile.isPending}
                  />
                  {apiKeyError !== null ? (
                    <p className="text-ui-xs text-destructive">{apiKeyError}</p>
                  ) : null}
                  <DialogFooter>
                    <Button
                      disabled={
                        createApiKeyProfile.isPending ||
                        trimmedLabel.length === 0 ||
                        apiKeyDraft.credential.trim().length === 0
                      }
                      onClick={submitApiKey}
                    >
                      {createApiKeyProfile.isPending ? (
                        <MutedAgentSpinner />
                      ) : null}
                      Create profile
                    </Button>
                  </DialogFooter>
                </div>
              </TabsContent>
            ) : null}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
