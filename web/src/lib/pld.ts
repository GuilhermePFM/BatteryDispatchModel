// The hourly PLD upload check. Mirrors battery_plan.data_io.check_pld_csv and
// services/api/internal/prices/pld.go: the shared cases are in
// contracts/examples/pld-upload-verdicts.json.

export const PLD_CSV_HEADER = "hora,submercado,pld";

const SUBMARKETS = new Set(["SE", "S", "NE", "N"]);

/** What each rejection tells the user, word for word the Python and Go tables. */
export const PLD_ERRORS = {
  encoding: "The file is not UTF-8 text.",
  empty: "The file is empty.",
  header: `The header row must be: ${PLD_CSV_HEADER}`,
  no_rows: "The file has a header row but no prices.",
  fields: "Every row must be: hora,submercado,pld",
  timestamp: "hora must be a local time as YYYY-MM-DDTHH:00.",
  offset: "hora must be local market time, with no UTC offset.",
  off_hour: "hora must fall on the hour.",
  submarket: "submercado must be SE, S, NE or N.",
  price: "pld must be a plain decimal number in BRL/MWh.",
  non_positive: "pld must be greater than zero.",
  duplicate: "This hour and submercado already appear earlier in the file.",
  order: "Rows must be in time order.",
  gap: "Hours must be consecutive, with no gaps.",
  incomplete: "Each hour must have all four submercados.",
  partial_day: "The file must hold whole days, from 00:00 to 23:00.",
} as const;

export type PldErrorCode = keyof typeof PLD_ERRORS;

/** Why a file is rejected: a stable code, the line to fix, and the message for it. */
export interface PldProblem {
  code: PldErrorCode;
  line: number;
  message: string;
}

interface Row {
  hour: number;
  submarket: string;
  line: number;
}

const TIMESTAMP = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})$/;
const WITH_OFFSET =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$/;
const PRICE = /^-?[0-9]+(\.[0-9]+)?$/;

function problem(code: PldErrorCode, line: number): PldProblem {
  return { code, line, message: `line ${line}: ${PLD_ERRORS[code]}` };
}

function parseRow(text: string, line: number): Row | PldProblem {
  const fields = text.split(",");
  if (fields.length !== 3) return problem("fields", line);
  const [hora, submarket, price] = fields;

  if (WITH_OFFSET.test(hora)) return problem("offset", line);
  const match = TIMESTAMP.exec(hora);
  if (!match) return problem("timestamp", line);
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (year < 1900 || year > 2199 || hour > 23 || minute > 59) return problem("timestamp", line);
  // Date.UTC rolls 30 February into March; a changed day means it was not real.
  const ms = Date.UTC(year, month - 1, day, hour, minute);
  const back = new Date(ms);
  if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return problem("timestamp", line);
  }
  if (minute !== 0) return problem("off_hour", line);

  if (!SUBMARKETS.has(submarket)) return problem("submarket", line);

  if (!PRICE.test(price)) return problem("price", line);
  const value = Number(price);
  if (!Number.isFinite(value)) return problem("price", line);
  if (value <= 0) return problem("non_positive", line);

  return { hour: ms / 3_600_000, submarket, line };
}

function checkSeries(rows: Row[]): PldProblem | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.hour}|${row.submarket}`;
    if (seen.has(key)) return problem("duplicate", row.line);
    seen.add(key);
  }

  for (let i = 1; i < rows.length; i++) {
    if (rows[i].hour < rows[i - 1].hour) return problem("order", rows[i].line);
  }

  for (let start = 0; start < rows.length; ) {
    if (start > 0 && rows[start].hour !== rows[start - 1].hour + 1) {
      return problem("gap", rows[start].line);
    }
    let end = start;
    while (end < rows.length && rows[end].hour === rows[start].hour) end++;
    if (end - start !== SUBMARKETS.size) return problem("incomplete", rows[start].line);
    start = end;
  }

  const hourOfDay = (hour: number) => ((hour % 24) + 24) % 24;
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (hourOfDay(first.hour) !== 0) return problem("partial_day", first.line);
  if (hourOfDay(last.hour) !== 23) return problem("partial_day", last.line);
  return null;
}

/** The first defect of a PLD file, or null when it is accepted. */
export function checkPldCsv(data: Uint8Array): PldProblem | null {
  let text: string;
  try {
    // ignoreBOM keeps the mark in the text, so exactly one is removed, as in Python and Go.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return problem("encoding", 1);
  }
  if (text.startsWith("﻿")) text = text.slice(1);

  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return problem("empty", 1);
  if (lines[0] !== PLD_CSV_HEADER) return problem("header", 1);
  if (lines.length === 1) return problem("no_rows", 1);

  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseRow(lines[i], i + 1);
    if ("code" in row) return row;
    rows.push(row);
  }
  return checkSeries(rows);
}
