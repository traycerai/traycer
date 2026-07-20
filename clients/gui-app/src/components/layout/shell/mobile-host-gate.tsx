import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { HostDirectoryService } from "@/lib/host/host-directory-service";
import { useHostBinding } from "@/lib/host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";

interface DirectoryState {
  readonly hasLocal: boolean;
  readonly cardinality: "zero" | "one" | "many";
}

export interface MobileHostGateProps {
  readonly children: ReactNode;
  readonly noHost: ReactNode;
  /**
   * When `true`, pass children through regardless of directory state.
   * Set by `TraycerAppRouter` for host-independent routes (e.g.
   * `/settings/*`) so the user can edit shell config / env overrides
   * before any host binds. Default behaviour (mobile zero/many UX)
   * resumes once the user navigates back to a host-needing route.
   */
  readonly bypass: boolean;
}

/**
 * Surfaces the Flow 6 mobile zero / one / many host UX inside the mounted
 * `<TraycerApp />` tree.
 *
 * The gate only acts when the merged directory contains no `kind: "local"`
 * entry - that discriminates the mobile path from desktop, which always
 * prefers its bundled local host as the auto-bind default. On the mobile
 * path the gate maps directory cardinality to UX:
 *
 *   - `zero`  → render the provided `noHost` guidance. No binding occurs
 *     (cardinality is resolved before `HostRuntime.start()` binds) and the
 *     picker is not opened.
 *   - `one`   → pass `children` through. Auto-bind is the responsibility of
 *     `HostDirectoryService.getDefaultEntry()` - the single entry becomes
 *     the runtime's initial selection and `HostClient` binds normally.
 *   - `many`  → pass `children` through and programmatically request the
 *     shell-owned picker open once so the user makes an explicit pick
 *     before any binding happens. Re-entry is guarded by a ref so a user
 *     who dismisses the picker is not re-prompted on every render.
 *
 * Desktop behaviour is untouched: whenever a local-kind entry is present,
 * the gate short-circuits to `children` and the provisional "Switch host"
 * header action drives the picker instead.
 */
export function MobileHostGate(props: MobileHostGateProps): ReactNode {
  const binding = useHostBinding();
  const runnerHost = useRunnerHost();
  const authStatus = useAuthStore((s) => s.status);

  const pickerRequestedRef = useRef<boolean>(false);
  const directory = binding === null ? null : binding.directory;
  const state = useDirectoryState(directory);
  const shouldRefreshForCardinality =
    authStatus === "signed-in" && !props.bypass && binding !== null;
  // `directory.start()` already performs its own initial refresh before
  // `binding` is ever published, so the first render where this condition is
  // true is never a real transition - only refresh here from the SECOND time
  // onward (e.g. a later sign-in while the directory already existed), or
  // this would double the startup fetch on every signed-in mobile boot.
  const hasEvaluatedCardinalityRefreshRef = useRef<boolean>(false);
  useEffect(() => {
    if (directory === null) {
      return;
    }
    if (!shouldRefreshForCardinality) {
      hasEvaluatedCardinalityRefreshRef.current = true;
      return;
    }
    if (!hasEvaluatedCardinalityRefreshRef.current) {
      hasEvaluatedCardinalityRefreshRef.current = true;
      return;
    }
    void directory.refresh();
  }, [shouldRefreshForCardinality, directory]);

  useEffect(() => {
    if (binding === null) {
      return;
    }
    if (authStatus !== "signed-in") {
      return;
    }
    if (state === null) {
      return;
    }
    if (state.hasLocal) {
      return;
    }
    if (state.cardinality !== "many") {
      return;
    }
    if (binding.hostClient.getActiveHostId() !== null) {
      return;
    }
    if (pickerRequestedRef.current) {
      return;
    }
    pickerRequestedRef.current = true;
    runnerHost.hostPicker.requestOpen();
  }, [binding, runnerHost, authStatus, state]);

  if (authStatus !== "signed-in") {
    return <>{props.children}</>;
  }
  // Caller-driven bypass for host-independent routes (settings). Skip
  // the zero-cardinality "noHost" surface so the user can edit shell
  // config before any host ever exists.
  if (props.bypass) {
    return <>{props.children}</>;
  }
  if (binding === null || state === null) {
    return <>{props.children}</>;
  }
  if (state.hasLocal) {
    return <>{props.children}</>;
  }
  if (state.cardinality === "zero") {
    return <>{props.noHost}</>;
  }
  return <>{props.children}</>;
}

function useDirectoryState(
  directory: HostDirectoryService | null,
): DirectoryState | null {
  const cacheRef = useRef<DirectoryState | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (directory === null) {
        return () => undefined;
      }
      const subscription = directory.onChange(() => {
        cacheRef.current = readDirectoryState(directory, cacheRef.current);
        onStoreChange();
      });
      return () => {
        subscription.dispose();
      };
    },
    [directory],
  );

  const getSnapshot = useCallback((): DirectoryState | null => {
    cacheRef.current = readDirectoryState(directory, cacheRef.current);
    return cacheRef.current;
  }, [directory]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function readDirectoryState(
  directory: HostDirectoryService | null,
  previous: DirectoryState | null,
): DirectoryState | null {
  if (directory === null) {
    return null;
  }
  const next: DirectoryState = {
    hasLocal: directory.getLocalEntry() !== null,
    cardinality: directory.getCardinality(),
  };
  if (
    previous !== null &&
    previous.hasLocal === next.hasLocal &&
    previous.cardinality === next.cardinality
  ) {
    return previous;
  }
  return next;
}
