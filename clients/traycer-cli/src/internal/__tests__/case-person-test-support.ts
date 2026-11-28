/**
 * The person one test case signs in as. The process-scope judge of a sign-in
 * keeps its facts per person (`signInFactsByUser`) and the mint order stores
 * keep theirs per process, so a case that records a refusal for a person must
 * not be the person a later case asks about: each case calls this once, in its
 * setup, and uses the returned values wherever it names its person.
 */
export interface CasePerson {
  readonly userId: string;
  readonly signIn: string;
}

let casesSeen = 0;

export function nextCasePerson(): CasePerson {
  casesSeen += 1;
  return {
    userId: `case-user-${casesSeen}`,
    signIn: `case-sign-in-${casesSeen}`,
  };
}
