export type DraftAuthoritySlot =
  | { readonly kind: "task"; readonly id: string }
  | { readonly kind: "chat"; readonly id: string }
  | { readonly kind: "landing"; readonly id: string };

export interface DraftAuthorityReference {
  readonly slot: DraftAuthoritySlot;
  readonly occurrence: string;
}

export interface DraftAuthorityVersion extends DraftAuthorityReference {
  readonly version: string;
}

export type DraftAuthorityExpectation =
  | { readonly kind: "absent"; readonly slot: DraftAuthoritySlot }
  | { readonly kind: "current"; readonly draft: DraftAuthorityVersion };

export interface DraftAuthorityActor {
  readonly accountId: string;
  readonly sessionGeneration: string;
}

export type DraftAuthorityEffectSource =
  | {
      readonly kind: "restored-draft";
      readonly draft: DraftAuthorityVersion;
      readonly returnAccountId: string;
    }
  | {
      readonly kind: "pending-outbox";
      readonly sendId: string;
      readonly generation: number;
    };

export interface DraftAuthorityManifest {
  readonly digests: readonly string[];
}

export interface DraftAuthorityVerifiedBlob {
  readonly digest: string;
  readonly blob: Blob;
}

export interface DraftAuthorityBorrowedStore<Key> {
  read(key: Key): Promise<unknown>;
  write(key: Key, value: unknown): Promise<void>;
  remove(key: Key): Promise<void>;
}

type DraftAuthorityRecoveryKey = readonly [accountId: string, digest: string];

export interface DraftAuthorityRecoveryStores {
  readonly blobs: DraftAuthorityBorrowedStore<DraftAuthorityRecoveryKey>;
  readonly refs: DraftAuthorityBorrowedStore<DraftAuthorityRecoveryKey>;
  readonly budget: DraftAuthorityBorrowedStore<string>;
}

export interface DraftAuthorityOperation {
  readonly id: string;
  readonly actor: DraftAuthorityActor | null;
}

export type DraftAuthorityMutationResult<Receipt, Current = never> =
  | { readonly kind: "committed" | "replayed"; readonly receipt: Receipt }
  | { readonly kind: "conflict"; readonly current: Current | null }
  | { readonly kind: "denied" | "invalid" | "unavailable" | "unverified" };

export type DraftAuthorityPayload = Readonly<Record<string, unknown>>;

export type DraftAuthorityRecord =
  | {
      readonly kind: "live";
      readonly draft: DraftAuthorityVersion;
      readonly payload: DraftAuthorityPayload;
      readonly manifest: DraftAuthorityManifest;
      readonly returnAccountId: string | null;
      readonly recoveryAccountId: string | null;
    }
  | { readonly kind: "tombstone"; readonly draft: DraftAuthorityVersion };

export interface DraftAuthorityHostRetirement {
  readonly accountId: string;
  readonly hostId: string;
  readonly draftId: string;
  readonly kind: "delete" | "retract";
}

export interface DraftAuthorityEditReceipt {
  readonly operationId: string;
  readonly accountId: string | null;
  readonly draft: DraftAuthorityVersion;
  readonly kind: DraftAuthorityRecord["kind"];
}

export type DraftAuthorityReadResult =
  | { readonly kind: "current"; readonly record: DraftAuthorityRecord }
  | { readonly kind: "missing" | "unavailable" };

export type DraftAuthorityLandingRead<Payload> =
  | {
      readonly kind: "live";
      readonly draft: DraftAuthorityVersion;
      readonly payload: Payload;
      readonly manifest: DraftAuthorityManifest;
    }
  | { readonly kind: "missing" | "replaced" | "tombstoned" | "unavailable" };

export type DraftAuthorityLandingFlush =
  | {
      readonly kind: "committed";
      readonly draft: DraftAuthorityVersion;
      readonly manifest: DraftAuthorityManifest;
    }
  | { readonly kind: "conflict" | "unavailable" };

export interface DraftAuthorityInstallSource {
  readonly kind: "stash" | "prompt-handoff";
  readonly id: string;
  readonly digest: string;
}
