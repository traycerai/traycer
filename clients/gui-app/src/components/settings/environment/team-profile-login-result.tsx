import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  alreadySignedInAsText,
  signedInAsText,
  WAITING_FOR_PROFILE_TEXT,
  differentAccountText,
  profileNotChangedText,
  SIGN_IN_UNPROVEN_TEXT,
} from "@/components/providers/profile-sync-copy";
import { teamSignInRefusalText } from "./team-profile-login-copy";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { DialogFooter } from "@/components/ui/dialog";
import { useTeamProfileColor } from "@/hooks/environment/team/use-team-profile-color";
import { PROVIDER_STATE_UNREADABLE_COPY } from "@/lib/providers/provider-settings-unreadable-error";
import type { SignInRecordingEnd } from "@/hooks/providers/use-providers-await-login-mutation";
import type { ProviderTargetLoginControls } from "@/components/settings/panels/add-provider-profile-dialog";
import { DuplicateAccountNotice } from "@/components/settings/panels/add-provider-profile-dialog";
import {
  classifyProfileAwaitResult,
  type ProviderTargetLoginResult,
} from "@/components/settings/panels/use-provider-profile-login-flow";
import {
  useTeamProviderRecords,
  type TeamProviderRecords,
} from "./team-provider-records";

interface TeamLoginResultOptions {
  readonly switchSourceProfileId: string | null;
  readonly onSignedIn: (profile: ProviderProfile) => void;
  readonly controls: ProviderTargetLoginControls | null;
  readonly providerId: ProviderId;
  readonly environmentId: string;
  readonly teamName: string;
  readonly entryProfile: ProviderProfile | null;
  readonly onClose: () => void;
  readonly onSelect: (profileId: string) => void;
  readonly onAddAsNew: () => void;
}

export function TeamProfileLoginResult(
  props: TeamLoginResultOptions & {
    readonly result: ProviderTargetLoginResult;
  },
): ReactNode {
  const result = props.result;
  if (result.kind === "target-refused")
    return (
      <ResultFooter
        message={teamSignInRefusalText(result.targetRefusal, props.teamName)}
        onDone={props.onClose}
        action={null}
      />
    );
  if (result.signInRecordingEnded !== null)
    return (
      <ResultFooter
        message={teamRecordingEndedText(
          result.signInRecordingEnded,
          props.teamName,
        )}
        onDone={props.onClose}
        action={null}
      />
    );
  const outcome = result.profileOutcome;
  switch (outcome?.kind) {
    case "target-refused":
      return (
        <ResultFooter
          message={teamSignInRefusalText(outcome.reason, props.teamName)}
          onDone={props.onClose}
          action={null}
        />
      );
    case "waiting-for-profile":
      return (
        <ResultFooter
          message={WAITING_FOR_PROFILE_TEXT}
          onDone={props.onClose}
          action={null}
        />
      );
    case "signed-in":
    case "already-signed-in":
      return (
        <TeamNamedLoginResult
          {...props}
          profileId={outcome.profileId}
          already={outcome.kind === "already-signed-in"}
          legacy={false}
        />
      );
    case "account-mismatch":
    case "account-unproven":
      if (props.entryProfile === null) break;
      return (
        <ResultFooter
          message={
            outcome.kind === "account-mismatch" ? (
              differentAccountText(props.entryProfile.label)
            ) : (
              <>
                {SIGN_IN_UNPROVEN_TEXT}
                <br />
                {profileNotChangedText(props.entryProfile.label)}
              </>
            )
          }
          onDone={props.onClose}
          action={
            <Button type="button" size="sm" onClick={props.onAddAsNew}>
              Switch account
            </Button>
          }
        />
      );
    default:
      if (outcome === null)
        return <TeamLegacyLoginResult {...props} result={result} />;
  }
  return (
    <ResultFooter
      message="Sign-in did not finish. Retry when you are ready."
      onDone={props.onClose}
      action={null}
    />
  );
}

function TeamLegacyLoginResult(
  props: TeamLoginResultOptions & {
    readonly result: Extract<
      ProviderTargetLoginResult,
      { readonly kind: "target-outcome" }
    >;
  },
): ReactNode {
  const legacy = classifyProfileAwaitResult(
    props.result,
    props.result.admissionId,
  );
  if (legacy.kind === "authenticated" && legacy.payload !== null)
    return (
      <TeamNamedLoginResult
        {...props}
        profileId={legacy.payload.profile.profileId}
        already={
          props.entryProfile === null &&
          legacy.payload.existingProfileId !== null
        }
        legacy
      />
    );
  return (
    <ResultFooter
      message="Sign-in did not finish. Retry when you are ready."
      onDone={props.onClose}
      action={null}
    />
  );
}

function ResultFooter(props: {
  readonly message: ReactNode;
  readonly onDone: () => void;
  readonly action: ReactNode;
}): ReactNode {
  return (
    <DialogFooter>
      <div className="flex w-full flex-wrap items-center justify-end gap-2">
        <div role="status" className="min-w-0 flex-1 text-ui-sm">
          {props.message}
        </div>
        {props.action}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={props.onDone}
        >
          Done
        </Button>
      </div>
    </DialogFooter>
  );
}

interface NamedProfileRead {
  readonly profile: ProviderProfile | null;
  readonly failed: boolean;
}

function TeamNamedLoginResult(props: {
  readonly profileId: string;
  readonly already: boolean;
  readonly legacy: boolean;
  readonly switchSourceProfileId: string | null;
  readonly onSignedIn: (profile: ProviderProfile) => void;
  readonly controls: ProviderTargetLoginControls | null;
  readonly providerId: ProviderId;
  readonly environmentId: string;
  readonly onClose: () => void;
  readonly onSelect: (profileId: string) => void;
}): ReactNode {
  const records = useTeamProviderRecords();
  const colorWrite = useTeamProfileColor(() => {});
  const mounted = useRef(true);
  const autoCommitted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [read, setRead] = useState<NamedProfileRead | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const initialRead = useRef<Promise<NamedProfileRead> | null>(null);
  const reread = records?.reread;
  const providerId = props.providerId;
  const profileId = props.profileId;
  useEffect(() => {
    if (initialRead.current === null) {
      if (reread === undefined)
        initialRead.current = Promise.resolve({ profile: null, failed: true });
      else
        initialRead.current = reread().then((providers) => ({
          profile:
            providers
              ?.find((provider) => provider.providerId === providerId)
              ?.profiles.find((row) => row.profileId === profileId) ?? null,
          failed: providers === null,
        }));
    }
    let active = true;
    void initialRead.current.then((answer) => {
      if (active) setRead(answer);
    });
    return () => {
      active = false;
    };
  }, [reread, providerId, profileId]);
  const liveProfile = findTeamLoginProfile(
    records?.providers,
    providerId,
    profileId,
  );
  const profile = liveProfile ?? read?.profile ?? null;
  const done = (): void => {
    if (mounted.current && profile !== null) {
      if (props.switchSourceProfileId !== profileId) props.onSignedIn(profile);
      props.onSelect(profileId);
      props.onClose();
    }
  };
  const saveColor = async (): Promise<void> => {
    if (profile === null || saving) return;
    const color = props.controls?.accentColor;
    if (props.already || color === undefined || profile.accentColor === color) {
      done();
      return;
    }
    setSaving(true);
    setSaveFailed(false);
    const saved = await colorWrite.save(
      props.environmentId,
      providerId,
      profileId,
      color,
    );
    if (!mounted.current) return;
    setSaving(false);
    if (!saved) {
      setSaveFailed(true);
      return;
    }
    done();
  };
  useEffect(() => {
    if (profile === null || props.already || autoCommitted.current) return;
    autoCommitted.current = true;
    void saveColor();
  });
  if (read === null) return <MutedAgentSpinner />;
  if (read.failed && profile === null)
    return (
      <ResultFooter
        message={PROVIDER_STATE_UNREADABLE_COPY}
        onDone={props.onClose}
        action={
          <Button
            type="button"
            size="sm"
            onClick={() => {
              if (reread === undefined) return;
              void reread().then((providers) =>
                setRead({
                  profile:
                    providers
                      ?.find((provider) => provider.providerId === providerId)
                      ?.profiles.find((row) => row.profileId === profileId) ??
                    null,
                  failed: providers === null,
                }),
              );
            }}
          >
            Retry
          </Button>
        }
      />
    );
  if (profile === null)
    return (
      <ResultFooter
        message={WAITING_FOR_PROFILE_TEXT}
        onDone={props.onClose}
        action={null}
      />
    );
  if (saveFailed)
    return (
      <DialogFooter>
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <p role="status" className="min-w-0 flex-1 text-ui-sm">
            The account was signed in, but the profile color could not be saved.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={props.onClose}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => void saveColor()}>
            Retry
          </Button>
        </div>
      </DialogFooter>
    );
  return (
    <TeamNamedSuccessFooter
      profile={profile}
      already={props.already}
      legacy={props.legacy}
      sameSource={props.switchSourceProfileId === profileId}
      controls={props.controls}
      onDone={done}
      saving={saving}
    />
  );
}

function TeamNamedSuccessFooter(props: {
  readonly profile: ProviderProfile;
  readonly already: boolean;
  readonly legacy: boolean;
  readonly sameSource: boolean;
  readonly controls: ProviderTargetLoginControls | null;
  readonly onDone: () => void;
  readonly saving: boolean;
}): ReactNode {
  if (props.already && props.sameSource)
    return (
      <ResultFooter
        message={alreadySignedInAsText(props.profile.label)}
        onDone={props.onDone}
        action={null}
      />
    );
  if (props.already && props.legacy)
    return (
      <>
        <DuplicateAccountNotice profile={props.profile} />
        <ResultFooter
          message={null}
          onDone={props.onDone}
          action={
            props.controls === null ? null : (
              <Button
                type="button"
                size="sm"
                onClick={props.controls.onSignInWithAnother}
              >
                Sign in again
              </Button>
            )
          }
        />
      </>
    );
  if (props.already)
    return (
      <DialogFooter>
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <p role="status" className="min-w-0 flex-1 text-ui-sm">
            {alreadySignedInAsText(props.profile.label)}
          </p>
          {props.controls === null ? null : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={props.controls.onSignInWithAnother}
            >
              Sign in with another
            </Button>
          )}
          <Button type="button" size="sm" onClick={props.onDone}>
            Use
          </Button>
        </div>
      </DialogFooter>
    );
  return (
    <DialogFooter>
      <p role="status" className="text-ui-sm">
        {signedInAsText(props.profile.label)}
      </p>
      {props.saving ? <MutedAgentSpinner /> : null}
    </DialogFooter>
  );
}

function teamRecordingEndedText(
  reason: SignInRecordingEnd,
  teamName: string,
): string {
  if (reason === "forbidden")
    return teamSignInRefusalText("not-authorized", teamName);
  if (reason === "unavailable")
    return teamSignInRefusalText("target-unavailable", teamName);
  return "Sign-in did not finish. Retry when you are ready.";
}

function findTeamLoginProfile(
  providers: TeamProviderRecords["providers"] | undefined,
  providerId: string,
  profileId: string,
): ProviderProfile | null {
  return (
    providers
      ?.find((provider) => provider.providerId === providerId)
      ?.profiles.find((profile) => profile.profileId === profileId) ?? null
  );
}
