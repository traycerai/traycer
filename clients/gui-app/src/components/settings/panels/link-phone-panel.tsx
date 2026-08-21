import { useEffect, useState, type ReactElement } from "react";
import { QrCode, Smartphone } from "lucide-react";
import type { MintLinkLoginCodeResponse } from "@traycer/protocol/auth/link-login";
import { claimantDeviceLabel } from "@traycer-clients/shared/auth/link-login";
import { LinkPhoneQrTile } from "@/components/settings/panels/link-phone-qr-tile";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LINK_LOGIN_REMINT_MS } from "@/hooks/auth/use-link-login-code-query";
import { LinkLoginMintError } from "@/lib/auth/link-login-mint-error";
import { platformOriginFromSignInUrl } from "@/lib/auth/platform-base-url";
import { cn } from "@/lib/utils";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  useLinkLoginWatch,
  type LinkLoginDeadKind,
  type LiveClaim,
} from "@/hooks/auth/use-link-login-watch";
import { useRespondLinkLoginMutation } from "@/hooks/auth/use-respond-link-login-mutation";
import { useAuthStore } from "@/stores/auth/auth-store";

interface RotationCountdown {
  readonly secondsLeft: number;
  /** The same countdown as a 0..1 share, for the tile's draining frame. */
  readonly remainingFraction: number;
}

/**
 * Ticks down to the moment the query's interval mints the next code. The
 * rotation happens `expiresIn − LINK_LOGIN_REMINT_MS/1000` seconds before the
 * shown code's expiry, so the target derives from the mint response the panel
 * already holds — no extra requests, just a local 1s clock. The tile's frame
 * and the text below it read this one clock, so they can never disagree.
 */
function useRotationCountdown(props: {
  readonly expiresAtEpochSeconds: number;
  readonly expiresInSeconds: number;
}): RotationCountdown {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const rotationLeadMs = props.expiresInSeconds * 1_000 - LINK_LOGIN_REMINT_MS;
  const nextCodeAtMs = props.expiresAtEpochSeconds * 1_000 - rotationLeadMs;
  const secondsLeft = Math.max(0, Math.ceil((nextCodeAtMs - nowMs) / 1_000));
  // Measuring the lead back from expiry makes the gap between two mints the
  // remint interval itself, whatever TTL the server hands back — so that
  // interval is the full window the frame drains across.
  const windowSeconds = LINK_LOGIN_REMINT_MS / 1_000;
  // Clamped HERE, at the producer: the server picks the TTL, so a longer one
  // than the remint lead makes this ratio exceed 1 before the first rotation.
  // The tile clamps too, but a fraction above 1 is wrong wherever it is read,
  // and the second reader would have to remember.
  return {
    secondsLeft,
    remainingFraction: Math.min(1, secondsLeft / windowSeconds),
  };
}

/** The verdict whose respond round-trip is in flight, if any. */
type PendingVerdict = "approve" | "reject" | null;

/**
 * Attributes the in-flight respond to the button that fired it: the PRESSED
 * button shows the inline spinner, the other one only disables — a Reject
 * click must never put Approve into a loading state.
 */
function pendingRespondVerdict(
  isPending: boolean,
  variables: { readonly approve: boolean } | undefined,
): PendingVerdict {
  if (!isPending || variables === undefined) {
    return null;
  }
  return variables.approve ? "approve" : "reject";
}

function ConfirmClaimCard(props: {
  readonly claim: LiveClaim;
  readonly pendingVerdict: PendingVerdict;
  readonly respondFailed: boolean;
  readonly onDecide: (approve: boolean) => void;
}) {
  // Unknown metadata is simply absent — an "unknown" admission reads worse
  // than nothing, and "just now" always anchors the line.
  const detailLine = [props.claim.address, props.claim.location, "just now"]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const busy = props.pendingVerdict !== null;
  return (
    <div
      className="flex w-full max-w-md flex-col items-center gap-4"
      data-testid="link-phone-confirm"
    >
      <QrCode aria-hidden="true" className="text-muted-foreground" />
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-ui-sm font-medium text-foreground">
          Approve sign-in from {claimantDeviceLabel(props.claim.userAgent)}?
        </p>
        <p
          className="text-ui-xs text-muted-foreground"
          data-testid="link-phone-claimant"
        >
          {detailLine}
        </p>
        <p className="text-ui-xs text-muted-foreground">
          These details are approximate. Approve only if you just scanned this
          code yourself.
        </p>
      </div>
      {props.respondFailed ? (
        <p
          className="text-center text-ui-xs text-destructive"
          data-testid="link-phone-respond-failed"
        >
          That didn&apos;t reach the sign-in service. The phone is still waiting
          — check your connection and answer again.
        </p>
      ) : null}
      <div className="flex w-full items-center justify-center gap-3">
        <Button
          variant="default"
          disabled={busy}
          data-testid="link-phone-approve"
          onClick={() => {
            props.onDecide(true);
          }}
        >
          Approve
          {props.pendingVerdict === "approve" ? (
            <AgentSpinningDots
              variant="dots"
              className="ml-1.5"
              testId="link-phone-approve-spinner"
            />
          ) : null}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          data-testid="link-phone-reject"
          onClick={() => {
            props.onDecide(false);
          }}
        >
          Reject
          {props.pendingVerdict === "reject" ? (
            <AgentSpinningDots
              variant="dots"
              className="ml-1.5"
              testId="link-phone-reject-spinner"
            />
          ) : null}
        </Button>
      </div>
    </div>
  );
}

/**
 * This surface answered second. The server takes a repeat of the SAME
 * decision as idempotent and the OPPOSITE one as a conflict, so
 * `already-decided` always means the other answer won — and which one that
 * was is the inverse of the button just pressed.
 *
 * Stated plainly because the two outcomes differ in what happened to the
 * phone: an approval elsewhere signed it in, a rejection elsewhere did not.
 * Reporting either as this window's own success would be a false
 * confirmation on a security-sensitive decision.
 */
function DecidedElsewhereCard(props: {
  readonly decision: "approved" | "rejected";
  readonly retrying: boolean;
  readonly onShowNew: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center gap-3 text-center"
      data-testid="link-phone-decided-elsewhere"
      data-decision={props.decision}
    >
      <Smartphone aria-hidden="true" className="text-muted-foreground" />
      <p className="text-ui-sm text-foreground">
        {props.decision === "approved"
          ? "This request was already approved on another device or browser."
          : "This request was already rejected on another device or browser."}
      </p>
      <p className="text-ui-xs text-muted-foreground">
        {props.decision === "approved"
          ? "That phone is signed in. Your answer here was not applied."
          : "No phone was signed in. Your answer here was not applied."}
      </p>
      <Button
        variant="outline"
        disabled={props.retrying}
        data-testid="link-phone-decided-elsewhere-new"
        onClick={props.onShowNew}
      >
        Show a new code
        {props.retrying ? (
          <AgentSpinningDots
            variant="dots"
            className="ml-1.5"
            testId={undefined}
          />
        ) : null}
      </Button>
    </div>
  );
}

/**
 * A claim is live somewhere, but not on this panel's code: minting came back
 * `claim-pending`, meaning another surface (portal, CLI, second window) owns
 * the claim awaiting this user's decision. A state, not an error — and no
 * QR: any code this panel held is dead behind the server's claim lock.
 */
function AwaitingElsewhereCard() {
  return (
    <div
      className="flex flex-col items-center gap-3 text-center"
      data-testid="link-phone-awaiting-elsewhere"
    >
      <Smartphone aria-hidden="true" className="text-muted-foreground" />
      <p className="text-ui-sm text-foreground">
        A phone is waiting for your approval on another device or browser.
      </p>
      <p className="text-ui-xs text-muted-foreground">
        Approve or reject it there, then a new code can be shown here.
      </p>
    </div>
  );
}

/**
 * The displayed code was terminated externally (superseded by a mint on
 * another surface, expired, denied elsewhere). Restart is USER-driven only:
 * an automatic re-mint here would supersede the other surface's fresh code
 * and ping-pong mints between open surfaces until the rate limit.
 */
const DEAD_CARD_COPY: Record<
  LinkLoginDeadKind,
  { readonly testId: string; readonly title: string; readonly detail: string }
> = {
  superseded: {
    testId: "link-phone-superseded",
    title: "This code is no longer active.",
    detail: "It expired, or another device or browser replaced it.",
  },
  rejected: {
    testId: "link-phone-rejected-elsewhere",
    title: "This sign-in request was rejected.",
    detail:
      "The rejection came from another device or browser. No phone was signed in.",
  },
  expired: {
    testId: "link-phone-expired",
    title: "This sign-in request expired.",
    detail:
      "No approval was given in time — the phone will need to scan a new code.",
  },
};

function SupersededCard(props: {
  readonly kind: LinkLoginDeadKind;
  readonly retrying: boolean;
  readonly onShowNew: () => void;
}) {
  const copy = DEAD_CARD_COPY[props.kind];
  return (
    <div
      className="flex flex-col items-center gap-3 text-center"
      data-testid={copy.testId}
    >
      <QrCode aria-hidden="true" className="text-muted-foreground" />
      <p className="text-ui-sm text-foreground">{copy.title}</p>
      <p className="text-ui-xs text-muted-foreground">{copy.detail}</p>
      <Button
        variant="outline"
        disabled={props.retrying}
        data-testid="link-phone-show-new"
        onClick={props.onShowNew}
      >
        Show a new code here
        {props.retrying ? (
          <AgentSpinningDots
            variant="dots"
            className="ml-1.5"
            testId={undefined}
          />
        ) : null}
      </Button>
    </div>
  );
}

function ApprovedCard(props: { readonly onRestart: () => void }) {
  return (
    <div
      className="flex flex-col items-center gap-3"
      data-testid="link-phone-approved"
    >
      <Smartphone aria-hidden="true" className="text-muted-foreground" />
      <p className="text-ui-sm text-foreground">
        Approved. The phone is signing in now.
      </p>
      <Button
        variant="outline"
        data-testid="link-phone-restart"
        onClick={props.onRestart}
      >
        Link another phone
      </Button>
    </div>
  );
}

/**
 * The typeable code's box. Shared by the live code and the state that is
 * waiting for one, so both occupy exactly one line of the same type — the
 * panel cannot change height as a code arrives or rotates away.
 */
const CODE_BOX_CLASS =
  // muted-fill-ok: weak tint delimited by its own border-border/60
  "w-full rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-center font-mono text-ui-xs break-all select-all";

/**
 * Everything the code state shows around the tile. Both the live code and the
 * regenerating one render through here, which is what makes their footprints
 * identical by construction rather than by two layouts kept in agreement.
 */
function CodeSurface(props: {
  readonly tile: ReactElement;
  readonly codeSlot: ReactElement;
  readonly statusLine: ReactElement;
}) {
  return (
    <>
      {props.tile}
      <div className="flex w-full max-w-md flex-col items-center gap-2">
        <p className="text-ui-sm text-muted-foreground">
          In the mobile app, choose{" "}
          <span className="font-medium text-foreground">Scan QR code</span> — or
          type this code in:
        </p>
        {props.codeSlot}
        <div className="flex flex-col items-center gap-0.5">
          {props.statusLine}
          <p
            className="text-ui-xs text-muted-foreground"
            data-testid="link-phone-single-use-hint"
          >
            Each code signs in one phone, expires in about a minute, and only
            takes effect once you approve it here.
          </p>
        </div>
      </div>
    </>
  );
}

/**
 * The origin the QR's universal link addresses, from the SAME deploy this
 * panel is minting against — so a dev build prints a dev link and a phone
 * that follows it reaches the deploy that issued the code.
 *
 * `null` when the shell reports no usable origin, and the tile then draws no
 * symbol at all. A QR is not a page the user can back out of: whoever scans it
 * sends a LIVE claim code to whatever host it names, so "no QR, use the code
 * printed below it" is the only safe answer to not knowing the deployment.
 */
function usePlatformBaseUrl(): string | null {
  return platformOriginFromSignInUrl(useRunnerHost().signInUrl);
}

function ShowingCard(props: { readonly minted: MintLinkLoginCodeResponse }) {
  const platformBaseUrl = usePlatformBaseUrl();
  const countdown = useRotationCountdown({
    expiresAtEpochSeconds: props.minted.expires_at,
    expiresInSeconds: props.minted.expires_in,
  });
  return (
    <CodeSurface
      tile={
        <LinkPhoneQrTile
          code={props.minted.code}
          platformBaseUrl={platformBaseUrl}
          remainingFraction={countdown.remainingFraction}
        />
      }
      codeSlot={<code className={CODE_BOX_CLASS}>{props.minted.code}</code>}
      statusLine={
        <p
          className="text-ui-xs text-muted-foreground tabular-nums"
          data-testid="link-phone-countdown"
        >
          New code in {countdown.secondsLeft}s
        </p>
      }
    />
  );
}

/**
 * A code is on its way — the first mint, a rotation, or a user-driven
 * restart. It holds the code state's exact footprint so the surrounding
 * panel never resizes; only the tile and the code line themselves go quiet.
 */
function PendingCodeCard() {
  const platformBaseUrl = usePlatformBaseUrl();
  return (
    <CodeSurface
      tile={
        <LinkPhoneQrTile
          code={null}
          platformBaseUrl={platformBaseUrl}
          remainingFraction={0}
        />
      }
      codeSlot={
        <code className={cn(CODE_BOX_CLASS, "relative")}>
          {/* One invisible line of the code's own type: the box keeps its
              height exactly, whatever the font metrics are. */}
          <span className="invisible">&nbsp;</span>
          <Skeleton className="absolute inset-1 rounded-sm" />
        </code>
      }
      statusLine={
        <p
          className="text-ui-xs text-muted-foreground tabular-nums"
          data-testid="link-phone-code-pending"
        >
          Getting a new code…
        </p>
      }
    />
  );
}

function MintErrorCard(props: {
  readonly message: string;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-ui-sm text-destructive">{props.message}</p>
      <Button
        variant="outline"
        disabled={props.retrying}
        onClick={props.onRetry}
      >
        Try again
        {props.retrying ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
      </Button>
    </div>
  );
}

/**
 * Settings → Link a phone, confirm-gated. Shows the rotating public code
 * (QR + typeable text); when a phone claims it the QR swaps for an
 * Approve/Reject confirmation carrying the claimant's server-observed
 * metadata. Approval — never the scan — is what signs the phone in, and it
 * releases the session only to the claimant the user just reviewed.
 *
 * The server enforces ONE live code per user: each mint atomically
 * supersedes the previous unclaimed record, and minting is refused while a
 * claim awaits this decision — so the displayed code is the only one that
 * can ever be claimed, and the panel watches exactly it.
 */
export function LinkPhonePanel() {
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const [approvedDone, setApprovedDone] = useState(false);
  /**
   * The code whose decision never landed, or `null`. Stored by CODE rather
   * than as a flag: a bare boolean survives the claim it described, so the
   * next phone's confirmation card would open already complaining about a
   * failure that belonged to the previous one.
   */
  const [respondFailedCode, setRespondFailedCode] = useState<string | null>(
    null,
  );
  /**
   * What the OTHER surface decided, when this one's answer arrived second.
   *
   * The server is idempotent per DIRECTION: repeating a decision is 200, and
   * the opposite decision is 409 `already_decided` (authn's respond route).
   * So `already-decided` never means "your answer was applied" - it means the
   * other answer won, and which one it was is the inverse of what was just
   * clicked. Approving a claim the CLI already rejected must not report a
   * phone signed in.
   */
  const [decidedElsewhere, setDecidedElsewhere] = useState<
    "approved" | "rejected" | null
  >(null);
  const respond = useRespondLinkLoginMutation();
  const {
    claim: watchedClaim,
    code,
    deadKind,
    restart: restartCode,
  } = useLinkLoginWatch(signedIn && !approvedDone);

  /**
   * A code this panel has already answered for.
   *
   * `restartCode()` evicts the MINT query, not the status cache, so a claim
   * the user just rejected stays in cached status data until the next poll -
   * up to the poll interval of a fully interactive Approve/Reject card for a
   * decision already made. A second Approve on it comes back
   * `already-decided`, which this panel reads as approval and would show a
   * "signed in" state for a phone the user rejected.
   */
  const [decidedCode, setDecidedCode] = useState<string | null>(null);
  const claim =
    watchedClaim !== null && watchedClaim.code === decidedCode
      ? null
      : watchedClaim;
  const minted = code.data ?? null;
  // `claim-pending` is a state, not an error: the user's single live claim
  // is awaiting the decision on ANOTHER surface. Rendered only when this
  // panel has no live code of its own (nothing minted yet, or its code is
  // dead) — with a live displayed code the pending claim may be THIS code's
  // own scan racing the rotation mint, and the next status poll surfaces it
  // as the confirm card; flashing "elsewhere" for it would be wrong.
  const awaitingElsewhere =
    code.isError &&
    code.error instanceof LinkLoginMintError &&
    code.error.kind === "claim-pending" &&
    (minted === null || deadKind !== null);

  const resumeAfterApproval = () => {
    setApprovedDone(false);
    // The approved code was consumed; its cache entry must not be re-served.
    restartCode();
  };

  /**
   * "Show a new code", from every terminal card.
   *
   * Clears the PRESENTATION state that made a terminal card render, before
   * the re-mint. `restartCode()` alone only evicts the mint query, and these
   * cards replaced the controls that would otherwise have cleared it - so a
   * terminal card would sit on screen over a code already replaced behind it,
   * with no way back except unmounting the panel.
   *
   * `decidedCode` is deliberately NOT cleared. It is not presentation state:
   * it is what keeps the answered claim suppressed while the status cache
   * still holds it, and the polls are two seconds apart. Clearing it here
   * would resurrect the spent claim with live Approve/Reject controls for
   * that window. It needs no clearing anyway - it names a code, so it retires
   * itself the moment a different one is watched.
   */
  const showNewCode = () => {
    setDecidedElsewhere(null);
    setRespondFailedCode(null);
    restartCode();
  };

  const decide = (approve: boolean) => {
    if (claim === null) {
      return;
    }
    setRespondFailedCode(null);
    setDecidedElsewhere(null);
    const decidedOn = claim.code;
    respond.mutate(
      { code: decidedOn, approve },
      {
        onSuccess: (outcome) => {
          if (approve && outcome === "ok") {
            setApprovedDone(true);
            return;
          }
          if (outcome === "already-decided") {
            // The opposite decision reached the server first. Report what
            // actually happened to the phone - the inverse of this click -
            // and retire the code; it is spent either way.
            setDecidedElsewhere(approve ? "rejected" : "approved");
            setDecidedCode(decidedOn);
            restartCode();
            return;
          }
          if (outcome === "failed") {
            // The decision never reached the server, so the claim is still
            // sitting there waiting for it. Restarting here would answer a
            // network problem by silently replacing the QR - the user tapped
            // Approve and got a different code back, with nothing said. Keep
            // the card, say what happened, let them tap again.
            setRespondFailedCode(decidedOn);
            return;
          }
          // Rejected (or the record vanished): resume with a fresh code.
          // The user's own click authorizes the re-mint; the evicting
          // restart guarantees the dead code cannot be re-served from cache.
          // Suppressed locally FIRST, because the restart does not reach the
          // status cache the claim card reads from.
          setDecidedCode(decidedOn);
          restartCode();
        },
        onError: () => {
          setRespondFailedCode(decidedOn);
        },
      },
    );
  };

  return (
    <SettingsPanelShell
      title="Link a phone"
      description="Sign the Traycer mobile app in by scanning this code. A scan on its own signs nothing in — every phone waits here for your approval first."
    >
      <div className="flex flex-col items-center gap-6 p-6">
        <LinkPhonePanelBody
          signedIn={signedIn}
          approvedDone={approvedDone}
          claim={claim}
          awaitingElsewhere={awaitingElsewhere}
          deadKind={deadKind}
          minted={minted}
          respondFailed={claim !== null && claim.code === respondFailedCode}
          decidedElsewhere={decidedElsewhere}
          code={{
            isError: code.isError,
            isRefetching: code.isRefetching,
            error: code.error,
            refetch: () => {
              void code.refetch();
            },
          }}
          respondVerdict={pendingRespondVerdict(
            respond.isPending,
            respond.variables,
          )}
          onDecide={decide}
          onRestart={resumeAfterApproval}
          onShowNew={showNewCode}
        />
      </div>
    </SettingsPanelShell>
  );
}

interface PanelCodeView {
  readonly isError: boolean;
  readonly isRefetching: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

function LinkPhonePanelBody(props: {
  readonly signedIn: boolean;
  readonly approvedDone: boolean;
  readonly claim: LiveClaim | null;
  readonly awaitingElsewhere: boolean;
  readonly deadKind: LinkLoginDeadKind | null;
  readonly minted: MintLinkLoginCodeResponse | null;
  readonly code: PanelCodeView;
  readonly respondVerdict: PendingVerdict;
  /** A decision the transport lost; the claim is still live and retryable. */
  readonly respondFailed: boolean;
  /** What another surface decided, when this one's answer arrived second. */
  readonly decidedElsewhere: "approved" | "rejected" | null;
  readonly onDecide: (approve: boolean) => void;
  readonly onRestart: () => void;
  /** The evicting restart — the ONLY way a dead code is replaced. */
  readonly onShowNew: () => void;
}) {
  if (!props.signedIn) {
    return (
      <p className="text-ui-sm text-muted-foreground">
        Sign in on this device first — a linked phone signs in to this account.
      </p>
    );
  }
  if (props.approvedDone) {
    return <ApprovedCard onRestart={props.onRestart} />;
  }
  // Ahead of the claim card and of `approvedDone`: this outcome means the
  // decision on screen was NOT the one that took effect, so continuing to
  // offer it - or reporting success for it - would be describing something
  // that did not happen.
  if (props.decidedElsewhere !== null) {
    return (
      <DecidedElsewhereCard
        decision={props.decidedElsewhere}
        retrying={props.code.isRefetching}
        onShowNew={props.onShowNew}
      />
    );
  }
  if (props.claim !== null) {
    return (
      <ConfirmClaimCard
        claim={props.claim}
        pendingVerdict={props.respondVerdict}
        respondFailed={props.respondFailed}
        onDecide={props.onDecide}
      />
    );
  }
  // Before the retained mint data: a dead QR must never render while the
  // real claim waits elsewhere, or after another surface superseded it.
  if (props.awaitingElsewhere) {
    return <AwaitingElsewhereCard />;
  }
  if (props.deadKind !== null) {
    return (
      <SupersededCard
        kind={props.deadKind}
        retrying={props.code.isRefetching}
        onShowNew={props.onShowNew}
      />
    );
  }
  if (props.minted !== null) {
    return <ShowingCard minted={props.minted} />;
  }
  if (props.code.isError) {
    return (
      <MintErrorCard
        message={
          props.code.error instanceof Error
            ? props.code.error.message
            : "Could not create a link code."
        }
        retrying={props.code.isRefetching}
        onRetry={props.code.refetch}
      />
    );
  }
  return <PendingCodeCard />;
}
