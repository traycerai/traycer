import { useCallback, type ReactNode } from "react";
import { useAuthStore } from "@/stores/auth/auth-store";
import { disposeAllChatSessions } from "@/lib/registries/chat-session-registry";
import { disposeAllTerminalSessions } from "@/lib/registries/terminal-session-registry";
import { disposeAllOpenEpicSessions } from "@/lib/registries/epic-session-registry";
import { clearSessionCreatedEpics } from "@/lib/epics/session-created-epics";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { useAddHostDialogStore } from "@/stores/settings/add-host-dialog-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useRateLimitPopoverStore } from "@/stores/rate-limits/rate-limit-popover-store";
import { useResourceMonitorStore } from "@/stores/resources/resource-monitor-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";

/**
 * Renderer-side bridge that disposes every live Epic, chat, and terminal
 * session whenever the authenticated identity changes - sign-out, user-switch,
 * or a token expiry that lands the user back on the signed-out auth surface.
 *
 * The teardown is deliberately whole-registry: even resources the new identity
 * also has access to must be re-acquired so the next snapshot and chat
 * subscription land fresh. Without this, prior-user Y.Doc bytes, unsynced
 * edits, last-focused state, and live chat/terminal stream state (including a
 * warm terminal-agent session, which the terminal registry keeps lease-free
 * with no idle TTL) would leak into the next session.
 */
export interface EpicSessionLifecycleBridgeProps {
  readonly children: ReactNode;
}

export function EpicSessionLifecycleBridge(
  props: EpicSessionLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedOut" || transition.kind === "userSwitched") {
      disposeAllOpenEpicSessions();
      disposeAllChatSessions();
      disposeAllTerminalSessions();
      // Draft mirrors are renderer-local and can contain an unflushed writer
      // or a pre-create request. Flush/abort them with the outgoing identity;
      // durable drafts remain governed by the existing per-window source.
      draftRuntimeRegistry.teardown();
      // Retire every Query-bound writer and editor owner with the outgoing
      // identity. Dirty text remains recoverable in this window's journal,
      // partitioned by the outgoing immutable auth subject.
      void fileEditRuntimeRegistry.teardown();
      // Drop the "created this session" markers so a new identity's persisted
      // tabs are reconciled normally instead of being protected by the prior
      // identity's create markers.
      clearSessionCreatedEpics();
      // Settings' viewing scope is a host id, and host ids belong to an
      // ACCOUNT. Left standing across a switch it names the previous account's
      // machine, which the new account's lists will never contain — so Settings
      // opens `vanished`, reporting a host id the person signing in has never
      // seen and cannot dismiss except by re-picking. `null` is not "no host",
      // it is "follow the active host", so this returns the surface to its
      // default rather than emptying it.
      useSettingsHostScopeStore.getState().setScopedHostId(null);
      // The Usage popover pins a host id on the same account-owned terms, and
      // it PERSISTS — left standing it survives the restart into the next
      // sign-in and opens Usage on a `vanished` host the new account has never
      // seen. Same rule, same `null`-means-follow default. Tab and size stay:
      // they are window habits, not account facts.
      useRateLimitPopoverStore.getState().setScopedHostId(null);
      // The resource monitor pins a host id on exactly the same persisted,
      // account-owned terms, so it needs the same reset - otherwise it survives
      // the restart into the next sign-in and opens on a `vanished` host the
      // new account has never seen.
      useResourceMonitorStore.getState().setScopedHostId(null);
      // The Add-host dialog is module-level too, and it carries more than a
      // boolean: `knownHostIds` is the snapshot the arrival watcher diffs
      // against to decide which machine is NEW. Left standing across a switch
      // it reopens for account B unasked, holding account A's fleet — so a
      // host B already owns is absent from that snapshot and gets announced as
      // the machine that just connected.
      useAddHostDialogStore.getState().closeDialog();
      // The Providers deep-link intent is the third module-level store on this
      // boundary, and the most dangerous of them: `focusHostId` names account
      // A's machine and `startSignIn` asks Providers to begin a sign-in flow
      // the moment it consumes the intent. Left armed, account B's Providers
      // could select A's host id and then run A's pending profile sign-in on
      // whichever host B lands on. `clearFocusHarnessId` drops the harness,
      // host, profile and sign-in flag together; the tab half is separate.
      useProvidersFocusStore.getState().clearFocusHarnessId();
      useProvidersFocusStore.getState().clearFocusTab();
    }
  }, []);

  useAuthIdentityTransition(status, userId, onTransition);

  return <>{props.children}</>;
}
