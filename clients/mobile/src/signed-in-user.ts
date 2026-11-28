import type {
  StoredCredentials,
  TokenStoreChange,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";

/** The stored sign-in and its change feed (`ITokenStore` satisfies this). */
export interface StoredSignInSource {
  get(): Promise<StoredCredentials | null>;
  subscribe(listener: (change: TokenStoreChange) => void): Disposable;
}

/**
 * Who is signed in, for a consumer that acts on it later. `undefined` until
 * the first read or change event answers. A change event always wins: a read
 * still in flight never replaces what an event has said. A read that fails
 * leaves the answer unknown, and the consumer's next edge reads again
 * (`readIfUnknown`).
 */
export class SignedInUser {
  private current: string | null | undefined = undefined;
  private reading = false;

  /**
   * `onChange` runs on every change of user, the first answer included, with
   * the user before it (`undefined` for the first answer).
   */
  constructor(
    private readonly source: StoredSignInSource,
    private readonly onChange: (
      userId: string | null,
      previous: string | null | undefined,
    ) => void,
  ) {}

  get userId(): string | null | undefined {
    return this.current;
  }

  start(): void {
    this.source.subscribe((change) => this.apply(change.userId));
    this.readIfUnknown();
  }

  readIfUnknown(): void {
    if (this.current !== undefined || this.reading) return;
    this.reading = true;
    this.source.get().then(
      (stored) => {
        this.reading = false;
        if (this.current === undefined) this.apply(stored?.user.id ?? null);
      },
      () => {
        this.reading = false;
      },
    );
  }

  private apply(userId: string | null): void {
    if (userId === this.current) return;
    const previous = this.current;
    this.current = userId;
    this.onChange(userId, previous);
  }
}
