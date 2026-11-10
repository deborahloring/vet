// Exact money handling in integer cents. No binary floating-point arithmetic on amounts.

import { InvoiceInputError } from './errors.ts';

const AMOUNT = /^(\d{1,7})\.(\d{2})$/;

/** Parses a non-negative two-decimal amount such as "123.45" (an optional leading "$" is allowed). */
export function parseCents(text: string, field: string): number {
  const trimmed = typeof text === 'string' ? text.trim().replace(/^\$/, '') : '';
  const match = AMOUNT.exec(trimmed);
  if (!match) {
    throw new InvoiceInputError(`${field}: expected an amount like 12.34, received ${JSON.stringify(text)}`);
  }
  return Number(match[1]) * 100 + Number(match[2]);
}

/** Formats cents as a US dollar string, e.g. 1234 -> "$12.34", -500 -> "-$5.00". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}$${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

/** Applies numerator/denominator to a non-negative cent amount, rounding half up to whole cents. */
export function applyRateHalfUp(cents: number, numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new InvoiceInputError(`rate base must be a non-negative whole number of cents, received ${cents}`);
  }
  return Math.floor((cents * numerator * 2 + denominator) / (denominator * 2));
}
