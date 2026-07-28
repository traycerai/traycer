import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  HostCredentialMintOutcome,
  HostCredentialMintRequest,
} from "@traycer-clients/shared/host-transport/host-credential-mint-flow";
import type { MintHostCredentialFetchResult } from "@traycer-clients/shared/auth/devices-sessions-fetcher";
import { StepUpChallengeDialog } from "@/components/auth/step-up-challenge-dialog";
import {
  isStepUpCanceledError,
  StepUpCanceledError,
  type StepUpPromptRequest,
} from "@/lib/auth/step-up-prompt";
import { useHostBinding, useHostDirectory } from "@/lib/host";
import {
  resetHostCredentialProvisioning,
  setHostCredentialMintRunner,
  setHostCredentialProvisionGate,
} from "@/lib/auth/host-credential-provisioning";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import type { StepUpCredential } from "@/lib/auth/step-up-flow";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Owns the interactive half of delegated host-credential provisioning: it
 * raises the email-OTP dialog when a connected host reports it has no credential
 * of its own, mints one against authn-v3, and hands it back to the stream
 * transport that asked.
 *
 * Mounted once, app-wide, inside the authenticated runtime. It registers a
 * runner with `lib/auth/host-credential-provisioning`, which is the module every
 * `WsStreamClient` reaches through - so however many transports notice the same
 * host, exactly one dialog appears.
 *
 * Declining is a supported answer, not an error: the host keeps working on the
 * connection's credential lease, which is what every host did before this
 * existed. It simply stops working when the app disconnects.
 */
export function HostCredentialProvisionProvider(props: {
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const directory = useHostDirectory();
  const runnerHost = useRunnerHostOrNull();
  const [prompt, setPrompt] = useState<ActivePrompt | null>(null);
  const promptIdRef = useRef(0);
  /**
   * Rejects the prompt currently on screen. Held in a ref so an identity change
   * can settle the waiting mint WITHOUT a `setState` inside an effect - the
   * dialog itself disappears by derivation below, not by a state write.
   */
  const pendingRejectRef = useRef<((reason: Error) => void) | null>(null);
  /**
   * Serializes the dialog. There is exactly one prompt slot, and two hosts can
   * report `missing` at the same moment - without this, the second `setPrompt`
   * would replace the first and its promise would never settle, hanging that
   * host's mint forever.
   */
  const promptChainRef = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * Bumped whenever the signed-in identity changes. A prompt that was raised
   * for the previous user - shown, or still queued behind another host's - is
   * not a question the current user was ever asked, so it must not be answered
   * by them.
   */
  const promptEpochRef = useRef(0);
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  /**
   * Read at mint time rather than closed over, so the runner registered under
   * one identity cannot mint under another.
   */
  const identityRef = useRef(userId);

  const requestStepUpCredential = useCallback(
    (subjectLabel: string | null): Promise<StepUpCredential> => {
      const epochAtRequest = promptEpochRef.current;
      const show = (): Promise<StepUpCredential> => {
        if (promptEpochRef.current !== epochAtRequest) {
          // The identity changed while this request waited its turn in the
          // chain. Showing it now would put the previous user's question in
          // front of the current one.
          return Promise.reject(new StepUpCanceledError());
        }
        const id = promptIdRef.current + 1;
        promptIdRef.current = id;
        return new Promise<StepUpCredential>((resolve, reject) => {
          pendingRejectRef.current = reject;
          setPrompt({
            // Stamped with the identity that raised it. The render below drops
            // the dialog when this no longer matches, so a sign-out cannot
            // leave the previous user's question on screen for the next one.
            userId: identityRef.current,
            request: {
              id,
              purpose: "host-provision",
              subjectLabel,
              resolve,
              reject,
            },
          });
        });
      };
      const queued = promptChainRef.current.then(show, show);
      // The chain must not break on a rejection (a cancel), and must not leave
      // an unhandled rejection behind when nobody is awaiting the tail.
      promptChainRef.current = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    [],
  );

  const handleVerified = useCallback((credential: StepUpCredential) => {
    pendingRejectRef.current = null;
    setPrompt((current) => {
      current?.request.resolve(credential);
      return null;
    });
  }, []);

  const handleCanceled = useCallback(() => {
    pendingRejectRef.current = null;
    setPrompt((current) => {
      current?.request.reject(new StepUpCanceledError());
      return null;
    });
  }, []);

  useEffect(() => {
    const run = async (
      request: HostCredentialMintRequest,
    ): Promise<HostCredentialMintOutcome> => {
      const auth = binding?.auth ?? null;
      if (auth === null) {
        return { kind: "unavailable" };
      }
      // Best-effort: the directory names the machine so the Devices & Sessions
      // row is identifiable. A host we cannot name still gets a credential.
      const hostLabel = directory.findById(request.hostId)?.label ?? null;
      const identityAtStart = identityRef.current;
      try {
        // ALWAYS prompt, per host, before minting - deliberately NOT
        // `runStepUpProtectedAction`, whose optimistic first attempt is wrong
        // here. That helper tries the action bare and only prompts once the
        // server objects, which is right for a button the user just pressed. It
        // is wrong for this: the grant is supposed to be an explicit,
        // per-machine consent, and a session that happens to be step-up-fresh
        // (a sign-in moments ago, or an OTP the user entered to authorize a
        // DIFFERENT host) would sail through the server's freshness window and
        // hand a machine 30 days of background authority with no dialog at all.
        // Freshness is not consent, and consent for host A is not consent for
        // host B - so no step-up credential is cached or reused across hosts.
        await requestStepUpCredential(hostLabel);
      } catch (error) {
        return isStepUpCanceledError(error)
          ? { kind: "declined" }
          : { kind: "unavailable" };
      }
      if (identityRef.current !== identityAtStart) {
        // The signed-in user changed while the dialog was open. Minting now
        // would charge a 30-day credential to a user who never asked for it,
        // and the provisioning module's generation fence would then discard
        // the result - leaving an orphaned row that has ALREADY superseded
        // whatever credential the host was using. Not minting is the only
        // outcome that leaves the host where it was.
        return { kind: "unavailable" };
      }
      try {
        const result = await auth.mintHostCredential(
          {
            hostId: request.hostId,
            hostLabel,
            // The server falls back to the caller's user-agent platform.
            // Correct while every host is local; a remote host will need to
            // report its own.
            platform: null,
          },
          true,
        );
        return toMintOutcome(result);
      } catch {
        return { kind: "unavailable" };
      }
    };
    setHostCredentialMintRunner(run);
    return () => {
      setHostCredentialMintRunner(null);
    };
    // Re-registered whenever the binding or directory identity changes: the
    // runner must never close over a stale auth service, and swapping the
    // module's runner is a plain assignment that cannot disturb a mint already
    // in flight (the provisioning module holds that promise, not this effect).
  }, [binding, directory, requestStepUpCredential]);

  // The shell's cross-window arbiter. Every desktop window runs its own copy of
  // this module, so the per-host memo above is per-WINDOW; the runner host is
  // the only thing all windows share. Without this, two windows open on the
  // same un-provisioned host each raise their own email-OTP dialog.
  useEffect(() => {
    if (runnerHost === null) {
      return;
    }
    setHostCredentialProvisionGate({
      claim: async (hostId) => {
        const grant = await runnerHost.claimHostCredentialProvision(hostId);
        return grant.kind === "granted" ? grant.token : null;
      },
      release: (hostId, token) =>
        runnerHost.releaseHostCredentialProvision(hostId, token),
    });
    return () => {
      setHostCredentialProvisionGate(null);
    };
  }, [runnerHost]);

  // Scoped to the signed-in IDENTITY, not to the host binding: the binding is
  // installed once at runtime startup and lives until the provider unmounts, so
  // watching it would mean a normal sign-out never cleared anything and the next
  // user on this machine would silently inherit the previous user's "already
  // asked about this host" memo - including a decline they never made.
  useEffect(() => {
    identityRef.current = userId;
    // Retire every prompt raised for the previous identity: the visible one,
    // and any still queued behind it. Clearing the memo alone is not enough -
    // this provider is NOT unmounted by a sign-out (it sits above the auth
    // gate), so without this a dialog raised for the old user stays on screen
    // and the new user can answer it.
    // Rejected through the ref rather than through `setPrompt`: a synchronous
    // state write here would cascade a render. The dialog goes away by
    // derivation instead - see `visiblePrompt` below - and the stale entry is
    // replaced by the next prompt that is actually raised.
    promptEpochRef.current += 1;
    pendingRejectRef.current?.(new StepUpCanceledError());
    pendingRejectRef.current = null;
    resetHostCredentialProvisioning();
  }, [userId]);

  // A prompt outlives the identity that raised it - the provider is not
  // unmounted by a sign-out - so ownership is checked at render rather than
  // trusted from state.
  const visiblePrompt =
    prompt !== null && prompt.userId === userId ? prompt : null;

  return (
    <>
      {props.children}
      <StepUpChallengeDialog
        request={visiblePrompt?.request ?? null}
        onVerified={handleVerified}
        onCancel={handleCanceled}
      />
    </>
  );
}

/** A raised prompt plus the identity it was raised for. */
interface ActivePrompt {
  readonly userId: string | null;
  readonly request: StepUpPromptRequest;
}

function toMintOutcome(
  result: MintHostCredentialFetchResult,
): HostCredentialMintOutcome {
  if (result.kind === "ok") {
    return {
      kind: "provisioned",
      token: result.response.token,
      refreshToken: result.response.refreshToken,
      // Relayed verbatim: neither is derivable from the token, and the host
      // needs both to order two credentials.
      familyId: result.response.familyId,
      provisionedAt: result.response.provisionedAt,
      expiresIn: result.response.expiresIn,
    };
  }
  // `superseded` (409) included deliberately: another client won the race, so
  // there is NOTHING to hand the host and the winner's credential is already on
  // its way. Retrying here would mint a third credential and retire the winner's.
  return { kind: "unavailable" };
}
