import { useState } from "react";
import { QrCode } from "lucide-react";
import { parseLinkLoginInput } from "@traycer-clients/shared/auth/link-login";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuthLinkLoginProgress } from "@/hooks/auth/use-auth-link-login-progress";
import { useLinkCodeSignInMutation } from "@/hooks/auth/use-link-code-sign-in-mutation";
import type { LinkLoginSignInResult } from "@/lib/auth/auth-service";
import { useAuthService } from "@/lib/host";
import { cn } from "@/lib/utils";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLinkLoginDeepLinkOutcomeStore } from "@/stores/auth/link-login-deep-link-outcome-store";
import { LinkCodeWaitStatus } from "./link-code-wait-status";

type EntryNotice =
  | "not-a-code"
  | "invalid-code"
  | "denied"
  | "timed-out"
  | "rate-limited"
  | "network-error"
  | "failed"
  | "camera-denied"
  | "scan-error"
  | null;

function noticeCopy(notice: Exclude<EntryNotice, null>): string {
  switch (notice) {
    case "not-a-code":
      return "That doesn't look like a link code. Scan the QR, or copy the code shown under it.";
    case "invalid-code":
      return "That code is invalid, expired, or already used. Scan the fresh one on the desktop and try again.";
    case "denied":
      return "The sign-in was rejected on your computer.";
    case "timed-out":
      return "No approval arrived in time. Scan a fresh code and confirm on your computer.";
    case "rate-limited":
      return "Too many attempts from this network. Wait a minute and try again.";
    case "network-error":
      return "Couldn't reach the sign-in service. Check that this phone can reach the desktop's network.";
    case "failed":
      return "Sign-in didn't complete. Try again with a fresh code.";
    case "camera-denied":
      return "Camera access is off — enter the code manually, or allow camera access in Settings.";
    case "scan-error":
      return "The camera couldn't be started — enter the code manually.";
  }
}

/**
 * The notice this surface shows: its own, or — when it has none — the outcome
 * of a claim `LinkLoginDeepLinkBridge` ran for a QR the SYSTEM camera scanned.
 * Those kinds are the SAME kinds a scan here produces, so they get the same
 * copy; a stale QR has to read as "expired", never as "try again".
 *
 * A local notice wins because it describes something the user just did, and
 * their own attempt is the more recent answer.
 */
function useEntryNotice(local: EntryNotice): EntryNotice {
  const fromDeepLink = useLinkLoginDeepLinkOutcomeStore(
    (state) => state.notice,
  );
  return local ?? fromDeepLink;
}

/**
 * What a settled claim should say inline, or `null` for the three kinds that
 * say nothing here.
 *
 * A completed sign-in speaks for itself. A SUPERSEDED attempt belongs to
 * whoever replaced it — its complaint would land under the successor's
 * progress and describe a request nobody is waiting on. And a `failed`
 * finalization — the desktop approved, then validation or persistence went
 * wrong — is already showing as the global sign-in error; repeating it here
 * would be a second message, in code-verdict words that misdescribe it
 * ("that code is invalid or expired" is the wrong sentence for a network
 * blip after approval).
 */
function noticeForResult(result: LinkLoginSignInResult): EntryNotice {
  if (
    result.kind === "signed-in" ||
    result.kind === "superseded" ||
    result.kind === "failed"
  ) {
    return null;
  }
  return result.kind;
}

/**
 * Whether a sign-in attempt is running at all — this surface's own redeem, or
 * one `LinkLoginDeepLinkBridge` started for a QR the SYSTEM camera scanned,
 * possibly before this surface was mounted. The user waiting on an approval is
 * the same user either way, so the condition is "an attempt is running", not
 * "I started one".
 *
 * The global `signing-in` status is what covers the CLAIM leg. Poll progress
 * only appears once the claim has already succeeded and the loop begins, so
 * gating on it alone leaves the scan and submit controls live through the
 * device-description and claim round trips — long enough for a tap to start a
 * second attempt that supersedes the camera-launched one, which then reports
 * ITS failure under the replacement's wait. It also correctly disables the
 * link path while a browser device sign-in is running, which is the same
 * mutual exclusion from the other direction.
 */
function useLinkLoginClaimInFlight(isRedeeming: boolean): boolean {
  const progress = useAuthLinkLoginProgress(useAuthService());
  const status = useAuthStore((state) => state.status);
  return isRedeeming || status === "signing-in" || progress !== null;
}

/**
 * QR link-code sign-in: redeems a one-time code minted by the desktop's
 * Settings → Link a phone panel. The camera is a capability
 * (`runnerHost.linkCodeScanner`), not an assumption — where it is absent
 * (browser dev shell) or denied, the typed-code field IS the flow, so every
 * failure lands as an inline notice above a still-usable field.
 *
 * Two presentations, both mobile-app-only (the caller gates on the product
 * signal): `cta` is the sign-in screen's emphasized full-width "Scan QR code"
 * action with manual entry as a tertiary link beneath it; `link` is the
 * compact header's quiet text entry that expands in place.
 */
export function LinkCodeSignIn(props: {
  readonly isHero: boolean;
  readonly presentation: "cta" | "link";
}) {
  const runnerHost = useRunnerHostOrNull();
  const redeem = useLinkCodeSignInMutation();
  const [open, setOpen] = useState(false);
  const [entry, setEntry] = useState("");
  const [notice, setNotice] = useState<EntryNotice>(null);
  const scanner = runnerHost === null ? null : runnerHost.linkCodeScanner;
  const claimInFlight = useLinkLoginClaimInFlight(redeem.isPending);
  const shownNotice = useEntryNotice(notice);
  const clearDeepLinkNotice = useLinkLoginDeepLinkOutcomeStore(
    (state) => state.clear,
  );

  const submit = (raw: string) => {
    const code = parseLinkLoginInput(raw);
    if (code === null) {
      setNotice("not-a-code");
      return;
    }
    setNotice(null);
    clearDeepLinkNotice();
    redeem.mutate(code, {
      onSuccess: (result) => {
        const outcome = noticeForResult(result);
        if (outcome !== null) {
          setNotice(outcome);
        }
      },
      onError: () => {
        setNotice("failed");
      },
    });
  };

  const scan = () => {
    if (scanner === null) {
      // No camera on this shell: the "scan" gesture opens manual entry, the
      // same flow minus the shortcut.
      setOpen(true);
      return;
    }
    void scanner
      .scan()
      .then((result) => {
        switch (result.kind) {
          case "scanned":
            submit(result.text);
            return;
          case "permission-denied":
            setNotice("camera-denied");
            setOpen(true);
            return;
          case "canceled":
            return;
          case "error":
            setNotice("scan-error");
            setOpen(true);
        }
      })
      .catch(() => {
        // The adapter maps every native outcome to a `kind`, so a REJECTION
        // here is the host itself failing - the plugin missing, the bridge
        // gone. Same answer as `error` either way: the user asked for a
        // camera, so they get told it did not open and the typed-code field
        // they can still use. Silence would read as a tap that did nothing.
        setNotice("scan-error");
        setOpen(true);
      });
  };

  const codeEntryForm = (
    <form
      className="flex w-full items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit(entry);
      }}
    >
      <Input
        aria-label="Link code"
        value={entry}
        onChange={(event) => {
          setEntry(event.target.value);
          setNotice(null);
          clearDeepLinkNotice();
        }}
        placeholder="XXXXX-XXXXX"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        data-testid="link-code-signin-input"
        className="flex-1 font-mono text-ui-sm"
      />
      <Button
        type="submit"
        size={props.isHero ? "default" : "sm"}
        variant="outline"
        disabled={claimInFlight || entry.trim().length === 0}
        data-testid="link-code-signin-submit"
      >
        Sign in
        {claimInFlight ? (
          <AgentSpinningDots
            variant="dots"
            className="ml-1.5"
            testId={undefined}
          />
        ) : null}
      </Button>
    </form>
  );

  // The claimed code's approval wait, shown by both presentations.
  const waitStatus = claimInFlight ? <LinkCodeWaitStatus /> : null;

  const noticeLine =
    shownNotice !== null ? (
      <p
        className="text-center text-ui-sm text-destructive"
        data-testid="link-code-signin-notice"
      >
        {noticeCopy(shownNotice)}
      </p>
    ) : null;

  if (props.presentation === "cta") {
    return (
      <div
        className="flex w-full flex-col items-center gap-3"
        data-testid="link-code-signin-cta"
      >
        <Button
          type="button"
          size="lg"
          variant="default"
          disabled={claimInFlight}
          data-testid="link-code-signin-open"
          onClick={scan}
          className="w-full cursor-pointer"
        >
          <QrCode aria-hidden="true" />
          Scan QR code
          {claimInFlight ? (
            <AgentSpinningDots
              variant="dots"
              className="ml-1.5"
              testId={undefined}
            />
          ) : null}
        </Button>
        {waitStatus}
        {open ? (
          <div
            className="flex w-full flex-col gap-3"
            data-testid="link-code-signin-panel"
          >
            <p className="text-center text-ui-sm opacity-80">
              On your desktop, open Settings → Link a phone, then type the code
              shown under the QR.
            </p>
            {codeEntryForm}
            {noticeLine}
          </div>
        ) : (
          <>
            {noticeLine}
            {/* A real button in the hero's stack, not a bare text line
                wedged between two buttons — outline keeps it clearly
                subordinate to the Scan primary. */}
            <Button
              type="button"
              size="lg"
              variant="outline"
              data-testid="link-code-signin-manual"
              onClick={() => {
                setOpen(true);
              }}
              className="w-full cursor-pointer"
            >
              Enter code manually
            </Button>
          </>
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <Button
        type="button"
        size={props.isHero ? "default" : "sm"}
        variant="link"
        data-testid="link-code-signin-open"
        onClick={() => {
          setOpen(true);
        }}
        className={cn(
          props.isHero ? "h-auto justify-center px-0 py-0 text-ui-sm" : null,
        )}
      >
        <QrCode aria-hidden="true" />
        Scan from desktop
      </Button>
    );
  }

  return (
    <div
      className="flex w-full flex-col gap-3"
      data-testid="link-code-signin-panel"
    >
      <p className="text-center text-ui-sm opacity-80">
        On your desktop, open Settings → Link a phone, then scan the QR — or
        type the code shown under it.
      </p>
      {scanner !== null ? (
        <Button
          type="button"
          size={props.isHero ? "lg" : "sm"}
          variant={props.isHero ? "default" : "outline"}
          disabled={claimInFlight}
          data-testid="link-code-signin-scan"
          onClick={scan}
        >
          Open camera
        </Button>
      ) : null}
      {codeEntryForm}
      {waitStatus}
      {noticeLine}
    </div>
  );
}
