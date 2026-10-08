import { createContext, use, useMemo } from "react";
import type {
  EpicCancelFetchFileRequest,
  EpicCancelFetchFileResponse,
  EpicFetchFileRequest,
  EpicFetchFileResponse,
  EpicOpenFileInBrowserRequest,
  EpicOpenFileInBrowserResponse,
  EpicReadFileRequest,
  EpicReadFileResponse,
} from "@traycer/protocol/host/epic/files";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { useHostBinding } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";

/**
 * The epic-file calls the page row and the epic-file tile make, typed by the
 * protocol contracts (`@traycer/protocol/host/epic/files`).
 *
 * A seam rather than `useHostQuery` so tests can hand in a fake through
 * {@link EpicFileRpcContext}. Production calls go to the host the tab is
 * bound to, resolved the way `useTabHostClient` resolves it. A host without
 * the methods answers `E_HOST_UNSUPPORTED` itself (each is declared
 * `degrade: unsupported`).
 */
export interface EpicFileRpc {
  readonly readFile: (
    params: EpicReadFileRequest,
    signal: AbortSignal,
  ) => Promise<EpicReadFileResponse>;
  readonly openFileInBrowser: (
    params: EpicOpenFileInBrowserRequest,
  ) => Promise<EpicOpenFileInBrowserResponse>;
  /** Copies a file too big for the eager mirror onto this host. */
  readonly fetchFile: (
    params: EpicFetchFileRequest,
  ) => Promise<EpicFetchFileResponse>;
  /** Stops a copy `fetchFile` started; progress rides the files lane. */
  readonly cancelFetchFile: (
    params: EpicCancelFetchFileRequest,
  ) => Promise<EpicCancelFetchFileResponse>;
}

export const EpicFileRpcContext = createContext<EpicFileRpc | null>(null);

export function useEpicFileRpc(): EpicFileRpc {
  const override = use(EpicFileRpcContext);
  // Read raw rather than through `useTabHostClient`, which throws outside a
  // tab and without a host runtime: a test that supplies the override has
  // neither.
  const hostId = use(TabHostContext);
  const binding = useHostBinding();
  return useMemo<EpicFileRpc>(() => {
    if (override !== null) return override;
    const client =
      hostId === null ? null : resolveNamedHostClient(binding, hostId);
    if (client === null) {
      const unavailable = (method: string) =>
        Promise.reject(hostClientUnavailableError(method));
      return {
        readFile: () => unavailable("epic.readFile"),
        openFileInBrowser: () => unavailable("epic.openFileInBrowser"),
        fetchFile: () => unavailable("epic.fetchFile"),
        cancelFetchFile: () => unavailable("epic.cancelFetchFile"),
      };
    }
    return {
      readFile: (params, signal) =>
        client.requestWithSignal("epic.readFile", params, signal),
      openFileInBrowser: (params) =>
        client.request("epic.openFileInBrowser", params),
      fetchFile: (params) => client.request("epic.fetchFile", params),
      cancelFetchFile: (params) =>
        client.request("epic.cancelFetchFile", params),
    };
  }, [override, hostId, binding]);
}
