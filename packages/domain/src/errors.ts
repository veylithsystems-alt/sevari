export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}

/** A rule in the contract refused an action. `code` names the invariant or section. */
export class ContractViolation extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ContractViolation';
    this.code = code;
  }
}
