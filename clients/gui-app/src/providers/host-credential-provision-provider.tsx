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
} from "@/lib/auth/host-credential-provisioning";
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
  const [prompt, setPrompt] = useState<StepUpPromptRequest | null>(null);
  const promptIdRef = useRef(0);
  /**
   * Serializes the dialog. There is exactly one prompt slot, and two hosts can
   * report `missing` at the same moment - without this, the second `setPrompt`
   * would replace the first and its promise would never settle, hanging that
   * host's mint forever.
   */
  const promptChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const requestStepUpCredential = useCallback(
    (subjectLabel: string | null): Promise<StepUpCredential> => {
      const show = (): Promise<StepUpCredential> => {
        const id = promptIdRef.current + 1;
        promptIdRef.current = id;
        return new Promise<StepUpCredential>((resolve, reject) => {
          setPrompt({
            id,
            purpose: "host-provision",
            subjectLabel,
            resolve,
            reject,
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
    setPrompt((current) => {
      current?.resolve(credential);
      return null;
    });
  }, []);

  const handleCanceled = useCallback(() => {
    setPrompt((current) => {
      current?.reject(new StepUpCanceledError());
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

  // Scoped to the signed-in IDENTITY, not to the host binding: the binding is
  // installed once at runtime startup and lives until the provider unmounts, so
  // watching it would mean a normal sign-out never cleared anything and the next
  // user on this machine would silently inherit the previous user's "already
  // asked about this host" memo - including a decline they never made.
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  useEffect(() => {
    resetHostCredentialProvisioning();
  }, [userId]);

  return (
    <>
      {props.children}
      <StepUpChallengeDialog
        request={prompt}
        onVerified={handleVerified}
        onCancel={handleCanceled}
      />
    </>
  );
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
