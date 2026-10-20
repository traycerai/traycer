import type { ViewReplicaRowScope } from "./row-scope";

/** One row of a page, with the scope that authorized it. */
export interface ViewReplicaRow {
  readonly scope: ViewReplicaRowScope;
  /** The row as the wire delivered it; structured-cloneable. */
  readonly value: unknown;
}

/** A page taken apart for storage: its rows, and everything else. */
export interface ViewReplicaPageParts {
  readonly shell: unknown;
  readonly rows: readonly ViewReplicaRow[];
}

/**
 * The local contribution a cached page must carry before it may paint: the
 * rows, tombstones and completeness only this device knows (History's is
 * P7's). `apply` returns `null` while the contribution cannot be applied yet,
 * and a paint is then refused rather than shown without it.
 */
export interface ViewReplicaLocalContribution<Page> {
  apply(page: Page): Page | null;
}

/**
 * The result of asking to paint a cached page. Only an admitted page is ever
 * painted; `contribution` names the registration it was admitted under, so a
 * paint admitted before a contribution was registered stops being current
 * the moment one is.
 */
export type ViewReplicaPaintAdmission<Page> =
  | {
      readonly admitted: true;
      readonly page: Page;
      readonly contribution: ViewReplicaContributionToken | null;
    }
  | { readonly admitted: false; readonly reason: "contribution-unavailable" };

/** Identifies one registration of a local contribution. */
export interface ViewReplicaContributionToken {
  readonly service: string;
}

export interface ViewReplicaContributionRegistration {
  /** The contribution's data changed: held paints are admitted again. */
  changed(): void;
  unregister(): void;
}

export interface ViewReplicaServiceSpec<Page> {
  /** The logical service: the RPC method that answers the page. */
  readonly service: string;
  /** This client's canonical version of that method. */
  readonly canonicalVersion: string;
  split(page: Page): ViewReplicaPageParts;
  /**
   * Reassembles and VALIDATES a stored page against the current canonical
   * schema; `null` (unparseable, or a shape this client does not speak) is a
   * miss. Never projects one shape onto another.
   */
  join(shell: unknown, rows: readonly unknown[]): Page | null;
  /**
   * The page as it paints from the replica: stating that it is not the
   * serving tier's current answer, and which scopes were withdrawn from it
   * after it was written.
   */
  asCached(page: Page, withdrawnScopes: readonly ViewReplicaRowScope[]): Page;
}

/**
 * A family the replica caches, with its paint gate.
 *
 * The gate is where a page read from disk is admitted to the screen. With no
 * local contribution registered, a cached page paints as it is. Once one is
 * registered, a cached page paints only after the contribution was applied
 * to it, and never without it.
 */
export class ViewReplicaService<Page> {
  readonly service: string;
  readonly canonicalVersion: string;
  readonly #spec: ViewReplicaServiceSpec<Page>;
  #contribution: {
    readonly token: ViewReplicaContributionToken;
    readonly value: ViewReplicaLocalContribution<Page>;
  } | null = null;
  readonly #listeners = new Set<() => void>();
  #version = 0;

  constructor(spec: ViewReplicaServiceSpec<Page>) {
    this.service = spec.service;
    this.canonicalVersion = spec.canonicalVersion;
    this.#spec = spec;
  }

  split(page: Page): ViewReplicaPageParts {
    return this.#spec.split(page);
  }

  join(shell: unknown, rows: readonly unknown[]): Page | null {
    return this.#spec.join(shell, rows);
  }

  asCached(page: Page, withdrawnScopes: readonly ViewReplicaRowScope[]): Page {
    return this.#spec.asCached(page, withdrawnScopes);
  }

  /**
   * Registers the local contribution every cached first paint must carry.
   * One per service. `changed` re-admits held paints when the contribution's
   * own data moves (a local row added, a tombstone recorded).
   */
  registerLocalContribution(
    contribution: ViewReplicaLocalContribution<Page>,
  ): ViewReplicaContributionRegistration {
    if (this.#contribution !== null) {
      throw new Error(
        `${this.service} already has a local contribution registered`,
      );
    }
    const registration = {
      token: { service: this.service },
      value: contribution,
    };
    this.#contribution = registration;
    this.#emit();
    return {
      changed: () => {
        if (this.#contribution === registration) this.#emit();
      },
      unregister: () => {
        if (this.#contribution !== registration) return;
        this.#contribution = null;
        this.#emit();
      },
    };
  }

  /** Admits a cached page for its first paint, applying the contribution. */
  admitFirstPaint(page: Page): ViewReplicaPaintAdmission<Page> {
    const contribution = this.#contribution;
    if (contribution === null) {
      return { admitted: true, page, contribution: null };
    }
    const contributed = contribution.value.apply(page);
    if (contributed === null) {
      return { admitted: false, reason: "contribution-unavailable" };
    }
    return {
      admitted: true,
      page: contributed,
      contribution: contribution.token,
    };
  }

  /**
   * Whether `admission` may paint NOW: admitted, under the registration that
   * is current. A paint admitted without a contribution that has since been
   * registered is refused.
   */
  paintableFrom(admission: ViewReplicaPaintAdmission<Page>): Page | null {
    if (!admission.admitted) return null;
    const current = this.#contribution?.token ?? null;
    return admission.contribution === current ? admission.page : null;
  }

  /** Fires when the registration changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Increments with every registration change. */
  version(): number {
    return this.#version;
  }

  #emit(): void {
    this.#version += 1;
    for (const listener of [...this.#listeners]) listener();
  }
}
