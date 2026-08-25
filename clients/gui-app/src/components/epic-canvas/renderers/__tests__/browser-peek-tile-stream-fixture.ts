type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export class FakeStreamSession {
  readonly sentFrames: Array<Record<string, unknown>> = [];
  private serverHandler:
    | ((
        envelope: Record<string, unknown>,
        binaryPayload: Uint8Array | null,
      ) => void)
    | null = null;
  private statusHandler: ((status: StreamStatus, reason: null) => void) | null =
    null;
  private currentStatus: StreamStatus = "connecting";
  closed = false;

  sendClientFrame(frame: Record<string, unknown>): void {
    this.sentFrames.push(frame);
  }

  onServerFrame(
    handler: (
      envelope: Record<string, unknown>,
      binaryPayload: Uint8Array | null,
    ) => void,
  ): void {
    this.serverHandler = handler;
  }

  onStatusChange(handler: (status: StreamStatus, reason: null) => void): void {
    this.statusHandler = handler;
    if (this.currentStatus === "open") handler("open", null);
  }

  close(): void {
    this.closed = true;
  }

  emitStatus(status: StreamStatus): void {
    this.currentStatus = status;
    this.statusHandler?.(status, null);
  }

  emit(
    envelope: Record<string, unknown>,
    binaryPayload: Uint8Array | null,
  ): void {
    this.serverHandler?.(envelope, binaryPayload);
  }
}

export class FakeStreamClient {
  readonly sessions: FakeStreamSession[] = [];
  readonly subscribes: Array<{
    readonly method: string;
    readonly params: unknown;
  }> = [];

  constructor(private readonly autoOpen: boolean) {}

  subscribe(method: string, params: unknown): FakeStreamSession {
    const session = new FakeStreamSession();
    this.sessions.push(session);
    this.subscribes.push({ method, params });
    if (this.autoOpen) session.emitStatus("open");
    return session;
  }
}
