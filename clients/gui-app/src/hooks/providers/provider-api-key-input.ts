/** Mutation records retain this carrier after its value has been consumed. */
export class ProviderApiKeyInput {
  #value: string | null;

  constructor(value: string) {
    this.#value = value;
  }

  take(): string {
    const value = this.#value;
    this.clear();
    if (value === null || value.length === 0) {
      throw new Error("Provider key input is unavailable");
    }
    return value;
  }

  clear(): void {
    this.#value = null;
  }
}
