import { useState, type ReactNode } from "react";
import { AlertTriangle, FileUp, Search } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
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
import { Switch } from "@/components/ui/switch";
import { useLoginImportPickFile } from "@/hooks/browser/use-login-import-pick-file-mutation";
import { useLoginImportRun } from "@/hooks/browser/use-login-import-run-mutation";
import { useLoginImportScanQuery } from "@/hooks/browser/use-login-import-scan-query";
import { useLoginImportSourcesQuery } from "@/hooks/browser/use-login-import-sources-query";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { formatRelativeTimestamp, useSampledNow } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import type {
  BrowserViewBridge,
  LoginImportBlocked,
  LoginImportBrowser,
  LoginImportResult,
  LoginImportScan,
  LoginImportSource,
  LoginImportUnlock,
} from "@traycer-clients/shared/platform/browser-view";

/**
 * Settings › Browser › Saved logins › "Import logins from another browser".
 *
 * Three steps in one dialog, each backed by one bridge call:
 *
 * 1. **Pick** a browser profile or a cookie file. Listing prompts for
 *    nothing.
 * 2. **Choose sites.** The scan is metadata-only on the desktop, so this step
 *    renders before any OS prompt has fired - and it is where the dialog says
 *    which prompt the Import click will raise, and what cannot be imported
 *    and why (Google's device-bound sessions, Windows' app-bound cookies,
 *    cookies scoped to embedded contexts).
 * 3. **Done.** Honest counts from the desktop, and how far the jar main
 *    pushed afterwards actually reached: the hosts that ACKED it, never
 *    "saved", because a host acks a jar it may still decide to drop.
 *
 * Every failure arrives as a result value with a closed reason, and each
 * reason has one explainer the user can act on. Nothing here retries on its
 * own: a retry after a denied Keychain prompt is a second prompt.
 */

type ImportStep =
  | { readonly kind: "pick" }
  | { readonly kind: "choose"; readonly source: LoginImportSource }
  | {
      readonly kind: "done";
      readonly source: LoginImportSource;
      readonly result: LoginImportResult;
    };

const BROWSER_LABELS: Readonly<Record<LoginImportBrowser, string>> = {
  chrome: "Google Chrome",
  chromium: "Chromium",
  edge: "Microsoft Edge",
  brave: "Brave",
  arc: "Arc",
  vivaldi: "Vivaldi",
  opera: "Opera",
  firefox: "Firefox",
  safari: "Safari",
  file: "Cookie file",
};

const FULL_DISK_ACCESS_PANE =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

export function ImportLoginsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly browserView: BrowserViewBridge;
}): ReactNode {
  const [step, setStep] = useState<ImportStep>({ kind: "pick" });
  const importRun = useLoginImportRun(props.browserView);
  const pending = importRun.isPending;
  // Closing is refused while an import is in flight: the desktop is mid-write
  // (and may be showing a Keychain prompt), and the Done step is where the
  // outcome will land. The steps reset so the next open starts at Pick.
  const close = (): void => {
    if (pending) return;
    setStep({ kind: "pick" });
    importRun.reset();
    props.onOpenChange(false);
  };
  const renderStep = (): ReactNode => {
    if (step.kind === "pick") {
      return (
        <PickStep
          browserView={props.browserView}
          enabled={props.open}
          onPick={(source) => {
            setStep({ kind: "choose", source });
          }}
        />
      );
    }
    if (step.kind === "choose") {
      const source = step.source;
      return (
        <ChooseStep
          browserView={props.browserView}
          source={source}
          pending={pending}
          onBack={() => {
            importRun.reset();
            setStep({ kind: "pick" });
          }}
          onImport={(choice) => {
            importRun.mutate(
              {
                sourceId: source.id,
                domains: choice.domains,
                includeDeviceBound: choice.includeDeviceBound,
              },
              {
                onSuccess: (result) => {
                  setStep({ kind: "done", source, result });
                },
              },
            );
          }}
        />
      );
    }
    return (
      <DoneStep
        source={step.source}
        result={step.result}
        onRetry={() => {
          importRun.reset();
          setStep({ kind: "choose", source: step.source });
        }}
        onClose={close}
      />
    );
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        showCloseButton={!pending}
        className="w-[min(92vw,34rem)] sm:max-w-lg"
        data-testid="import-logins-dialog"
      >
        {renderStep()}
      </DialogContent>
    </Dialog>
  );
}

function PickStep(props: {
  readonly browserView: BrowserViewBridge;
  readonly enabled: boolean;
  readonly onPick: (source: LoginImportSource) => void;
}): ReactNode {
  const sources = useLoginImportSourcesQuery({
    browserView: props.browserView,
    enabled: props.enabled,
  });
  const pickFile = useLoginImportPickFile(props.browserView);
  const now = useSampledNow();
  const listed = sources.data ?? [];
  return (
    <>
      <DialogHeader>
        <DialogTitle>Import logins from another browser</DialogTitle>
        <DialogDescription>
          Choose a browser profile. Traycer reads which sites it has logins for;
          nothing is imported until you confirm.
        </DialogDescription>
      </DialogHeader>
      <div className="flex max-h-[min(50vh,22rem)] min-h-0 flex-col gap-1 overflow-y-auto">
        {sources.isPending ? (
          <p className="flex items-center gap-2 py-2 text-muted-foreground">
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
            Looking for browsers on this machine
          </p>
        ) : null}
        {sources.isError ? (
          <p className="py-2 text-destructive">
            Couldn't list the browsers on this machine. You can still import a
            cookie file.
          </p>
        ) : null}
        {sources.isSuccess && listed.length === 0 ? (
          <p className="py-2 text-muted-foreground">
            No browser profiles were found on this machine. You can import a
            cookie file instead.
          </p>
        ) : null}
        {listed.map((source) => (
          <button
            key={source.id}
            type="button"
            className="flex w-full min-w-0 items-center justify-between gap-3 rounded-md px-3 py-2 text-left hover:bg-foreground/8 focus-visible:bg-foreground/8 focus-visible:outline-none"
            onClick={() => {
              props.onPick(source);
            }}
          >
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-foreground">
                {BROWSER_LABELS[source.browser]}
              </span>
              <span className="text-muted-foreground"> · </span>
              <span className="text-muted-foreground">
                {source.profileLabel}
              </span>
            </span>
            {source.lastUsedAt !== null ? (
              <span className="shrink-0 text-ui-xs text-muted-foreground">
                {formatRelativeTimestamp(source.lastUsedAt, now)}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pickFile.isPending}
          onClick={() => {
            pickFile.mutate(undefined, {
              onSuccess: (source) => {
                if (source !== null) props.onPick(source);
              },
            });
          }}
        >
          {pickFile.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : (
            <FileUp aria-hidden />
          )}
          Import from a file…
        </Button>
      </DialogFooter>
    </>
  );
}

function ChooseStep(props: {
  readonly browserView: BrowserViewBridge;
  readonly source: LoginImportSource;
  readonly pending: boolean;
  readonly onBack: () => void;
  readonly onImport: (choice: ImportChoice) => void;
}): ReactNode {
  const scan = useLoginImportScanQuery({
    browserView: props.browserView,
    sourceId: props.source.id,
  });
  // A scan that could not read the source, whether the desktop said so with
  // a reason or the IPC itself failed. Either way the checklist is replaced
  // by an explainer and the footer offers Back and Try again.
  const blocked =
    scan.isError || (scan.isSuccess && scan.data.blocked !== null);
  const renderScan = (): ReactNode => {
    if (scan.isPending) {
      return (
        <p className="flex items-center gap-2 py-2 text-muted-foreground">
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
          Reading which sites have logins
        </p>
      );
    }
    if (scan.isError) return <BlockedExplainer reason="unreadable" />;
    if (scan.data.blocked !== null) {
      return <BlockedExplainer reason={scan.data.blocked} />;
    }
    return (
      <SiteChecklist
        scan={scan.data}
        browser={props.source.browser}
        pending={props.pending}
        onImport={props.onImport}
        onBack={props.onBack}
      />
    );
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          Choose sites from {BROWSER_LABELS[props.source.browser]} ·{" "}
          {props.source.profileLabel}
        </DialogTitle>
        <DialogDescription>
          Traycer signs its browser into the sites you keep. A site already
          signed in here is replaced by the imported login.
        </DialogDescription>
      </DialogHeader>
      {renderScan()}
      {blocked ? (
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onBack}
          >
            Back
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void scan.refetch();
            }}
          >
            Try again
          </Button>
        </DialogFooter>
      ) : null}
    </>
  );
}

/** What the Import button hands up: the ticked domains and the Google opt-in. */
interface ImportChoice {
  readonly domains: readonly string[];
  readonly includeDeviceBound: boolean;
}

function SiteChecklist(props: {
  readonly scan: LoginImportScan;
  readonly browser: LoginImportBrowser;
  readonly pending: boolean;
  readonly onImport: (choice: ImportChoice) => void;
  readonly onBack: () => void;
}): ReactNode {
  const [filter, setFilter] = useState("");
  // Unticked rather than ticked: every site starts selected, so the state
  // is the exceptions and a fresh scan never has to be copied into it.
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  // Off by default and never remembered: Google binds its sessions to the
  // device, so an imported one can end on its own. Turning this on moves the
  // Google rows from the disabled tail into the checklist, ticked like any
  // other site, and the request carries the opt-in so the desktop honours
  // them; turning it off again drops them from the count and the request.
  const [includeDeviceBound, setIncludeDeviceBound] = useState(false);
  const deviceBound = new Set(props.scan.excluded.map((site) => site.domain));
  const sites = includeDeviceBound
    ? [...props.scan.sites, ...props.scan.excluded]
    : props.scan.sites;
  const selected = sites.filter((site) => !unticked.has(site.domain));
  const needle = filter.trim().toLowerCase();
  const visible =
    needle.length === 0
      ? sites
      : sites.filter((site) => site.domain.includes(needle));
  const visibleExcluded = includeDeviceBound
    ? []
    : props.scan.excluded.filter(
        (site) => needle.length === 0 || site.domain.includes(needle),
      );
  const toggle = (domain: string, checked: boolean): void => {
    setUnticked((current) => {
      const next = new Set(current);
      if (checked) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };
  return (
    <>
      {props.scan.protectedCookieCount > 0 ? (
        <Notice tone="warning">
          {props.scan.protectedCookieCount}{" "}
          {props.scan.protectedCookieCount === 1 ? "login is" : "logins are"}{" "}
          protected by the browser on Windows and can't be imported. Export them
          with a cookie extension and import the file, or sign in once inside
          Traycer.
        </Notice>
      ) : null}
      {sites.length === 0 && props.scan.excluded.length === 0 ? (
        <p className="py-2 text-muted-foreground">
          This profile has no logins Traycer can import.
        </p>
      ) : (
        <>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={filter}
              placeholder="Filter sites"
              aria-label="Filter sites"
              className="pl-8"
              onChange={(event) => {
                setFilter(event.target.value);
              }}
            />
          </div>
          <div className="flex items-center justify-between text-ui-xs text-muted-foreground">
            <span>
              {selected.length} of {sites.length} sites selected
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                className="underline-offset-2 hover:underline"
                onClick={() => {
                  setUnticked(new Set());
                }}
              >
                Select all
              </button>
              <button
                type="button"
                className="underline-offset-2 hover:underline"
                onClick={() => {
                  setUnticked(new Set(sites.map((site) => site.domain)));
                }}
              >
                Select none
              </button>
            </span>
          </div>
          <ul className="flex max-h-[min(40vh,18rem)] min-h-0 flex-col gap-0.5 overflow-y-auto">
            {visible.map((site) => (
              <li key={site.domain}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-foreground/5">
                  <Checkbox
                    checked={!unticked.has(site.domain)}
                    disabled={props.pending}
                    aria-label={`Import logins for ${site.domain}`}
                    onCheckedChange={(checked) => {
                      toggle(site.domain, checked === true);
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                    {site.domain}
                  </span>
                  <span className="shrink-0 text-ui-xs text-muted-foreground">
                    {deviceBound.has(site.domain) ? "device-bound · " : null}
                    {site.cookieCount}{" "}
                    {site.cookieCount === 1 ? "cookie" : "cookies"}
                  </span>
                </label>
              </li>
            ))}
            {visibleExcluded.map((site) => (
              <li key={site.domain}>
                <label className="flex items-center gap-2.5 rounded-md px-2 py-1.5 opacity-60">
                  <Checkbox
                    checked={false}
                    disabled
                    aria-label={`${site.domain} can't be imported`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                    {site.domain}
                  </span>
                  <span className="shrink-0 text-ui-xs text-muted-foreground">
                    device-bound
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {props.scan.excluded.length > 0 ? (
        <DeviceBoundOptIn
          enabled={includeDeviceBound}
          pending={props.pending}
          onChange={(next) => {
            setIncludeDeviceBound(next);
            // A fresh opt-in starts with every Google row ticked, the same
            // as a fresh scan; turning it off forgets any unticks among them
            // so the next opt-in starts clean too.
            setUnticked((current) => {
              const rest = [...current].filter(
                (domain) => !deviceBound.has(domain),
              );
              return new Set(rest);
            });
          }}
        />
      ) : null}
      {props.scan.partitionedCookieCount > 0 ? (
        <p className="text-ui-xs text-muted-foreground">
          {props.scan.partitionedCookieCount}{" "}
          {props.scan.partitionedCookieCount === 1 ? "cookie" : "cookies"}{" "}
          scoped to embedded contexts{" "}
          {props.scan.partitionedCookieCount === 1 ? "is" : "are"} left out.
        </p>
      ) : null}
      <UnlockExplainer unlock={props.scan.unlock} browser={props.browser} />
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={props.pending}
          onClick={props.onBack}
        >
          Back
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={props.pending || selected.length === 0}
          onClick={() => {
            props.onImport({
              domains: selected.map((site) => site.domain),
              includeDeviceBound,
            });
          }}
          data-testid="import-logins-confirm"
        >
          {props.pending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Import {selected.length} {selected.length === 1 ? "site" : "sites"}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * The Google opt-in (decision: off by default, never remembered). The
 * exclusion is the safe default because Google binds its sessions to the
 * device with a key the import cannot copy, so a transplanted session can end
 * at Google's next check. The toggle exists because that check is not yet
 * universal and a user who knows the trade-off may prefer minutes of a
 * working Gmail to signing in again; the warning names what they are
 * accepting, in the same breath as the switch.
 */
function DeviceBoundOptIn(props: {
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly onChange: (next: boolean) => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 text-ui-sm">
        <span className="text-foreground">Import Google logins anyway</span>
        <Switch
          checked={props.enabled}
          disabled={props.pending}
          aria-label="Import Google logins anyway"
          onCheckedChange={props.onChange}
        />
      </div>
      {props.enabled ? (
        <Notice tone="warning">
          Google binds sign-ins to the device they were made on. An imported
          Google login can stop working at any moment, and may also sign you out
          of Google in the browser it came from. If it does, sign in to Google
          inside Traycer instead.
        </Notice>
      ) : (
        <p className="text-ui-xs text-muted-foreground">
          Google accounts are left out: Google binds sign-ins to the device they
          were made on. Sign in to Google inside Traycer once, or import them
          anyway and accept that they can stop working.
        </p>
      )}
    </div>
  );
}

/**
 * Which OS prompt the Import click raises, said BEFORE it fires. Windows'
 * DPAPI unseals silently, so there is nothing to warn about there.
 */
function UnlockExplainer(props: {
  readonly unlock: LoginImportUnlock | null;
  readonly browser: LoginImportBrowser;
}): ReactNode {
  if (props.unlock === "macos-keychain") {
    return (
      <Notice tone="info">
        macOS will ask whether "security" may read{" "}
        {BROWSER_LABELS[props.browser]}'s key from your keychain. Click{" "}
        <span className="font-medium">Allow</span>, not Always Allow.
      </Notice>
    );
  }
  if (props.unlock === "linux-keyring") {
    return (
      <Notice tone="info">
        Your keyring may ask to be unlocked so Traycer can read{" "}
        {BROWSER_LABELS[props.browser]}'s key.
      </Notice>
    );
  }
  return null;
}

function DoneStep(props: {
  readonly source: LoginImportSource;
  readonly result: LoginImportResult;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}): ReactNode {
  const result = props.result;
  if (result.status === "blocked") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Nothing was imported</DialogTitle>
        </DialogHeader>
        <BlockedExplainer reason={result.reason} />
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onClose}
          >
            Close
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onRetry}
          >
            Try again
          </Button>
        </DialogFooter>
      </>
    );
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Logins imported</DialogTitle>
        <DialogDescription>{describeImported(result)}</DialogDescription>
      </DialogHeader>
      <ul className="flex flex-col gap-1 text-muted-foreground">
        <li>{describePush(result.notifiedHosts)}</li>
        <li>Reload open browser tabs to use the imported logins.</li>
        {result.skippedInvalid > 0 ? (
          <li>
            {result.skippedInvalid}{" "}
            {result.skippedInvalid === 1 ? "cookie" : "cookies"} couldn't be
            written and {result.skippedInvalid === 1 ? "was" : "were"} left out.
          </li>
        ) : null}
      </ul>
      <DialogFooter>
        <Button type="button" size="sm" onClick={props.onClose}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

function describeImported(
  result: Extract<LoginImportResult, { readonly status: "imported" }>,
): string {
  const sites = `${result.importedSites} ${result.importedSites === 1 ? "site" : "sites"}`;
  const cookies = `${result.importedCookies} ${result.importedCookies === 1 ? "cookie" : "cookies"}`;
  const replaced =
    result.replacedSites > 0
      ? `, replacing the logins this machine already had for ${result.replacedSites} of them`
      : "";
  return `Signed in to ${sites} on this machine (${cookies})${replaced}.`;
}

/**
 * How far main's push got, counted in hosts that ACKED the jar. Zero is the
 * ordinary opportunistic outcome - no host has a live browser stream right now
 * - and says so rather than reading as a failure: the logins are on this
 * machine either way, and the next capture carries them.
 */
function describePush(notifiedHosts: number): string {
  if (notifiedHosts === 0) {
    return "Saved on this machine. Hosts pick it up at the next capture.";
  }
  const hosts = `${notifiedHosts} ${notifiedHosts === 1 ? "host" : "hosts"}`;
  return `Sent to ${hosts}. Hosts apply it when they next open a browser session.`;
}

/**
 * One explainer per closed reason, each naming the thing the user can do.
 * Full Disk Access gets a deep link: the pane lists Traycer only after a
 * denied attempt, which the scan that produced this reason just made.
 */
function BlockedExplainer(props: {
  readonly reason: LoginImportBlocked | "keychain-denied" | "saved-logins-off";
}): ReactNode {
  const openExternal = useRunnerOpenExternalLink();
  switch (props.reason) {
    case "needs-full-disk-access":
      return (
        <Notice tone="warning">
          <p>
            Safari's cookies are protected by macOS. Grant Traycer Full Disk
            Access under System Settings › Privacy &amp; Security, then try
            again. If Traycer isn't listed, add it with the + button.
          </p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="mt-2"
            disabled={openExternal.isPending}
            onClick={() => {
              openExternal.mutate(FULL_DISK_ACCESS_PANE);
            }}
          >
            Open Full Disk Access settings
          </Button>
        </Notice>
      );
    case "browser-locked":
      return (
        <Notice tone="warning">
          The browser is holding its cookie database. Quit it fully - it keeps
          running in the background after its last window closes - and try
          again.
        </Notice>
      );
    case "keyring-unavailable":
      return (
        <Notice tone="warning">
          The browser's encryption key isn't available in this machine's
          keyring, so its cookies can't be decrypted. Export them with a cookie
          extension and import the file instead.
        </Notice>
      );
    case "keychain-denied":
      return (
        <Notice tone="warning">
          macOS didn't let Traycer read the browser's key. Try again and click
          Allow in the Keychain prompt.
        </Notice>
      );
    case "saved-logins-off":
      return (
        <Notice tone="warning">
          Turn on "Save website logins on this machine" first; imported logins
          go into the saved jar.
        </Notice>
      );
    case "unreadable":
      return (
        <Notice tone="warning">
          Traycer couldn't read this source. Try another profile, or export the
          cookies with an extension and import the file.
        </Notice>
      );
  }
}

function Notice(props: {
  readonly tone: "info" | "warning";
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      role={props.tone === "warning" ? "alert" : "note"}
      className={cn(
        "flex items-start gap-2 rounded-md px-3 py-2 text-ui-sm",
        props.tone === "warning"
          ? "bg-warning/10 text-foreground"
          : "bg-foreground/5 text-muted-foreground",
      )}
    >
      {props.tone === "warning" ? (
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-warning"
          aria-hidden
        />
      ) : null}
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}
