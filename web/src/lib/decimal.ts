// Numbers as typed in the forms. Either separator marks the decimals, except
// where it would read as the active language's thousands: "1.000" in Portuguese
// and "1,000" in English are refused rather than silently taken as 1.
import { getLocale } from "../i18n";

const PLAIN = /^-?(\d+[.,]?\d*|[.,]\d+)$/;

export function isDecimal(text: string): boolean {
  return PLAIN.test(text.trim());
}

export function looksGrouped(text: string): boolean {
  const separator = getLocale() === "pt" ? "\\." : ",";
  return new RegExp(`^-?[1-9]\\d{0,2}${separator}\\d{3}$`).test(text.trim());
}

/** The value of a text that passed isDecimal. */
export function toNumber(text: string): number {
  return Number(text.trim().replace(",", "."));
}
