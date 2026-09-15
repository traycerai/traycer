import { useEffect, useMemo, type ReactNode } from "react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSurfaceReadiness } from "@/components/layout/host-readiness-controller-context";
import { WelcomeConnecting } from "@/components/onboarding/welcome/welcome-connecting";
import { WelcomeProvidersPage } from "@/components/onboarding/welcome/welcome-providers-page";
import { WelcomeSessionsPage } from "@/components/onboarding/welcome/welcome-sessions-page";
import {
  buildWelcomeSessionsView,
  welcomeSessionsBranch,
} from "@/components/onboarding/welcome/welcome-sessions-model";
import {
  useWelcomeHostImportRun,
  type WelcomeHostImportRun,
} from "@/components/onboarding/welcome/use-welcome-host-import-run";
import {
  useWelcomeScan,
  type WelcomeScan,
} from "@/components/onboarding/welcome/use-welcome-scan";
import { useWelcomeRoster } from "@/components/onboarding/welcome/use-welcome-roster";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { useStreamRuntimeBinding } from "@/lib/host/stream-runtime-context";
import { useOnboardingFlowStore } from "@/stores/onboarding/onboarding-flow-store";
import type { OnboardingBranch } from "@/stores/onboarding/onboarding-tour-catalog";
import { useOnboardingPresenceStore } from "@/stores/onboarding/onboarding-presence-store";
import {
  sessionImportIsRunning,
  useSessionImportRun,
} from "@/stores/session-import/session-import-run-store";

const NO_PROVIDERS: ReadonlyArray<ProviderId> = [];

type WelcomeModalPage = 1 | 2;

/** The taxonomy spells the page as a string enum, not a tally. */
function analyticsPage(page: WelcomeModalPage): "1" | "2" {
  return page === 1 ? "1" : "2";
}

/**
 * The first-run welcome modal: an 80vw × 80vh dialog over whatever route the
 * app opened on, with two pages - providers, then the sessions the scan found
 * for them.
 *
 * Three exits, three store actions, no local close state: Esc PAUSES
 * (`pauseModal`; the flow host hides the modal for this session and it
 * reopens next launch on the same page), Skip and Continue FINISH
 * (`skipModal` / `finishModal(branch)`), after which `modal` leaves
 * `pending | in-progress` and the flow host unmounts this. An outside click
 * does nothing at all - a modal that closes under a stray click is one the
 * user has to find their way back to.
 *
 * The scan is started HERE rather than on page 2, and from the moment the
 * modal opens: the sessions page should be filled in by the time the user
 * reaches it, and switching pages must not restart it.
 */
export function WelcomeModal(props: {
  /** Esc: the flow host records the dismissal for this session. */
  readonly onPaused: () => void;
}): ReactNode {
  const { onPaused } = props;
  const modalPage = useOnboardingFlowStore((state) => state.modalPage);
  const setModalPage = useOnboardingFlowStore((state) => state.setModalPage);
  const pauseModal = useOnboardingFlowStore((state) => state.pauseModal);
  const finishModal = useOnboardingFlowStore((state) => state.finishModal);
  const skipModal = useOnboardingFlowStore((state) => state.skipModal);
  const setModalOpen = useOnboardingPresenceStore(
    (state) => state.setModalOpen,
  );

  // Once, on mount: a fresh install moves `pending` → `in-progress`; a
  // launch that rehydrated `in-progress` (paused on a page) is left alone,
  // page included.
  useEffect(() => {
    const flow = useOnboardingFlowStore.getState();
    if (flow.modal === "pending") flow.startModal();
  }, []);

  // Presence, for the ambient surfaces that hold while this is up.
  useEffect(() => {
    setModalOpen(true);
    return () => {
      setModalOpen(false);
    };
  }, [setModalOpen]);

  // The frame shows before the host is up; the pages wait for it. Both the
  // readiness verdict AND a named stream host are required - the scan and,
  // later, the import run are aimed at the stream binding, and a `ready`
  // verdict with no host to stream from is the gap between a host swap and
  // the effect that rebuilds the binding.
  const readiness = useSurfaceReadiness("default-host", null);
  const streamBinding = useStreamRuntimeBinding();
  const streamHostId = streamBinding?.hostId ?? null;
  const hostReady = readiness.kind === "ready" && streamHostId !== null;

  const roster = useWelcomeRoster();
  const { providers } = roster;
  const enabledProviderIds = useMemo(
    () =>
      providers === undefined
        ? NO_PROVIDERS
        : providers
            .filter((provider) => provider.enabled)
            .map((provider) => provider.providerId),
    [providers],
  );
  const welcomeScan = useWelcomeScan({ open: true, enabledProviderIds });
  // Page 2's import-status probe, held here because the header reads it too.
  const hostImportRun = useWelcomeHostImportRun(
    streamBinding,
    hostReady && modalPage === 2,
  );
  // Page 1 has no probe of its own, but the run controller fills this slice
  // the moment it attaches to a run already in flight on connect - so a run
  // it knows about is the one fact page 1 can read without a second RPC.
  const runInFlight = sessionImportIsRunning(useSessionImportRun(streamHostId));
  // The "untick" hint describes ticked rows on screen, so it is true only
  // while page 2 is showing the LIST - not the already-running notice, the
  // scanning line or the empty state - and at least one row is ticked.
  // Same branch function the page renders from, so the two cannot drift.
  const sessionsView = useMemo(
    () => buildWelcomeSessionsView(welcomeScan.scan.state),
    [welcomeScan.scan.state],
  );
  const somethingToUntick =
    welcomeSessionsBranch({
      alreadyRunning: hostImportRun.alreadyRunning,
      support: welcomeScan.support,
      phase: welcomeScan.scan.state.phase,
      view: sessionsView,
    }) === "list" && sessionsView.selectedCount > 0;

  const skip = (): void => {
    Analytics.getInstance().track(AnalyticsEvent.OnboardingModalSkipped, {
      page: analyticsPage(modalPage),
    });
    skipModal();
  };

  const continueFromProviders = (): void => {
    // The page disables Continue until the roster has settled (resolved,
    // not mid-refresh, not in error, every toggle refreshed into it); this
    // is the same fact read at the moment of the click, so a click that
    // raced the query cannot finish the modal on an empty or stale roster.
    if (providers === undefined || !roster.settled) return;
    Analytics.getInstance().track(AnalyticsEvent.OnboardingModalContinued, {
      page: "1",
      enabled_provider_count: enabledProviderIds.length,
      session_count: welcomeScan.importableCount,
    });
    if (
      welcomeBranchAfterProviders(welcomeScan, runInFlight) === "no-sessions"
    ) {
      finishModal("no-sessions");
      return;
    }
    setModalPage(2);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Radix routes Esc here; outside interaction is prevented below, so
        // this is the pause gesture and nothing else.
        if (open) return;
        pauseModal();
        onPaused();
      }}
    >
      <DialogContent
        data-testid="welcome-modal"
        showCloseButton={false}
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
        // An unmodified `max-w-*` displaces the primitive's safe-area cap by
        // design (see `dialog.tsx`), so the cap is composed back in: the
        // smaller of 80vw and the safe region, at both breakpoints. Fluid:
        // both axes are viewport fractions.
        className="flex h-[80vh] w-[80vw] max-w-[min(80vw,var(--safe-area-width))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(80vw,var(--safe-area-width))]"
      >
        <WelcomeModalHeader
          page={modalPage}
          hostReady={hostReady}
          somethingToUntick={somethingToUntick}
        />
        {hostReady ? (
          <WelcomeModalBody
            page={modalPage}
            welcomeScan={welcomeScan}
            hostImportRun={hostImportRun}
            onContinueFromProviders={continueFromProviders}
            onSkip={skip}
            onFinish={finishModal}
          />
        ) : (
          <WelcomeConnecting onSkip={skip} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Continue branch from page 1 (plan §Branch decision): straight to the
 * `no-sessions` tours when the host cannot scan or nothing enabled can be
 * scanned, or when the scan already finished with nothing to import; the
 * sessions page otherwise - including while the scan is still running or
 * has failed, since page 2 owns the copy for both.
 *
 * A run already in flight on the host is tested FIRST, before the scan: it
 * is importing rows onto the landing list regardless of what this scan
 * found, so the empty-scan shortcut would send the user down the
 * `no-sessions` tours with imported tasks about to appear. Page 2's
 * already-running notice is the same test in the same position, and its
 * Continue finishes as `sessions`.
 */
function welcomeBranchAfterProviders(
  welcomeScan: WelcomeScan,
  runInFlight: boolean,
): "no-sessions" | "sessions-page" {
  if (runInFlight) return "sessions-page";
  if (!welcomeScan.eligible) return "no-sessions";
  const { phase } = welcomeScan.scan.state;
  if (phase === "complete" && welcomeScan.importableCount === 0) {
    return "no-sessions";
  }
  return "sessions-page";
}

function WelcomeModalBody(props: {
  readonly page: WelcomeModalPage;
  readonly welcomeScan: WelcomeScan;
  readonly hostImportRun: WelcomeHostImportRun;
  readonly onContinueFromProviders: () => void;
  readonly onSkip: () => void;
  readonly onFinish: (branch: OnboardingBranch) => void;
}): ReactNode {
  const {
    page,
    welcomeScan,
    hostImportRun,
    onContinueFromProviders,
    onSkip,
    onFinish,
  } = props;
  // "Shown" is the page being ON SCREEN, so it is keyed on the page and
  // fires only from the body - the connecting state is not a page.
  useEffect(() => {
    Analytics.getInstance().track(AnalyticsEvent.OnboardingModalShown, {
      page: analyticsPage(page),
    });
  }, [page]);
  if (page === 1) {
    return (
      <WelcomeProvidersPage
        onContinue={onContinueFromProviders}
        onSkip={onSkip}
      />
    );
  }
  return (
    <WelcomeSessionsPage
      welcomeScan={welcomeScan}
      hostImportRun={hostImportRun}
      onImportStarted={() => onFinish("sessions")}
      onSkipImport={() => onFinish("no-sessions")}
      onNoSessions={() => onFinish("no-sessions")}
      onAlreadyRunningContinue={() => onFinish("sessions")}
    />
  );
}

const PAGE_COPY: Readonly<
  Record<
    WelcomeModalPage,
    { readonly title: string; readonly step: string; readonly subtitle: string }
  >
> = {
  1: {
    title: "Welcome to Traycer",
    step: "Providers",
    subtitle:
      "Turn on the coding agents you use. Traycer checks the accounts you're already signed in to.",
  },
  2: {
    title: "Bring your recent work",
    step: "Sessions",
    subtitle: "Sessions found on this machine become Traycer tasks.",
  },
};

const PAGE_COUNT = 2;
const UNTICK_HINT = "Untick anything you'd rather leave behind.";

function WelcomeModalHeader(props: {
  readonly page: WelcomeModalPage;
  readonly hostReady: boolean;
  /** Page 2 is showing its list with ticked rows, so it may say "untick". */
  readonly somethingToUntick: boolean;
}): ReactNode {
  const { page, hostReady, somethingToUntick } = props;
  // While connecting the header keeps page 1's title - it is where the user
  // lands - and says what the body is waiting on, so the dialog's accessible
  // description is never a promise about a grid that is not there yet.
  const copy = PAGE_COPY[hostReady ? page : 1];
  const subtitle =
    page === 2 && somethingToUntick
      ? `${copy.subtitle} ${UNTICK_HINT}`
      : copy.subtitle;
  return (
    <DialogHeader className="shrink-0 gap-1 px-6 pt-5 pb-3">
      <div className="flex items-start justify-between gap-4">
        <DialogTitle className="text-ui-lg">{copy.title}</DialogTitle>
        {/* "Step 1 of 2 · Providers", one phrase: the earlier
            "1 Providers · 2 Sessions" pair read as counts. */}
        <p
          data-testid="welcome-modal-step"
          className="shrink-0 text-ui-xs text-muted-foreground tabular-nums"
        >
          Step {page} of {PAGE_COUNT}
          <span aria-hidden> · </span>
          <span className="text-foreground">{copy.step}</span>
        </p>
      </div>
      <DialogDescription>
        {hostReady ? subtitle : "Connecting to your machine…"}
      </DialogDescription>
    </DialogHeader>
  );
}
