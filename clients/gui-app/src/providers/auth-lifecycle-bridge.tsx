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
import { dismissRetainedDraftToasts } from "@/lib/toast/retained-draft-toasts";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";

/** Dispose every live Epic, chat, and terminal on identity change so prior-user Y.Doc, edits, and streams cannot leak into the next session. */
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
      // Clear Settings viewing scope: a leftover host id belongs to the previous
      // account. null means follow the active host, not empty.
      useSettingsHostScopeStore.getState().setScopedHostId(null);
      // Clear Usage's pinned host id; it persists across sign-in. null means
      // follow the active host. Tab and size stay.
      useRateLimitPopoverStore.getState().setScopedHostId(null);
      // Clear the resource monitor's pinned host id; it persists across
      // sign-in.
      useResourceMonitorStore.getState().setScopedHostId(null);
      // Close Add-host: leftover knownHostIds is A's fleet, so B's own host
      // would be announced as newly connected.
      useAddHostDialogStore.getState().closeDialog();
      // Disarm Providers deep-link: leftover focusHostId + startSignIn would
      // run A's pending sign-in on B's host. clearFocusHarnessId drops all four.
      useProvidersFocusStore.getState().clearFocusHarnessId();
      useProvidersFocusStore.getState().clearFocusTab();
      // Dismiss last-copy draft toasts here only; Toaster is outside this tree
      // and they have no duration. Chat/epic close must not take them down.
      dismissRetainedDraftToasts();
    }
  }, []);

  useAuthIdentityTransition(status, userId, onTransition);

  return <>{props.children}</>;
}
