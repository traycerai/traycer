import { EMPTY_OCCUPIED_WRITE_FIELDS } from "../write-field-key";

export const idleWriteAdmission = {
  occupiedWriteFields: EMPTY_OCCUPIED_WRITE_FIELDS,
  writeSessionEnded: false,
};

export function forwardWriteSubmission<Intent, Result>(
  enqueue: (intent: Intent) => Result,
): (intent: Intent) => Promise<Awaited<Result>> {
  return (intent) => Promise.resolve(enqueue(intent));
}
