import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Switch } from "@/components/ui/switch";
import { ImportLoginsDialog } from "@/components/settings/import-logins-dialog";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  useBrowserSaveLogins,
  type BrowserSaveLoginsController,
} from "@/lib/browser-view/use-browser-save-logins";
import { useBrowserSavedLoginSitesQuery } from "@/hooks/browser/use-browser-saved-login-sites-query";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useHostBinding } from "@/lib/host";
import { formatRelativeTimestamp, useSampledNow } from "@/lib/relative-time";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { appLogger } from "@/lib/logger";
import type { BrowserViewBridge } from "@traycer-clients/shared/platform/browser-view";
import type {
  BrowserSavedLoginSite,
  BrowserSavedLoginSitesResponse,
} from "@traycer/protocol/host/browser/contracts";
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
  // Unconditionally enabled here: this only mounts once the machine has
  // answered the pref, which is what the gate stood for.
  const sites = useBrowserSavedLoginSitesQuery({ enabled: true });
  return (
    <SettingsGroup
      title="Saved logins"
      tone="default"
      dataTestId="settings-saved-logins"
      fill={false}
    >
      <SavedLoginsToggleRow
        saveLogins={props.saveLogins}
        enabled={props.enabled}
      />
      <ImportLoginsRow
        browserView={props.browserView}
        enabled={props.enabled}
      />
      <ForgetAllLoginsRow browserView={props.browserView} />
      <SavedLoginSitesRow
        browserView={props.browserView}
        data={sites.data ?? null}
        onCleared={() => {
          void sites.refetch();
        }}
      />
    </SettingsGroup>
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
        label="Save website logins on this machine"
        description="Traycer keeps cookies and logins on this machine so agents can reuse the sites you're signed into. Turning this off reloads open browser tabs signed out; the logins already saved stay until you forget them."
        control={
          <Switch
            checked={props.enabled}
            disabled={props.saveLogins.pending}
            aria-label="Save website logins"
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
        title="Stop saving website logins?"
        description="Open browser tabs reload signed out and nothing new is saved on this machine. The logins already saved are kept - use Forget all browser logins to delete them."
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

/**
 * "Import logins from another browser": the way to be signed into the sites
 * the user already uses, without signing into each one again inside Traycer.
 * The dialog owns the three steps; this row only opens it.
 *
 * Disabled with saving off rather than hidden: the import writes the durable
 * jar, which is not the one the tiles are on then, so the row would import
 * into a jar that dies at quit. The hint names the toggle to flip.
 */
function ImportLoginsRow(props: {
  readonly browserView: BrowserViewBridge;
  readonly enabled: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingsRow
        label="Import logins from another browser"
        description="Bring the sites you're signed into in Chrome, Edge, Brave, Firefox, Safari, or a cookie file into Traycer's browser. Google accounts are left out unless you opt in, because Google binds sign-ins to the device."
        hint={props.enabled ? null : "Turn on Save website logins first."}
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!props.enabled}
            onClick={() => {
              setOpen(true);
            }}
          >
            Import logins…
          </Button>
        }
      />
      {open ? (
        <ImportLoginsDialog
          open={open}
          onOpenChange={setOpen}
          browserView={props.browserView}
        />
      ) : null}
    </>
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

/**
 * The destructive one, moved here from the tile shield (ticket 08's temporary
 * home). It speaks for this machine AND for every host the user has a live
 * browser stream to, which is what "all" means and why it is not tile-scoped.
 *
 * It always completes, unlike the per-site Clear. This machine's own jar and
 * forget ledger are emptied whether or not a host is listening, and the ledger
 * is what carries the forget to hosts that were not (universal-sign-in decision
 * 6) - so there is no "nothing happened" case left to hold the dialog open for.
 */
function ForgetAllLoginsRow(props: {
  readonly browserView: BrowserViewBridge;
}): ReactNode {
  return (
    <SettingsRow
      label="Forget all browser logins"
      description="Deletes every saved cookie and login - on this machine and on the host that stores them. Open browser tabs reload signed out and agent sessions using them are suspended."
      control={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => {
            // No renderer dialog: the main process raises a native one and is
            // the authority on the answer (browser security review, root cause
            // C). A second confirmation here would ask twice and, worse, would
            // read as the gate while the real one lives elsewhere.
            void confirmedByMain(
              props.browserView.forgetLogins(),
              "[browser] clearing the browser partition failed",
            );
          }}
        >
          Forget all browser logins…
        </Button>
      }
    />
  );
}

/**
 * Which sites the host still holds logins for - names and times only, never a
 * value (spec section 7.3). `sealed` is deliberately not rendered as "none":
 * the logins exist, this host just cannot open them until the desktop that
 * wrapped its key connects.
 *
 * `null` data means the host never answered - it predates the method, or the
 * query has not settled - and the row renders nothing at all rather than
 * claiming an empty jar.
 */
function SavedLoginSitesRow(props: {
  readonly browserView: BrowserViewBridge;
  readonly data: BrowserSavedLoginSitesResponse | null;
  readonly onCleared: () => void;
}): ReactNode {
  // Optimistic, and only for a frame that actually went out: the host merges
  // asynchronously, so the refetch right behind a clear can still read the
  // pre-merge slice and put the row back for a beat.
  const [cleared, setCleared] = useState<readonly string[]>([]);
  const data = props.data;
  if (data === null) return null;
  const sites = data.kind === "sealed" ? [] : data.sites;
  // The optimism releases itself. A domain is hidden only while the LATEST
  // answer still names it: once the merge lands and the row leaves the
  // response, it leaves this list too - so signing back into that site while
  // Settings is open shows it again instead of hiding it for the rest of the
  // session.
  //
  // Retired from state during render (React's documented way to sync state off
  // a changing external value) rather than in an Effect, because the entry has
  // to be gone BEFORE a later response can re-introduce that domain - deriving
  // alone would hide the re-login too.
  const activeCleared = cleared.filter((domain) =>
    sites.some((site) => site.domain === domain),
  );
  if (activeCleared.length !== cleared.length) setCleared(activeCleared);
  return (
    <SettingsRow
      label="Sites with saved logins"
      description="Site names only - Traycer never shows the saved values."
      control={
        <div className="flex w-full min-w-0 max-w-[min(48vw,26rem)] flex-col gap-1.5 text-ui-sm">
          {data.kind === "sealed" ? (
            <p className="text-muted-foreground">
              Connect this desktop to unlock saved logins. If this machine has
              no system keyring, Traycer will not encrypt them here, so they
              stay locked and nothing new is saved.
            </p>
          ) : (
            <SavedLoginSiteList
              sites={sites.filter(
                (site) => !activeCleared.includes(site.domain),
              )}
              onClear={(domain) => {
                // Awaited, because main raises a native dialog and a cancelled
                // one must not hide the row: the answer is the confirmation,
                // not the request (H10).
                void confirmedByMain(
                  props.browserView.clearSavedLoginSite(domain),
                  "[browser] clearing one saved login failed",
                ).then((confirmed) => {
                  if (!confirmed) return;
                  // The pruned list, not the raw one: a domain the host has
                  // since dropped never comes back into it.
                  setCleared([...activeCleared, domain]);
                  props.onCleared();
                });
              }}
            />
          )}
        </div>
      }
    />
  );
}

function SavedLoginSiteList(props: {
  readonly sites: readonly BrowserSavedLoginSite[];
  readonly onClear: (domain: string) => void;
}): ReactNode {
  // The shared 60s clock, not `Date.now()`: reading the wall clock during a
  // render is impure, and the sampled one repaints these labels on its tick.
  const now = useSampledNow();
  // THIS machine's host id, read once for the whole list: every row compares
  // its contributor against the same answer. `useReactiveLocalHostId` rather
  // than the local directory entry, because the entry goes null while the
  // local host restarts and a row must not start claiming a remote capture
  // for the length of that gap.
  const localHostId = useReactiveLocalHostId();
  if (props.sites.length === 0) {
    return <p className="text-muted-foreground">No saved logins yet.</p>;
  }
  return (
    <ul className="flex w-full min-w-0 flex-col gap-1">
      {props.sites.map((site) => (
        <SavedLoginSiteRow
          key={site.domain}
          site={site}
          localHostId={localHostId}
          now={now}
          onClear={props.onClear}
        />
      ))}
    </ul>
  );
}

/**
 * One site, plus the provenance line when another machine is what signed in
 * (universal-sign-in decision 9).
 *
 * Its own component because resolving a host's display name is a hook, and a
 * row is where the host id lives. Attribution is deliberately silent for the
 * local machine: a login this desktop's own host captured is one the user made
 * here, and naming their own machine on every row would be noise around the
 * lines that actually say "this came from somewhere else".
 *
 * The copy says "includes a sign-in from", not "captured on", because the
 * marker behind it is STICKY: it records that a headless context on that host
 * once contributed new cookie information for the domain, and it survives the
 * user signing into the same site here afterwards. Anything tighter (a "where
 * this login came from", a "captured at") would be a claim about recency and
 * origin that the store does not make.
 */
function SavedLoginSiteRow(props: {
  readonly site: BrowserSavedLoginSite;
  readonly localHostId: string | null;
  readonly now: number;
  readonly onClear: (domain: string) => void;
}): ReactNode {
  const contributedByHostId = props.site.contributedByHostId;
  // `typeof`, not `!== null`, and the difference is load-bearing. The
  // same-minor RPC path returns the host's payload UNPARSED - the schema's
  // `.default(null)` only runs when a version gap forces a decode - so against
  // a host that predates the field this is `undefined` at runtime however the
  // type reads. A null check would let that through and render a dangling
  // "Includes a sign-in from " on every row of every older host's list.
  const remoteHostId =
    typeof contributedByHostId === "string" &&
    contributedByHostId !== props.localHostId
      ? contributedByHostId
      : null;
  // The directory is the app's host-naming machinery: its `label` is the
  // account registry's display name for a remote host and the machine's own
  // for this one. `null` (a host this client cannot currently list) falls back
  // to the canonical id rather than inventing a name for it.
  const entry = useHostDirectoryEntry(remoteHostId);
  const hostName = entry === null ? remoteHostId : entry.label;
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-2 text-ui-sm">
        <span className="min-w-0 flex-1 truncate font-mono text-foreground">
          {props.site.domain}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {formatRelativeTimestamp(props.site.lastSeen, props.now)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`Clear saved logins for ${props.site.domain}`}
          onClick={() => {
            props.onClear(props.site.domain);
          }}
        >
          Clear
        </Button>
      </div>
      {hostName === null ? null : (
        <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
          Includes a sign-in from {hostName}
        </span>
      )}
    </li>
  );
}
