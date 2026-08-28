import type { BrowserViewNativeTabCapability } from "@traycer-clients/shared/platform/browser-view";

type ActivationState =
  | { readonly kind: "provisioning" }
  | { readonly kind: "failed" }
  | { readonly kind: "provisioned"; seedScriptId: string | null }
  | { readonly kind: "accepted"; seedScriptId: string | null };

/** Owns the legal lifecycle transitions of one host-owned Electron guest. */
export class NativeBrowserViewLifecycle {
  private readonly provisioning =
    Promise.withResolvers<BrowserViewNativeTabCapability>();
  private activation: ActivationState = { kind: "provisioning" };

  get provisioned(): Promise<BrowserViewNativeTabCapability> {
    return this.provisioning.promise;
  }

  get accepted(): boolean {
    return this.activation.kind === "accepted";
  }

  completeProvisioning(
    provisioned: BrowserViewNativeTabCapability,
    seedScriptId: string | null,
  ): void {
    if (this.activation.kind !== "provisioning") {
      throw new Error("Native browser view provisioning already settled.");
    }
    this.activation = { kind: "provisioned", seedScriptId };
    this.provisioning.resolve(provisioned);
  }

  failProvisioning(error: unknown): void {
    if (this.activation.kind !== "provisioning") return;
    this.activation = { kind: "failed" };
    this.provisioning.reject(error);
  }

  accept(): boolean {
    if (this.activation.kind === "accepted") return false;
    if (this.activation.kind !== "provisioned") {
      throw new Error("Electron browser tab is not provisioned.");
    }
    this.activation = {
      kind: "accepted",
      seedScriptId: this.activation.seedScriptId,
    };
    return true;
  }

  takeSeedScriptId(): string | null {
    if (this.activation.kind !== "accepted") return null;
    const seedScriptId = this.activation.seedScriptId;
    this.activation.seedScriptId = null;
    return seedScriptId;
  }
}
