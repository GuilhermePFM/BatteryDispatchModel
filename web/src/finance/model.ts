// The investment layer of docs/model/model.md §8. Pure functions, run in the
// browser on the monthly blocks of a result: no input here reaches the solver
// or the params hash. scripts/finance_golden_vectors.py is an independent
// reference for everything in this file.
import ipca from "./ipca-index.json";

/** Contract years, August to July (§8.2). */
export const CONTRACT_YEARS = 15;
/** The months from the May 2026 base to July 2028, as years (§8.2). */
export const FIRST_INDEX_YEARS = 26 / 12;
export const BASE_MONTH = "2026-05";
/** The month K is paid, k = 0 (§8.2). */
export const SUPPLY_START_MONTH = "2028-08";
/** Delivered hours the contract requires at full power (CRCAP 5.1.1). */
export const CONTRACT_HOURS = 4;
/** The efficiency the reimbursement of CRCAP 8.1 is measured against. */
export const CONTRACT_EFFICIENCY = 0.85;
/** CRCAP 8.1.3 waives the reimbursement under this many injections in a month. */
export const MIN_INJECTIONS = 4;

/** Days of each calendar month in the 365-day balanced year (§8.3). */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Keeps a battery sized at exactly 4 h from tripping on rounding alone. */
const CAPACITY_TOLERANCE = 1e-9;

/** The monthly block of a result case (contracts/v2/result.schema.json). */
export interface MonthlyBlock {
  month: string[];
  days: number[];
  value_brl: number[];
  charge_mwh: number[];
  injected_mwh: number[];
  charge_cost_brl: number[];
  storage_end_mwh: number[];
  injections: number[];
}

/** The physical battery as §8.4 needs it. */
export interface Physical {
  powerMw: number;
  volumeMwh: number;
  dischargeEfficiency: number;
  /** rho of §2, a fraction of the nominal volume per cycle. */
  degradationPerCycle: number;
  /** nu of §8.4. */
  cyclesPerYear: number;
}

/** The inputs of §8.1, as fractions and BRL. */
export interface FinanceInputs {
  /** RF_0, BRL/MW-year at the May 2026 base. */
  fixedRevenue: number;
  ipca: number;
  discountRate: number;
  realPldGrowth: number;
  captureFactor: number;
  /** K, in BRL of the month the model was run. */
  capex: number;
  /** The years from that month to the payment at k = 0, in August 2028. */
  capexIndexYears: number;
  /** O_0, BRL/year at the May 2026 base. */
  opex: number;
  revenueTax: number;
  incomeTax: number;
  depreciationYears: number;
  calendarFade: number;
  /** x_R, the cost of the whole volume as a share of K. */
  replacementShare: number;
  /** Pi_k, the same allowance each contract year, BRL. */
  penaltyAllowance: number;
  /** The replacement schedule of case M, as contract years. */
  merchantReplacementYears: number[];
}

export interface YearFlow {
  year: number;
  capacity: number;
  revenue: number;
  opex: number;
  depreciation: number;
  tax: number;
  replacement: number;
  cashFlow: number;
}

export interface Evaluation {
  flows: YearFlow[];
  /** K_0, the nominal capex paid at k = 0. */
  capexPaid: number;
  npv: number;
  /** Null unless the flows have exactly one rate above -100% (§8.6). */
  irr: number | null;
  payback: number | null;
  discountedPayback: number | null;
  /** The contract years in which volume is bought. */
  replacements: number[];
  /** The share of E bought in each of those years. */
  replacementShares: number[];
}

/** a_k of §8.2. */
export function indexYears(year: number): number {
  return FIRST_INDEX_YEARS + (year - 1);
}

/** The years from the month the model was run to the start of supply, never negative. */
export function capexIndexYears(runMonth: string): number {
  return Math.max(0, (monthNumber(SUPPLY_START_MONTH) - monthNumber(runMonth)) / 12);
}

/** K_0 of §8.2. */
export function paidCapex(input: FinanceInputs): number {
  return input.capex * (1 + input.ipca) ** input.capexIndexYears;
}

export function realDiscountRate(discountRate: number, inflation: number): number {
  return (1 + discountRate) / (1 + inflation) - 1;
}

function monthNumber(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return y * 12 + (m - 1);
}

const KNOWN_MONTHS = Object.keys(ipca.index).sort();
const INDEX = ipca.index as Record<string, number>;

/**
 * The IPCA index of a month. Outside the published series it continues from the
 * nearest published month at the assumed rate, which covers the latest PLD
 * month before IBGE publishes it.
 */
export function ipcaIndex(month: string, inflation: number): number {
  const known = INDEX[month];
  if (known !== undefined) return known;
  const first = KNOWN_MONTHS[0];
  const last = KNOWN_MONTHS[KNOWN_MONTHS.length - 1];
  const nearest = month < first ? first : last;
  return INDEX[nearest] * (1 + inflation) ** ((monthNumber(month) - monthNumber(nearest)) / 12);
}

/** I_May2026 / I_m of §8.3. */
export function restatement(month: string, inflation: number): number {
  return INDEX[BASE_MONTH] / ipcaIndex(month, inflation);
}

/** §8.3 over monthly values: each calendar month carries its own weight. */
function balanced(block: MonthlyBlock, values: number[]): number {
  const sum = new Array<number>(12).fill(0);
  const days = new Array<number>(12).fill(0);
  block.month.forEach((month, i) => {
    const m = Number(month.slice(5, 7)) - 1;
    sum[m] += values[i];
    days[m] += block.days[i];
  });
  if (days.some((d) => d === 0)) throw new Error("A balanced year needs all twelve calendar months.");
  return sum.reduce((total, value, m) => total + (DAYS_IN_MONTH[m] / days[m]) * value, 0);
}

/** R_base of §8.3, at the May 2026 base. */
export function baseRevenue(block: MonthlyBlock, inflation: number): number {
  return balanced(
    block,
    block.value_brl.map((value, i) => value * restatement(block.month[i], inflation)),
  );
}

/** Ress_m of §8.5 (CRCAP 8.1) for one month, nominal. */
export function monthlyReimbursement(block: MonthlyBlock, i: number): number {
  const charged = block.charge_mwh[i];
  if (charged <= 0 || block.injections[i] < MIN_INJECTIONS) return 0;
  const before = i === 0 ? 0 : block.storage_end_mwh[i - 1];
  const accounted = (block.storage_end_mwh[i] + block.injected_mwh[i] - before) / CONTRACT_EFFICIENCY;
  return Math.max(0, charged - accounted) * (block.charge_cost_brl[i] / charged);
}

/** Ress_base of §8.5: the balanced-year sum at the May 2026 base. */
export function baseReimbursement(block: MonthlyBlock, inflation: number): number {
  return balanced(
    block,
    block.month.map((month, i) => monthlyReimbursement(block, i) * restatement(month, inflation)),
  );
}

/** h_j of §8.4. */
export function remainingCapacity(input: FinanceInputs, physical: Physical, yearsInService: number): number {
  const yearly = (1 - input.calendarFade) * (1 - physical.degradationPerCycle * physical.cyclesPerYear);
  return yearly ** yearsInService;
}

/**
 * The capacity of each year, as a share of E, and the share of E bought by year
 * (§8.4). Case C adds modules up to the contracted volume (CRCAP 7.7.1); case M
 * renews the whole volume on its schedule.
 */
function schedule(input: FinanceInputs, physical: Physical, topUp: boolean): { capacity: number[]; purchases: Map<number, number> } {
  const planned = new Set(input.merchantReplacementYears);
  const required = (CONTRACT_HOURS * physical.powerMw) / physical.dischargeEfficiency;
  const yearly = remainingCapacity(input, physical, 1);
  const capacity: number[] = [];
  const purchases = new Map<number, number>();
  let usable = physical.volumeMwh;
  for (let year = 1; year <= CONTRACT_YEARS; year++) {
    if (year > 1) usable *= yearly;
    if (topUp && year > 1 && usable < required * (1 - CAPACITY_TOLERANCE)) {
      purchases.set(year, (required - usable) / physical.volumeMwh);
      usable = required;
    } else if (!topUp && planned.has(year)) {
      purchases.set(year, 1);
      usable = physical.volumeMwh;
    }
    capacity.push(usable / physical.volumeMwh);
  }
  return { capacity, purchases };
}

/** The cash flows of §8.5, given each year's revenue. */
function cashFlows(input: FinanceInputs, capacity: number[], purchases: Map<number, number>, revenueOf: (year: number, capacity: number) => number): YearFlow[] {
  // K_0 is the price at k = 0, so the index of a purchase runs from there.
  const paid = paidCapex(input);
  const replacementCost = (year: number) =>
    input.replacementShare * (purchases.get(year) ?? 0) * paid * (1 + input.ipca) ** (indexYears(year) - FIRST_INDEX_YEARS);
  // Straight line on what was paid, starting the year after the payment: K_0 is paid at k = 0.
  const depreciation = new Array<number>(CONTRACT_YEARS + 1).fill(0);
  const spread = (amount: number, paidYear: number) => {
    for (let year = paidYear + 1; year <= Math.min(CONTRACT_YEARS, paidYear + input.depreciationYears); year++) {
      depreciation[year] += amount / input.depreciationYears;
    }
  };
  spread(paid, 0);
  for (const year of purchases.keys()) spread(replacementCost(year), year);

  let losses = 0;
  const flows: YearFlow[] = [];
  for (let year = 1; year <= CONTRACT_YEARS; year++) {
    const revenue = revenueOf(year, capacity[year - 1]);
    const net = (1 - input.revenueTax) * revenue;
    const opex = input.opex * (1 + input.ipca) ** indexYears(year);
    const taxable = net - opex - depreciation[year];
    const tax = input.incomeTax * Math.max(0, taxable - losses);
    losses = Math.max(0, losses - taxable);
    const replacement = replacementCost(year);
    flows.push({
      year,
      capacity: capacity[year - 1],
      revenue,
      opex,
      depreciation: depreciation[year],
      tax,
      replacement,
      cashFlow: net - opex - tax - replacement,
    });
  }
  return flows;
}

/** NPV at `rate` of a payment of K_0 at k = 0 and year-end flows. */
export function npv(rate: number, capex: number, cashFlows: number[]): number {
  return cashFlows.reduce((total, flow, i) => total + flow / (1 + rate) ** (i + 1), -capex);
}

function evaluatePolynomial(coefficients: number[], x: number): number {
  let value = 0;
  for (let i = coefficients.length - 1; i >= 0; i--) value = value * x + coefficients[i];
  return value;
}

/** How large rounding makes a polynomial's value near x. */
function evaluationScale(coefficients: number[], x: number): number {
  let value = 0;
  for (let i = coefficients.length - 1; i >= 0; i--) value = value * x + Math.abs(coefficients[i]);
  return value;
}

/**
 * The distinct positive roots, ascending. The roots of the derivative split the
 * half-line into intervals where the polynomial is monotonic, so each interval
 * holds at most one crossing, and a double root shows up at a critical point.
 */
export function positiveRoots(input: number[]): number[] {
  let low = 0;
  while (low < input.length && input[low] === 0) low++;
  let high = input.length - 1;
  while (high >= low && input[high] === 0) high--;
  if (high <= low) return [];
  const coefficients = input.slice(low, high + 1);
  const degree = coefficients.length - 1;
  const lead = Math.abs(coefficients[degree]);
  const bound = 1 + Math.max(...coefficients.slice(0, degree).map((c) => Math.abs(c) / lead));

  const critical = positiveRoots(coefficients.slice(1).map((c, i) => c * (i + 1))).filter((x) => x < bound);
  const points = [0, ...critical, bound];
  const isZero = (x: number) => Math.abs(evaluatePolynomial(coefficients, x)) <= 1e-11 * evaluationScale(coefficients, x);
  const roots: number[] = [];
  const add = (x: number) => {
    if (!roots.length || x - roots[roots.length - 1] > 1e-9 * Math.max(1, x)) roots.push(x);
  };
  for (let i = 0; i < points.length - 1; i++) {
    let lo = points[i];
    let hi = points[i + 1];
    if (i > 0 && isZero(lo)) add(lo);
    const fLo = evaluatePolynomial(coefficients, lo);
    const fHi = evaluatePolynomial(coefficients, hi);
    if (isZero(lo) || isZero(hi) || Math.sign(fLo) === Math.sign(fHi)) continue;
    for (let step = 0; step < 200 && hi - lo > 1e-15 * Math.max(1, hi); step++) {
      const mid = (lo + hi) / 2;
      if (Math.sign(evaluatePolynomial(coefficients, mid)) === Math.sign(fLo)) lo = mid;
      else hi = mid;
    }
    add((lo + hi) / 2);
  }
  return roots;
}

/** The IRR, or null unless NPV has exactly one root above -100% (§8.6). */
export function irr(capex: number, flows: number[]): number | null {
  const roots = positiveRoots([-capex, ...flows]);
  return roots.length === 1 ? 1 / roots[0] - 1 : null;
}

/** The first year cumulative flows reach K_0, or null. */
export function payback(capex: number, flows: number[], rate = 0): number | null {
  let total = 0;
  for (let i = 0; i < flows.length; i++) {
    total += flows[i] / (1 + rate) ** (i + 1);
    if (total >= capex) return i + 1;
  }
  return null;
}

function summarise(input: FinanceInputs, flows: YearFlow[], purchases: Map<number, number>): Evaluation {
  const values = flows.map((f) => f.cashFlow);
  const capexPaid = paidCapex(input);
  return {
    flows,
    capexPaid,
    npv: npv(input.discountRate, capexPaid, values),
    irr: irr(capexPaid, values),
    payback: payback(capexPaid, values),
    discountedPayback: payback(capexPaid, values, input.discountRate),
    replacements: [...purchases.keys()],
    replacementShares: [...purchases.values()],
  };
}

/** Case C of §8.5. `reimbursement` is Ress_base. */
export function evaluateContracted(input: FinanceInputs, physical: Physical, reimbursement: number): Evaluation {
  const { capacity, purchases } = schedule(input, physical, true);
  const flows = cashFlows(input, capacity, purchases, (year) => {
    const a = indexYears(year);
    return (
      input.fixedRevenue * physical.powerMw * (1 + input.ipca) ** a -
      reimbursement * ((1 + input.realPldGrowth) * (1 + input.ipca)) ** a -
      input.penaltyAllowance
    );
  });
  return summarise(input, flows, purchases);
}

/** Case M of §8.5. `revenue` is R_base. */
export function evaluateMerchant(input: FinanceInputs, physical: Physical, revenue: number): Evaluation {
  const { capacity, purchases } = schedule(input, physical, false);
  const flows = cashFlows(input, capacity, purchases, (year, h) => {
    return input.captureFactor * revenue * h * ((1 + input.realPldGrowth) * (1 + input.ipca)) ** indexYears(year);
  });
  return summarise(input, flows, purchases);
}

/** The x >= 0 where a falling f crosses zero, or null when f(0) < 0 or it never does. */
function fallingRoot(f: (x: number) => number, start: number, limit: number): number | null {
  const atZero = f(0);
  if (atZero < 0) return null;
  if (atZero === 0) return 0;
  let hi = start;
  while (f(hi) > 0) {
    hi *= 2;
    if (hi > limit) return null;
  }
  let lo = 0;
  for (let step = 0; step < 200 && hi - lo > 1e-9 * Math.max(1, hi); step++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The K with NPV = 0, for either case (§8.6). Null when no K >= 0 pays. */
export function maxViableCapex(input: FinanceInputs, evaluate: (next: FinanceInputs) => Evaluation): number | null {
  return fallingRoot((capex) => evaluate({ ...input, capex }).npv, Math.max(input.capex, 1e6), 1e15);
}

/** The RF_0 with NPV^C = 0, BRL/MW-year (§8.6). Zero when the project pays with no fixed revenue. */
export function minViableBid(input: FinanceInputs, physical: Physical, reimbursement: number): number | null {
  const at = (fixedRevenue: number) => evaluateContracted({ ...input, fixedRevenue }, physical, reimbursement).npv;
  if (at(0) >= 0) return 0;
  const root = fallingRoot((x) => -at(x), 1e5, 1e12);
  return root;
}
