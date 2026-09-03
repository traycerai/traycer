import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowRightIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { ImportLoginsDialog } from "@/components/settings/import-logins-dialog";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  useBrowserSaveLogins,
  type BrowserSaveLoginsController,
} from "@/lib/browser-view/use-browser-save-logins";
import { useBrowserSavedLoginSitesQuery } from "@/hooks/browser/use-browser-saved-login-sites-query";
import { useHostBinding } from "@/lib/host";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { appLogger } from "@/lib/logger";
import type { BrowserViewBridge } from "@traycer-clients/shared/platform/browser-view";
import type {
  BrowserSavedLoginSite,
  BrowserSavedLoginSitesResponse,
} from "@traycer/protocol/host/browser/contracts";
import { useBrowserFocusStore } from "@/stores/settings/browser-focus-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

export function BrowserSettingsSection(): ReactNode {
  const browserDevOrigins = useSettingsStore((s) => s.browserDevOrigins);
  const removeBrowserDevOrigin = useSettingsStore(
    (s) => s.removeBrowserDevOrigin,
  );

  return (
    <>
      {/* The whole group is conditional now, not just its row: link and agent
          controls moved to Settings > Opening behavior, so with no detected
          origins the card would be a heading over an empty box. */}
      {browserDevOrigins.length > 0 ? (
        <SettingsGroup
          title="Browser"
          tone="default"
          dataTestId={undefined}
          fill={false}
        >
          <SettingsRow
            label="Detected dev origins"
            description="Terminal URLs with local hosts or explicit ports are kept for browser-origin classification."
            control={
              <BrowserDevOriginsControl
                origins={browserDevOrigins}
                onRemove={removeBrowserDevOrigin}
              />
            }
          />
        </SettingsGroup>
      ) : null}
      <BrowserSavedLoginsGroup />
    </>
  );
}

function BrowserDevOriginsControl(props: {
  readonly origins: ReadonlyArray<string>;
  readonly onRemove: (origin: string) => void;
}): ReactNode {
  return (
    <div className="flex max-w-[min(48vw,24rem)] flex-col gap-2">
      {props.origins.map((origin) => (
        <div
          key={origin}
          className="flex min-w-0 items-center justify-end gap-2 text-ui-sm"
        >
          <span className="min-w-0 truncate font-mono text-muted-foreground">
            {origin}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              props.onRemove(origin);
            }}
          >
            Remove
          </Button>
        </div>
      ))}
    </div>
  );
}

/**
 * Settings > Browser's saved-logins group (spec section 7.3, decision #26).
 * The one place a privacy-minded person sees where their website logins are
 * kept, turns them off, forgets them, and sees which sites they cover.
 *
 * Saving is silent and on by default, Chrome-style: there is nothing to
 * explain, consent to or retry, so this group is passive - a toggle, a list and
 * one destructive action.
 *
 * Host-scoped like every other host read on this page: the site list comes from
 * THIS surface's host, and clearing goes back out to the browser streams of
 * whichever hosts are live. The toggle is the odd one out on purpose - it is
 * desktop-local, per machine (decision #18), so it is read from the desktop
 * bridge rather than from any host.
 *
 * Renders nothing without a browser bridge (the web build, a host-less test
 * harness): there is no machine here whose jar this could be about. Nor
 * without a host runtime: the list is a host's own answer and both destructive
 * actions travel to hosts, so with no runtime above this group there is
 * nothing to show and no button here that could work.
 */
function BrowserSavedLoginsGroup(): ReactNode {
  const browserView = useRunnerHostOrNull()?.browserView ?? null;
  // The non-throwing accessor, deliberately: Settings panels render in shells
  // with no host runtime bound, and `useHostClient()` - which the site-list
  // query reaches - throws there rather than answering null.
  const hostBinding = useHostBinding();
  const saveLogins = useBrowserSaveLogins(browserView);
  const enabled = saveLogins.enabled;
  if (browserView === null || hostBinding === null || enabled === null) {
    return null;
  }
  return (
    <BrowserSavedLoginsRows
      browserView={browserView}
      saveLogins={saveLogins}
      enabled={enabled}
    />
  );
}

/**
 * The group's rows, in their own component so the host query lives BELOW the
 * runtime gate: the gate has to govern what renders, since a hook cannot be
 * called conditionally.
 */
function BrowserSavedLoginsRows(props: {
  readonly browserView: BrowserViewBridge;
  readonly saveLogins: BrowserSaveLoginsController;
  readonly enabled: boolean;
}): ReactNode {
  const sites = useBrowserSavedLoginSitesQuery({ enabled: true });
  const importTriggerRef = useRef<HTMLButtonElement>(null);
  const [importOpened, setImportOpened] = useState(false);
  const requested = useBrowserFocusStore((state) => state.openImportLogins);
  const consumeImportLogins = useBrowserFocusStore(
    (state) => state.consumeImportLogins,
  );
  const enabled = props.enabled;
  useEffect(() => {
    if (requested && !enabled) consumeImportLogins();
  }, [consumeImportLogins, enabled, requested]);
  const importOpen = importOpened || (requested && enabled);
  const setImportOpen = (next: boolean): void => {
    setImportOpened(next);
    if (!next && requested) consumeImportLogins();
  };

  return (
    <>
      <SettingsGroup
        title="Website sessions"
        tone="default"
        dataTestId="settings-saved-logins"
        fill={false}
      >
        <SavedLoginsToggleRow
          saveLogins={props.saveLogins}
          enabled={props.enabled}
        />
        <SavedWebsiteSessionsRow
          browserView={props.browserView}
          data={sites.data ?? null}
          loading={sites.isLoading}
          failed={sites.isError}
          enabled={props.enabled}
          importTriggerRef={importTriggerRef}
          onImport={() => {
            setImportOpen(true);
          }}
          onRefresh={() => {
            void sites.refetch();
          }}
        />
        <ImportLoginsRow
          enabled={props.enabled}
          triggerRef={importTriggerRef}
          onOpen={() => {
            setImportOpen(true);
          }}
        />
      </SettingsGroup>
      {importOpen ? (
        <ImportLoginsDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          browserView={props.browserView}
        />
      ) : null}
    </>
  );
}

/**
 * Turning saving off moves this machine's browser onto a throwaway jar: open
 * tabs reload signed out, and nothing new is kept. What is already saved is
 * left exactly where it is - that is what Forget is for - so turning it back on
 * returns to the same logins.
 */
function SavedLoginsToggleRow(props: {
  readonly saveLogins: BrowserSaveLoginsController;
  readonly enabled: boolean;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <SettingsRow
        label="Save website sessions on this computer"
        description={
          props.enabled
            ? "Keep session data from Traycer browser tabs so sites can stay signed in."
            : "Saving is paused on this computer. Existing sessions stay available to manage."
        }
        control={
          <Switch
            checked={props.enabled}
            disabled={props.saveLogins.pending}
            aria-label="Save website sessions on this computer"
            onCheckedChange={(next) => {
              if (next) {
                props.saveLogins.setEnabled(true);
                return;
              }
              setConfirming(true);
            }}
          />
        }
      />
      <ConfirmDestructiveDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Stop saving website sessions?"
        description="Open browser tabs reload signed out, and this computer stops saving new session data. Existing sessions stay available until you remove them."
        cascadeSummary={null}
        actionLabel="Stop saving"
        isPending={props.saveLogins.pending}
        blockedReason={null}
        onConfirm={() => {
          props.saveLogins.setEnabled(false);
          setConfirming(false);
        }}
      />
    </>
  );
}

function ImportLoginsRow(props: {
  readonly enabled: boolean;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onOpen: () => void;
}): ReactNode {
  const { enabled, triggerRef, onOpen } = props;
  return (
    <SettingsRow
      label="Bring in existing sessions"
      description="Choose a browser or cookie file, then review the sites before importing."
      hint={enabled ? null : "Turn on Save website sessions first."}
      control={
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          size="sm"
          disabled={!enabled}
          onClick={onOpen}
        >
          Choose source…
        </Button>
      }
    />
  );
}

/**
 * Both destructive actions are main's: it raises the native dialog, does the
 * work, and answers whether the user confirmed. This renderer only reports
 * that answer, so a rejected IPC has to read as "not confirmed" rather than
 * escape a click handler as an unhandled rejection.
 */
async function confirmedByMain(
  request: Promise<boolean>,
  failureMessage: string,
): Promise<boolean> {
  return request.catch((cause: unknown) => {
    appLogger.warn(failureMessage, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
    return false;
  });
}

const SAVED_WEBSITE_SESSIONS_DESCRIPTION =
  "Shared with connected Traycer hosts. Removing a site may sign you out there.";

function siteCountLabel(count: number): string {
  return `${count} ${count === 1 ? "site" : "sites"}`;
}

function SavedWebsiteSessionsRow(props: {
  readonly browserView: BrowserViewBridge;
  readonly data: BrowserSavedLoginSitesResponse | null;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly enabled: boolean;
  readonly importTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly onImport: () => void;
  readonly onRefresh: () => void;
}): ReactNode {
  const [cleared, setCleared] = useState<readonly string[]>([]);
  const data = props.data;
  const sites = data?.kind === "sites" ? data.sites : [];
  const activeCleared = cleared.filter((domain) =>
    sites.some((site) => site.domain === domain),
  );
  if (activeCleared.length !== cleared.length) setCleared(activeCleared);
  if (data === null) {
    if (props.loading) {
      return (
        <SavedWebsiteSessionsState
          status="Loading…"
          message={null}
          onRetry={null}
        />
      );
    }
    if (props.failed) {
      return (
        <SavedWebsiteSessionsState
          status="Unavailable"
          message="Unable to load saved website sessions. Check the host connection and try again."
          onRetry={props.onRefresh}
        />
      );
    }
    return (
      <SavedWebsiteSessionsState
        status="Unavailable"
        message="Update the connected Traycer host to view and manage saved website sessions."
        onRetry={null}
      />
    );
  }
  if (data.kind === "sealed") {
    return (
      <SavedWebsiteSessionsState
        status="Locked"
        message="Connect this desktop to unlock saved website sessions. If this computer has no system keyring, Traycer cannot encrypt them here, so they stay locked and nothing new is saved."
        onRetry={null}
      />
    );
  }

  const alphabeticalSites = sites
    .filter((site) => !activeCleared.includes(site.domain))
    .sort((first, second) => first.domain.localeCompare(second.domain));

  const removeSite = async (domain: string): Promise<boolean> => {
    const confirmed = await confirmedByMain(
      props.browserView.clearSavedLoginSite(domain),
      "[browser] clearing one saved login failed",
    );
    if (!confirmed) return false;
    setCleared((current) =>
      current.includes(domain) ? current : [...current, domain],
    );
    props.onRefresh();
    return true;
  };

  const removeAll = async (): Promise<boolean> => {
    const confirmed = await confirmedByMain(
      props.browserView.forgetLogins(),
      "[browser] clearing the browser partition failed",
    );
    if (!confirmed) return false;
    setCleared((current) => [
      ...new Set([...current, ...sites.map((site) => site.domain)]),
    ]);
    props.onRefresh();
    return true;
  };

  return (
    <SavedWebsiteSessionsManager
      sites={alphabeticalSites}
      enabled={props.enabled}
      importTriggerRef={props.importTriggerRef}
      onImport={props.onImport}
      onRemove={removeSite}
      onRemoveAll={removeAll}
    />
  );
}

function SavedWebsiteSessionsState(props: {
  readonly status: string;
  readonly message: string | null;
  readonly onRetry: (() => void) | null;
}): ReactNode {
  return (
    <div className="border-b border-border/40">
      <SettingsRow
        label="Saved website sessions"
        description={SAVED_WEBSITE_SESSIONS_DESCRIPTION}
        control={
          <span className="text-ui-sm text-muted-foreground" role="status">
            {props.status}
          </span>
        }
      />
      {props.message === null ? null : (
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-ui-sm text-muted-foreground">
          <p className="max-w-[72ch] text-pretty">{props.message}</p>
          {props.onRetry === null ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={props.onRetry}
            >
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function SavedWebsiteSessionsManager(props: {
  readonly sites: readonly BrowserSavedLoginSite[];
  readonly enabled: boolean;
  readonly importTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly onImport: () => void;
  readonly onRemove: (domain: string) => Promise<boolean>;
  readonly onRemoveAll: () => Promise<boolean>;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const searchId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const emptyImportRef = useRef<HTMLButtonElement>(null);
  const preview = props.sites.slice(0, 3);
  const hiddenCount = props.sites.length - preview.length;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = props.sites.filter((site) =>
    site.domain.toLocaleLowerCase().includes(normalizedQuery),
  );
  const disclosureLabel =
    hiddenCount > 0
      ? `View all ${hiddenCount} more sites`
      : `Manage all ${siteCountLabel(props.sites.length)}`;

  const changeOpen = (next: boolean): void => {
    setOpen(next);
    if (next) return;
    setQuery("");
    setStatus("");
  };

  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      <div className="border-b border-border/40">
        <SettingsRow
          label="Saved website sessions"
          description={SAVED_WEBSITE_SESSIONS_DESCRIPTION}
          control={
            <span className="tabular-nums text-ui-sm text-muted-foreground">
              {siteCountLabel(props.sites.length)}
            </span>
          }
        />
        {preview.length === 0 ? null : (
          <>
            <ul aria-label="First three saved sites">
              {preview.map((site) => (
                <li
                  key={site.domain}
                  className="flex min-w-0 border-b border-border/40 px-5 py-2.5 last:border-b-0"
                >
                  <span
                    className="min-w-0 break-all font-mono text-ui-sm text-foreground"
                    translate="no"
                  >
                    {site.domain}
                  </span>
                </li>
              ))}
            </ul>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-between rounded-none border-t border-border/40 px-5 py-3 text-start text-muted-foreground"
              >
                {disclosureLabel}
                <ArrowRightIcon aria-hidden="true" />
              </Button>
            </SheetTrigger>
          </>
        )}
      </div>
      <SheetContent
        side="right"
        className="gap-0 overflow-hidden data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          if (props.sites.length > 0) return;
          const fallback = props.importTriggerRef.current;
          if (fallback === null || fallback.disabled) return;
          event.preventDefault();
          fallback.focus();
        }}
      >
        <SheetHeader className="shrink-0 pe-12">
          <SheetTitle>Saved website sessions</SheetTitle>
          <SheetDescription>
            Search and remove website sessions without losing your place in
            General settings.
          </SheetDescription>
        </SheetHeader>
        <p className="mx-4 mb-4 rounded-md bg-muted/50 px-3 py-2 text-ui-sm text-muted-foreground">
          Shared collection · Removing a site may sign you out on connected
          Traycer hosts.
        </p>
        <div className="shrink-0 space-y-2 px-4 pb-4">
          <Label htmlFor={searchId}>Search saved sites</Label>
          <div className="relative">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchInputRef}
              id={searchId}
              name="saved-website-session-search"
              type="search"
              autoComplete="off"
              spellCheck={false}
              placeholder="example.com"
              className="ps-8"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
            />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col border-y border-border/60">
          <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-2 text-ui-xs text-muted-foreground">
            <span className="tabular-nums" role="status" aria-live="polite">
              {normalizedQuery.length > 0
                ? `${matches.length} of ${siteCountLabel(props.sites.length)}`
                : siteCountLabel(props.sites.length)}
            </span>
            <span>A–Z</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {matches.length > 0 ? (
              <ul aria-label="Saved website sessions" className="px-2 pb-2">
                {matches.map((site) => (
                  <li
                    key={site.domain}
                    className="flex min-w-0 items-center gap-4 border-t border-border/40 px-2 py-2 first:border-t-0"
                  >
                    <span
                      className="min-w-0 flex-1 break-all font-mono text-ui-sm text-foreground"
                      translate="no"
                    >
                      {site.domain}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Remove saved website session for ${site.domain}`}
                      onClick={() => {
                        void props.onRemove(site.domain).then((removed) => {
                          if (!removed) return;
                          setStatus("Website session removed.");
                          requestAnimationFrame(() => {
                            searchInputRef.current?.focus();
                          });
                        });
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {matches.length === 0 && props.sites.length === 0 ? (
              <div className="grid min-h-full place-items-center px-6 py-8 text-center">
                <div className="max-w-[46ch]">
                  <h3 className="font-medium text-foreground">
                    No saved website sessions
                  </h3>
                  <p className="mt-1 text-pretty text-ui-sm text-muted-foreground">
                    {props.enabled
                      ? "Bring in sessions from another browser, or save new ones as you browse."
                      : "Turn on Save website sessions to import. Existing sessions will remain available when saving resumes."}
                  </p>
                  <Button
                    ref={emptyImportRef}
                    type="button"
                    variant="outline"
                    className="mt-4"
                    disabled={!props.enabled}
                    onClick={() => {
                      changeOpen(false);
                      requestAnimationFrame(props.onImport);
                    }}
                  >
                    Choose source…
                  </Button>
                </div>
              </div>
            ) : null}
            {matches.length === 0 && props.sites.length > 0 ? (
              <div className="grid min-h-full place-items-center px-6 py-8 text-center">
                <div className="max-w-[46ch]">
                  <h3 className="font-medium text-foreground">
                    No matching sites
                  </h3>
                  <p className="mt-1 text-ui-sm text-muted-foreground">
                    No sites match your search.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-4"
                    onClick={() => {
                      setQuery("");
                      searchInputRef.current?.focus();
                    }}
                  >
                    Clear search
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <SheetFooter className="shrink-0 border-t border-border/60 pb-safe-bottom-gutter sm:flex-row sm:items-center sm:justify-between">
          <span
            className="min-h-4 min-w-0 truncate text-ui-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            {status}
          </span>
          <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={props.sites.length === 0}
              onClick={() => {
                void props.onRemoveAll().then((removed) => {
                  if (!removed) return;
                  setStatus("All website sessions removed.");
                  requestAnimationFrame(() => {
                    emptyImportRef.current?.focus();
                  });
                });
              }}
            >
              Remove all…
            </Button>
            <SheetClose asChild>
              <Button type="button">Done</Button>
            </SheetClose>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
