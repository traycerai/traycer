import {
  placeholderDiagnosticsStatus,
  type DiagnosticsStatus,
} from "@traycer/protocol/config/diagnostics-schema";

export const UNSUPPORTED_DIAGNOSTICS_STATUS: DiagnosticsStatus =
  placeholderDiagnosticsStatus({
    supported: false,
    source: "unsupported",
    readStatus: null,
    configPath: "",
    configMtimeMs: null,
    hostVersion: "1.2.3",
    activeSlot: null,
    logPath: null,
  });
