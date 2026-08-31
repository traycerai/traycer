import type { BrowserViewNativeTabCapability } from "@traycer-clients/shared/platform/browser-view";

type ActivationState = "provisioning" | "failed" | "provisioned" | "accepted";

/** Owns the legal lifecycle transitions of one host-owned Electron guest. */
export class NativeBrowserViewLifecycle {
  private readonly provisioning =
    Promise.withResolvers<BrowserViewNativeTabCapability>();
  private activation: ActivationState = "provisioning";
  /** Handed over once, on the first read after acceptance. */
  private seedScriptId: string | null = null;

  get provisioned(): Promise<BrowserViewNativeTabCapability> {
    return this.provisioning.promise;
  }

  get accepted(): boolean {
    return this.activation === "accepted";
  }

  completeProvisioning(
    provisioned: BrowserViewNativeTabCapability,
    seedScriptId: string | null,
  ): void {
    if (this.activation !== "provisioning") {
      throw new Error("Native browser view provisioning already settled.");
    }
    this.activation = "provisioned";
    this.seedScriptId = seedScriptId;
    this.provisioning.resolve(provisioned);
  }

  failProvisioning(error: unknown): void {
    if (this.activation !== "provisioning") return;
    this.activation = "failed";
    this.provisioning.reject(error);
  }

  accept(): boolean {
    if (this.activation === "accepted") return false;
    if (this.activation !== "provisioned") {
      throw new Error("Electron browser tab is not provisioned.");
    }
    this.activation = "accepted";
    return true;
  }

  takeSeedScriptId(): string | null {
    if (this.activation !== "accepted") return null;
    const seedScriptId = this.seedScriptId;
    this.seedScriptId = null;
    return seedScriptId;
  }
}
