import {
  terminalPlainSubscribeListServerFrameSchemaV10,
  terminalPlainSubscribeListServerFrameSchema,
  type TerminalPlainSubscribeListServerFrame,
  type TerminalPlainSubscribeListServerFrameV10,
} from "@traycer/protocol/host/terminal/plain-subscribe-list";
import {
  plainTerminalFleetIdentityKey,
  type PlainTerminalProjection,
  type PlainTerminalScope,
} from "@traycer/protocol/host/terminal/plain-schemas";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  IStreamSession,
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "./i-stream-session";
import type { IHostStreamClient } from "./host-stream-client";

export interface PlainTerminalListStreamCallbacks {
  readonly onState: (
    frame: Extract<
      TerminalPlainSubscribeListServerFrame,
      { readonly kind: "state" }
    >,
  ) => void;
  readonly onConnectionStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

export interface PlainTerminalListStreamClientOptions {
  readonly wsStreamClient: IHostStreamClient<HostStreamRpcRegistry>;
  readonly servingHostId: string;
  readonly scope: PlainTerminalScope;
  readonly callbacks: PlainTerminalListStreamCallbacks;
}

/** Typed client surface for replacement-state durable terminal collection. */
export class PlainTerminalListStreamClient {
  private readonly session: IStreamSession;
  private readonly callbacks: PlainTerminalListStreamCallbacks;
  private readonly servingHostId: string;
  private readonly scope: PlainTerminalScope;
  private readonly v1TerminalsByIdentity: Map<string, PlainTerminalProjection>;
  private v1Initialized: boolean;
  private closed: boolean;

  constructor(options: PlainTerminalListStreamClientOptions) {
    this.callbacks = options.callbacks;
    this.servingHostId = options.servingHostId;
    this.scope = options.scope;
    this.v1TerminalsByIdentity = new Map();
    this.v1Initialized = false;
    this.closed = false;
    this.session = options.wsStreamClient.subscribe(
      "terminal.plain.subscribeList",
      { scope: options.scope },
    );
    this.session.onServerFrame((envelope, binaryPayload) => {
      this.handleServerFrame(envelope, binaryPayload);
    });
    this.session.onStatusChange((status, reason) => {
      if (
        status === "connecting" ||
        status === "reconnecting" ||
        status === "closed"
      ) {
        this.v1TerminalsByIdentity.clear();
        this.v1Initialized = false;
      }
      this.callbacks.onConnectionStatus(status, reason);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private handleServerFrame(
    envelope: StreamFrameEnvelope,
    _binaryPayload: Uint8Array | null,
  ): void {
    const negotiatedVersion = this.session.getNegotiatedSchemaVersion();
    if (negotiatedVersion?.major === 1) {
      const parsedV1 =
        terminalPlainSubscribeListServerFrameSchemaV10.safeParse(envelope);
      if (parsedV1.success) {
        this.handleV1ServerFrame(parsedV1.data);
        return;
      }
      this.warnMalformedFrame(envelope, parsedV1.error.issues);
      return;
    }

    const parsed =
      terminalPlainSubscribeListServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      this.warnMalformedFrame(envelope, parsed.error.issues);
      return;
    }

    const frame = parsed.data;
    switch (frame.kind) {
      case "state": {
        this.callbacks.onState(frame);
        return;
      }
      case "pong": {
        return;
      }
      default: {
        const unhandled: never = frame;
        console.warn(
          `[stream] terminal.plain.subscribeList unhandled frame kind; dropping frame`,
          unhandled,
        );
        return;
      }
    }
  }

  private handleV1ServerFrame(
    frame: TerminalPlainSubscribeListServerFrameV10,
  ): void {
    switch (frame.kind) {
      case "snapshot": {
        this.v1TerminalsByIdentity.clear();
        for (const terminal of frame.terminals) {
          this.v1TerminalsByIdentity.set(
            plainTerminalFleetIdentityKey({
              hostId: terminal.record.hostId,
              terminalId: terminal.record.terminalId,
            }),
            terminal,
          );
        }
        this.v1Initialized = false;
        return;
      }
      case "initialized": {
        this.v1Initialized = true;
        this.emitV1ReplacementState();
        return;
      }
      case "upsert": {
        this.v1TerminalsByIdentity.set(
          plainTerminalFleetIdentityKey({
            hostId: frame.terminal.record.hostId,
            terminalId: frame.terminal.record.terminalId,
          }),
          frame.terminal,
        );
        if (this.v1Initialized) this.emitV1ReplacementState();
        return;
      }
      case "deleted": {
        this.v1TerminalsByIdentity.delete(
          plainTerminalFleetIdentityKey({
            hostId: this.servingHostId,
            terminalId: frame.terminalId,
          }),
        );
        if (this.v1Initialized) this.emitV1ReplacementState();
        return;
      }
      case "pong": {
        return;
      }
      default: {
        const unhandled: never = frame;
        console.warn(
          "[stream] terminal.plain.subscribeList unhandled v1 frame kind; dropping frame",
          unhandled,
        );
      }
    }
  }

  private emitV1ReplacementState(): void {
    const terminals = [...this.v1TerminalsByIdentity.values()];
    this.callbacks.onState({
      kind: "state",
      hasBinaryPayload: false,
      state:
        this.scope.kind === "independent"
          ? {
              coverage: "complete-local",
              scope: this.scope,
              terminals,
            }
          : {
              coverage: "partial-serving-host",
              scope: this.scope,
              servingHostId: this.servingHostId,
              terminals,
            },
    });
  }

  private warnMalformedFrame(
    envelope: StreamFrameEnvelope,
    issues: readonly { readonly path: PropertyKey[] }[],
  ): void {
    const issuePaths = issues
      .map((issue) => (issue.path.length > 0 ? issue.path.join(".") : "(root)"))
      .join(", ");
    console.warn(
      `[stream] terminal.plain.subscribeList frame failed schema validation (kind=${envelope.kind}, issues=[${issuePaths}]); dropping frame`,
    );
  }
}
