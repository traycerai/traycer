import { createContext, use } from "react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EpicFetchFileRequest,
  EpicFetchFileResponse,
  EpicOpenFileInBrowserRequest,
  EpicOpenFileInBrowserResponse,
  EpicReadFileRequest,
  EpicReadFileResponse,
} from "@traycer/protocol/host/epic/files";

/**
 * The epic-file calls the page row and the epic-file tile make, typed by the
 * protocol contracts (`@traycer/protocol/host/epic/files`).
 *
 * A seam rather than `useHostQuery`, because `epic.readFile` and
 * `epic.openFileInBrowser` (and `epic.fetchFile`) join the host RPC registry together with their
 * resolvers. Until then nothing answers them, and a surface that reads one
 * shows its unavailable state. Tests provide a fake through
 * {@link EpicFileRpcContext}. Once the methods are registered the fallback
 * below becomes the tab host client's `requestWithSignal`, and no caller
 * changes.
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
}

function unserved(method: string): Promise<never> {
  return Promise.reject(
    new HostRpcError({
      code: "E_HOST_UNSUPPORTED",
      message: `${method} is not served by this host`,
      requestId: "",
      method,
      fatalDetails: null,
    }),
  );
}

const UNSERVED_EPIC_FILE_RPC: EpicFileRpc = {
  readFile: () => unserved("epic.readFile"),
  openFileInBrowser: () => unserved("epic.openFileInBrowser"),
  fetchFile: () => unserved("epic.fetchFile"),
};

export const EpicFileRpcContext = createContext<EpicFileRpc | null>(null);

export function useEpicFileRpc(): EpicFileRpc {
  return use(EpicFileRpcContext) ?? UNSERVED_EPIC_FILE_RPC;
}
