import type { BrowserViewProvisionedTab } from "../../ipc-contracts/browser-view-types";

type ActivationState =
  | { readonly kind: "provisioning" }
  | { readonly kind: "failed" }
  | { readonly kind: "provisioned"; seedScriptId: string | null }
  | {
      readonly kind: "accepted";
      seedScriptId: string | null;
      readonly promise: Promise<void>;
    };

type HandoffState =
  | { readonly kind: "available" }
  | { readonly kind: "capturing"; readonly promise: Promise<void> }
  | { readonly kind: "handed-off" };

/** Owns the legal lifecycle transitions of one host-owned Electron guest. */
export class NativeBrowserViewLifecycle {
  private readonly provisioning =
    Promise.withResolvers<BrowserViewProvisionedTab>();
  private activation: ActivationState = { kind: "provisioning" };
  private handoff: HandoffState = { kind: "available" };

  get provisioned(): Promise<BrowserViewProvisionedTab> {
    return this.provisioning.promise;
  }

  get accepted(): boolean {
    return this.activation.kind === "accepted";
  }

  get canHandoff(): boolean {
    return this.accepted && this.handoff.kind === "available";
  }

  get pendingHandoffCapture(): Promise<void> | null {
    return this.handoff.kind === "capturing" ? this.handoff.promise : null;
  }

  completeProvisioning(
    provisioned: BrowserViewProvisionedTab,
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

  accept(activate: () => Promise<void>): Promise<void> {
    if (this.activation.kind === "accepted") return this.activation.promise;
    if (this.activation.kind !== "provisioned") {
      return Promise.reject(
        new Error("Electron browser tab is not provisioned."),
      );
    }
    const promise = activate();
    this.activation = {
      kind: "accepted",
      seedScriptId: this.activation.seedScriptId,
      promise,
    };
    return promise;
  }

  takeSeedScriptId(): string | null {
    if (this.activation.kind !== "accepted") return null;
    const seedScriptId = this.activation.seedScriptId;
    this.activation.seedScriptId = null;
    return seedScriptId;
  }

  beginHandoffCapture(promise: Promise<void>): boolean {
    if (!this.canHandoff) return false;
    this.handoff = { kind: "capturing", promise };
    return true;
  }

  finishHandoffCapture(promise: Promise<void>): void {
    if (this.handoff.kind === "capturing" && this.handoff.promise === promise) {
      this.handoff = { kind: "handed-off" };
    }
  }
}
