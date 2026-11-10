/** Raised when invoice or catalog input is malformed. Callers must fail closed. */
export class InvoiceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceInputError';
  }
}
