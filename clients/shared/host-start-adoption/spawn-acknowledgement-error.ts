export class SpawnAcknowledgementTimeoutError extends Error {
  constructor() {
    super("host-start supervisor did not acknowledge its spawn");
    this.name = "SpawnAcknowledgementTimeoutError";
  }
}
