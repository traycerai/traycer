export class StaleHostBindingAuthorityError extends Error {
  constructor(hostId: string) {
    super(`Host '${hostId}' changed before its request authority was captured`);
    this.name = "StaleHostBindingAuthorityError";
  }
}
