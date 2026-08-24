import type { BrowserSessionsClientFrame } from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserCdpCommand,
  BrowserCdpResult,
} from "./browser-cdp-contract";
import type {
  BrowserViewTileKey,
  DesktopBrowserViewBridge,
} from "./desktop-browser-view";
import { buildCdpResultFrame } from "./browser-cdp-frames";

export interface BorrowedTileCdpRequest {
  readonly requestId: string;
  readonly tileInstanceId: string;
  readonly cdpSessionId: string | null;
  readonly command: BrowserCdpCommand;
  readonly sendFrame: (frame: BrowserSessionsClientFrame) => void;
}

type BorrowedTileCdpBridge = Pick<
  DesktopBrowserViewBridge,
  "dispatchCdp" | "onCdpSessionEnded" | "onCdpTargetAttached"
>;

const handlerByTileInstanceId = new Map<
  string,
  (request: BorrowedTileCdpRequest) => void
>();

export function registerBorrowedTileCdpHandler(
  tileInstanceId: string,
  handler: (request: BorrowedTileCdpRequest) => void,
): () => void {
  handlerByTileInstanceId.set(tileInstanceId, handler);
  return () => {
    if (handlerByTileInstanceId.get(tileInstanceId) === handler) {
      handlerByTileInstanceId.delete(tileInstanceId);
    }
  };
}

export function publishBorrowedTileCdpRequest(
  request: BorrowedTileCdpRequest,
): void {
  const handler = handlerByTileInstanceId.get(request.tileInstanceId);
  if (handler !== undefined) {
    handler(request);
    return;
  }
  request.sendFrame(
    buildBorrowedTileCdpResult(request.requestId, request.tileInstanceId, {
      kind: request.command.kind,
      ok: false,
      error: {
        kind: "tile_not_found",
        message: "Borrowed browser tile is not mounted.",
        code: null,
      },
    }),
  );
}

/**
 * Connects one user-owned browser surface to the borrowed-tile transport.
 * The response sender stays in this mounted surface's closure; there is no
 * process-global last-writer route that another epic or host can overwrite.
 */
export function attachBorrowedTileCdpSurface(input: {
  readonly bridge: BorrowedTileCdpBridge;
  readonly tileKey: BrowserViewTileKey;
}): () => void {
  let sendFrame: ((frame: BrowserSessionsClientFrame) => void) | null = null;
  const unregister = registerBorrowedTileCdpHandler(
    input.tileKey.tileInstanceId,
    (request) => {
      sendFrame = request.sendFrame;
      void input.bridge
        .dispatchCdp({
          ...input.tileKey,
          sessionId: request.cdpSessionId,
          command: request.command,
        })
        .then((result) => {
          request.sendFrame(
            buildBorrowedTileCdpResult(
              request.requestId,
              request.tileInstanceId,
              result,
            ),
          );
        })
        .catch((cause: unknown) => {
          request.sendFrame(
            buildBorrowedTileCdpResult(
              request.requestId,
              request.tileInstanceId,
              {
                kind: request.command.kind,
                ok: false,
                error: {
                  kind: "cdp_error",
                  message: cause instanceof Error ? cause.message : String(cause),
                  code: null,
                },
              },
            ),
          );
        });
    },
  );
  const ended = input.bridge.onCdpSessionEnded((change) => {
    if (!sameTile(change, input.tileKey) || sendFrame === null) return;
    sendFrame({
      kind: "cdpSessionEnded",
      hasBinaryPayload: false,
      requestId: crypto.randomUUID(),
      target: {
        kind: "borrowed-tile",
        tileInstanceId: input.tileKey.tileInstanceId,
      },
      registrationId: null,
      reason: change.reason,
    });
  });
  const attached = input.bridge.onCdpTargetAttached((change) => {
    if (!sameTile(change, input.tileKey) || sendFrame === null) return;
    sendFrame({
      kind: "cdpTargetAttached",
      hasBinaryPayload: false,
      requestId: crypto.randomUUID(),
      target: {
        kind: "borrowed-tile",
        tileInstanceId: input.tileKey.tileInstanceId,
      },
      registrationId: null,
      cdpSessionId: change.sessionId,
      targetId: change.targetId,
      targetType: change.targetType,
      url: change.url,
      waitingForDebugger: change.waitingForDebugger,
    });
  });
  return () => {
    sendFrame = null;
    unregister();
    ended.dispose();
    attached.dispose();
  };
}

export function buildBorrowedTileCdpResult(
  requestId: string,
  tileInstanceId: string,
  result: BrowserCdpResult,
): BrowserSessionsClientFrame {
  return buildCdpResultFrame(
    requestId,
    { kind: "borrowed-tile", tileInstanceId },
    null,
    result,
  );
}

export function resetBorrowedTileCdpForTests(): void {
  handlerByTileInstanceId.clear();
}

function sameTile(left: BrowserViewTileKey, right: BrowserViewTileKey): boolean {
  return (
    left.viewTabId === right.viewTabId &&
    left.paneId === right.paneId &&
    left.tileInstanceId === right.tileInstanceId &&
    left.pageSessionId === right.pageSessionId
  );
}
