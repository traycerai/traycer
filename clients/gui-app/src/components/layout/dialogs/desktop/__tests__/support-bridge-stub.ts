import type { DesktopSupportBridge } from "@/lib/windows/types";

function unexpectedSupportCall(): Promise<never> {
  return Promise.reject(new Error("Unexpected support bridge fixture call"));
}

export function createDesktopSupportBridgeStub(): DesktopSupportBridge {
  return {
    getSnapshot: unexpectedSupportCall,
    revealLog: unexpectedSupportCall,
    submitReport: unexpectedSupportCall,
    tailLog: unexpectedSupportCall,
    freezeEvidence: unexpectedSupportCall,
    discardFrozenEvidence: unexpectedSupportCall,
    readFrozenLogTail: unexpectedSupportCall,
    saveDiagnosticBundle: unexpectedSupportCall,
    getFingerprintOccurrence: unexpectedSupportCall,
    buildPublicDraft: unexpectedSupportCall,
  };
}
