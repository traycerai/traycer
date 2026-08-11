export type PrimaryFocusTarget =
  | { readonly kind: "composer"; readonly surfaceId: string }
  | { readonly kind: "terminal"; readonly instanceId: string }
  | {
      readonly kind: "landing-terminal-directory";
      readonly requestId: number;
    }
  | { readonly kind: "landing-terminal-new-tab" };

export interface PrimaryFocusEndpoint {
  readonly focus: () => void;
  readonly containsActiveElement: (activeElement: Element | null) => boolean;
  readonly isEligible: () => boolean;
}

interface PrimaryFocusIntent {
  readonly epoch: number;
  readonly target: PrimaryFocusTarget;
}

interface PrimaryFocusEnvironment {
  readonly activeElement: () => Element | null;
  readonly documentVisible: () => boolean;
}

type PrimaryFocusIntentListener = (pending: boolean) => void;

function targetKey(target: PrimaryFocusTarget): string {
  switch (target.kind) {
    case "composer":
      return `composer:${target.surfaceId}`;
    case "terminal":
      return `terminal:${target.instanceId}`;
    case "landing-terminal-directory":
      return `landing-terminal-directory:${target.requestId}`;
    case "landing-terminal-new-tab":
      return "landing-terminal-new-tab";
  }
}

export class PrimaryFocusCoordinator {
  private readonly endpoints = new Map<string, PrimaryFocusEndpoint>();
  private readonly intentListeners = new Set<PrimaryFocusIntentListener>();
  private epoch = 0;
  private intent: PrimaryFocusIntent | null = null;
  private fulfilledEpoch: number | null = null;
  private fulfilledEndpoint: PrimaryFocusEndpoint | null = null;
  private interactionActive = false;

  constructor(private readonly environment: PrimaryFocusEnvironment) {}

  private clearIntent(): void {
    const wasPending = this.intent !== null;
    this.intent = null;
    this.fulfilledEpoch = null;
    this.fulfilledEndpoint = null;
    if (!wasPending) return;
    this.intentListeners.forEach((listener) => listener(false));
  }

  subscribeToIntent(listener: PrimaryFocusIntentListener): () => void {
    this.intentListeners.add(listener);
    listener(this.intent !== null);
    return () => {
      this.intentListeners.delete(listener);
    };
  }

  register(
    target: PrimaryFocusTarget,
    endpoint: PrimaryFocusEndpoint,
  ): () => void {
    const key = targetKey(target);
    this.endpoints.set(key, endpoint);
    this.reconcile();
    return () => {
      if (this.endpoints.get(key) === endpoint) {
        this.endpoints.delete(key);
      }
    };
  }

  request(target: PrimaryFocusTarget): number {
    const wasPending = this.intent !== null;
    this.epoch += 1;
    this.intent = { epoch: this.epoch, target };
    this.fulfilledEpoch = null;
    this.fulfilledEndpoint = null;
    if (!wasPending) {
      this.intentListeners.forEach((listener) => listener(true));
    }
    this.reconcile();
    return this.epoch;
  }

  cancel(predicate: (target: PrimaryFocusTarget) => boolean): void {
    if (this.intent !== null && predicate(this.intent.target)) {
      this.clearIntent();
    }
  }

  hasIntent(predicate: (target: PrimaryFocusTarget) => boolean): boolean {
    return this.intent !== null && predicate(this.intent.target);
  }

  setInteractionActive(active: boolean): void {
    if (this.interactionActive === active) return;
    this.interactionActive = active;
    if (active) {
      this.clearIntent();
      return;
    }
    this.reconcile();
  }

  clearInteraction(): void {
    this.interactionActive = false;
  }

  reconcile(): boolean {
    const intent = this.intent;
    if (
      intent === null ||
      this.interactionActive ||
      !this.environment.documentVisible()
    ) {
      return false;
    }
    const endpoint = this.endpoints.get(targetKey(intent.target));
    if (endpoint === undefined || !endpoint.isEligible()) return false;
    if (
      this.fulfilledEpoch === intent.epoch &&
      this.fulfilledEndpoint === endpoint &&
      endpoint.containsActiveElement(this.environment.activeElement())
    ) {
      return true;
    }

    endpoint.focus();
    if (this.intent?.epoch !== intent.epoch) return false;
    if (!endpoint.containsActiveElement(this.environment.activeElement())) {
      return false;
    }
    this.fulfilledEpoch = intent.epoch;
    this.fulfilledEndpoint = endpoint;
    return true;
  }

  handleFocusIn(target: Element | null): void {
    const intent = this.intent;
    if (intent === null) return;
    const endpoint = this.endpoints.get(targetKey(intent.target));
    if (endpoint?.containsActiveElement(target) === true) {
      this.fulfilledEpoch = intent.epoch;
      this.fulfilledEndpoint = endpoint;
      return;
    }
    if (this.interactionActive) {
      this.clearIntent();
      return;
    }
    this.clearIntent();
  }

  reset(): void {
    this.endpoints.clear();
    this.clearIntent();
    this.interactionActive = false;
    this.epoch = 0;
  }
}

const coordinator = new PrimaryFocusCoordinator({
  activeElement: () =>
    document.activeElement instanceof Element ? document.activeElement : null,
  documentVisible: () => document.visibilityState === "visible",
});

export function registerPrimaryFocusEndpoint(
  target: PrimaryFocusTarget,
  endpoint: PrimaryFocusEndpoint,
): () => void {
  return coordinator.register(target, endpoint);
}

export function requestPrimaryFocus(target: PrimaryFocusTarget): number {
  return coordinator.request(target);
}

export function cancelPrimaryFocusIntent(
  predicate: (target: PrimaryFocusTarget) => boolean,
): void {
  coordinator.cancel(predicate);
}

export function hasPrimaryFocusIntent(
  predicate: (target: PrimaryFocusTarget) => boolean,
): boolean {
  return coordinator.hasIntent(predicate);
}

export function subscribeToPrimaryFocusIntent(
  listener: PrimaryFocusIntentListener,
): () => void {
  return coordinator.subscribeToIntent(listener);
}

export function reconcilePrimaryFocus(): boolean {
  return coordinator.reconcile();
}

export function setPrimaryFocusInteractionActive(active: boolean): void {
  coordinator.setInteractionActive(active);
}

export function clearPrimaryFocusInteraction(): void {
  coordinator.clearInteraction();
}

export function handlePrimaryFocusIn(target: Element | null): void {
  coordinator.handleFocusIn(target);
}

export function resetPrimaryFocusCoordinatorForTests(): void {
  coordinator.reset();
}
