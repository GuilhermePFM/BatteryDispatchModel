"""Write web/src/finance/golden-vectors.json, the reference for the finance module.

    uv run python scripts/finance_golden_vectors.py

An independent implementation of docs/model/model.md §8: it shares no code with
web/src/finance/model.ts and uses other numerics. Money runs in 60-digit
decimals, and the IRR's root count comes from an exact Sturm sequence over
rationals, where the browser isolates roots in floating point.
"""

from __future__ import annotations

import json
from decimal import Decimal, getcontext
from fractions import Fraction
from itertools import pairwise
from pathlib import Path
from typing import Any

getcontext().prec = 60

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "web" / "src" / "finance" / "golden-vectors.json"
IPCA = json.loads((ROOT / "web" / "src" / "finance" / "ipca-index.json").read_text())["index"]
EXAMPLE = json.loads((ROOT / "contracts" / "examples" / "v2" / "result.example.json").read_text())

YEARS = 15
DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
TOLERANCE = Decimal("1e-9")


def dec(value: float | int | str) -> Decimal:
    """The shortest decimal of a JSON number, so both sides read the same input."""
    return Decimal(repr(value)) if isinstance(value, float) else Decimal(value)


def a(year: int) -> Decimal:
    return Decimal(26) / Decimal(12) + (year - 1)


def month_count(month: str) -> int:
    return int(month[:4]) * 12 + int(month[5:7]) - 1


def index(month: str, inflation: Decimal) -> Decimal:
    if month in IPCA:
        return dec(IPCA[month])
    known = sorted(IPCA)
    nearest = known[0] if month < known[0] else known[-1]
    return dec(IPCA[nearest]) * (1 + inflation) ** (
        Decimal(month_count(month) - month_count(nearest)) / 12
    )


def balanced(months: list[str], days: list[int], values: list[Decimal]) -> Decimal:
    total = Decimal(0)
    for calendar in range(1, 13):
        rows = [i for i, month in enumerate(months) if int(month[5:7]) == calendar]
        observed = sum(days[i] for i in rows)
        total += Decimal(DAYS[calendar - 1]) / observed * sum(values[i] for i in rows)
    return total


def base_revenue(block: dict[str, list[Any]], inflation: Decimal) -> Decimal:
    base = dec(IPCA["2026-05"])
    values = [
        dec(v) * base / index(m, inflation)
        for v, m in zip(block["value_brl"], block["month"], strict=True)
    ]
    return balanced(block["month"], block["days"], values)


def base_reimbursement(block: dict[str, list[Any]], inflation: Decimal) -> Decimal:
    base = dec(IPCA["2026-05"])
    values = []
    for i, month in enumerate(block["month"]):
        charged = dec(block["charge_mwh"][i])
        if charged <= 0 or block["injections"][i] < 4:
            values.append(Decimal(0))
            continue
        before = dec(block["storage_end_mwh"][i - 1]) if i else Decimal(0)
        allowed = (
            dec(block["storage_end_mwh"][i]) + dec(block["injected_mwh"][i]) - before
        ) / Decimal("0.85")
        owed = max(Decimal(0), charged - allowed) * dec(block["charge_cost_brl"][i]) / charged
        values.append(owed * base / index(month, inflation))
    return balanced(block["month"], block["days"], values)


def paid_capex(case: dict[str, Any], capex: Decimal) -> Decimal:
    f = case["inputs"]
    return capex * (1 + dec(f["ipca"])) ** dec(f["capexIndexYears"])


def flows(case: dict[str, Any], capex: Decimal, bid: Decimal | None = None) -> dict[str, Any]:
    f, p = case["inputs"], case["physical"]
    pi, g = dec(f["ipca"]), dec(f["realPldGrowth"])
    fixed = dec(f["fixedRevenue"]) if bid is None else bid
    yearly = (1 - dec(f["calendarFade"])) * (
        1 - dec(p["degradationPerCycle"]) * dec(p["cyclesPerYear"])
    )
    contracted = case["case"] == "contracted"
    nominal = dec(p["volumeMwh"])
    # The stored MWh that deliver the contracted 4 h, as a share of E.
    needed = 4 * dec(p["powerMw"]) / dec(p["dischargeEfficiency"]) / nominal

    level, capacity, bought = Decimal(1), {}, {}
    for k in range(1, YEARS + 1):
        if k > 1:
            level *= yearly
        if contracted:
            if k > 1 and level < needed * (1 - TOLERANCE):
                bought[k] = needed - level
                level = needed
        elif k in f["merchantReplacementYears"]:
            bought[k] = Decimal(1)
            level = Decimal(1)
        capacity[k] = level

    # K_0 is the price at k = 0, so a purchase's index counts the years since then.
    paid_at_start = paid_capex(case, capex)
    cost = {
        k: dec(f["replacementShare"]) * share * paid_at_start * (1 + pi) ** (k - 1)
        for k, share in bought.items()
    }
    life = int(f["depreciationYears"])
    dep = dict.fromkeys(range(1, YEARS + 1), Decimal(0))
    for paid, amount in [(0, paid_at_start), *cost.items()]:
        for k in range(paid + 1, min(YEARS, paid + life) + 1):
            dep[k] += amount / life

    theta_r, theta_i = dec(f["revenueTax"]), dec(f["incomeTax"])
    losses, out = Decimal(0), []
    for k in range(1, YEARS + 1):
        grown = ((1 + g) * (1 + pi)) ** a(k)
        if contracted:
            revenue = (
                fixed * dec(p["powerMw"]) * (1 + pi) ** a(k)
                - dec(case["reimbursement"]) * grown
                - dec(f["penaltyAllowance"])
            )
        else:
            revenue = dec(f["captureFactor"]) * dec(case["revenue"]) * capacity[k] * grown
        opex = dec(f["opex"]) * (1 + pi) ** a(k)
        income = (1 - theta_r) * revenue - opex - dep[k]
        tax = theta_i * max(Decimal(0), income - losses)
        losses = max(Decimal(0), losses - income)
        out.append((1 - theta_r) * revenue - opex - tax - cost.get(k, Decimal(0)))
    return {"cash": out, "replacements": list(bought), "capacity": [capacity[k] for k in capacity]}


def net_present(rate: Decimal, capex: Decimal, cash: list[Decimal]) -> Decimal:
    return sum(
        (c / (1 + rate) ** (i + 1) for i, c in enumerate(cash)),
        -capex,
    )


def trim(poly: list[Fraction]) -> list[Fraction]:
    while poly and poly[-1] == 0:
        poly = poly[:-1]
    return poly


def remainder(u: list[Fraction], v: list[Fraction]) -> list[Fraction]:
    u = list(u)
    while len(u) >= len(v):
        factor = u[-1] / v[-1]
        shift = len(u) - len(v)
        for i, c in enumerate(v):
            u[i + shift] -= factor * c
        u = trim(u[:-1])
        if not u:
            break
    return u


def positive_root_count(coefficients: list[Fraction]) -> int:
    """Distinct roots in (0, inf), by Sturm's theorem."""
    poly = trim(coefficients)
    while poly and poly[0] == 0:
        poly = poly[1:]
    if len(poly) < 2:
        return 0
    chain = [poly, trim([c * i for i, c in enumerate(poly)][1:])]
    while len(chain[-1]) > 1:
        rest = remainder(chain[-2], chain[-1])
        if not rest:
            break
        chain.append([-c for c in rest])

    def changes(signs: list[int]) -> int:
        kept = [s for s in signs if s]
        return sum(1 for x, y in pairwise(kept) if x != y)

    at_zero = [(p[0] > 0) - (p[0] < 0) for p in chain]
    at_infinity = [(p[-1] > 0) - (p[-1] < 0) for p in chain]
    return changes(at_zero) - changes(at_infinity)


def irr(capex: Decimal, cash: list[Decimal]) -> Decimal | None:
    if positive_root_count([Fraction(-capex), *map(Fraction, cash)]) != 1:
        return None
    # NPV in v = 1 / (1 + x), bracketed by doubling from v = 1.
    value = lambda v: sum((c * v ** (i + 1) for i, c in enumerate(cash)), -capex)  # noqa: E731
    lo, hi = Decimal(0), Decimal(1)
    sign_lo = -1 if capex > 0 else 1
    while (value(hi) > 0) == (sign_lo > 0):
        hi *= 2
        if hi > 10**12:
            return None
    for _ in range(220):
        mid = (lo + hi) / 2
        if (value(mid) > 0) == (sign_lo > 0):
            lo = mid
        else:
            hi = mid
    return 1 / ((lo + hi) / 2) - 1


def payback(capex: Decimal, cash: list[Decimal], rate: Decimal) -> int | None:
    total = Decimal(0)
    for i, c in enumerate(cash):
        total += c / (1 + rate) ** (i + 1)
        if total >= capex:
            return i + 1
    return None


def bisect(falling: Any, start: Decimal) -> Decimal | None:
    if falling(Decimal(0)) < 0:
        return None
    hi = start
    while falling(hi) > 0:
        hi *= 2
        if hi > Decimal("1e16"):
            return None
    lo = Decimal(0)
    for _ in range(200):
        mid = (lo + hi) / 2
        if falling(mid) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def number(value: Decimal | None) -> float | None:
    return None if value is None else float(value)


def expected(case: dict[str, Any]) -> dict[str, Any]:
    f = case["inputs"]
    capex, rate = dec(f["capex"]), dec(f["discountRate"])
    solved = flows(case, capex)
    paid = paid_capex(case, capex)
    cash = solved["cash"]
    result: dict[str, Any] = {
        "cashFlows": [float(c) for c in cash],
        "capacity": [float(c) for c in solved["capacity"]],
        "replacements": solved["replacements"],
        "npv": float(net_present(rate, paid, cash)),
        "irr": number(irr(paid, cash)),
        "payback": payback(paid, cash, Decimal(0)),
        "discountedPayback": payback(paid, cash, rate),
        "realDiscountRate": float((1 + rate) / (1 + dec(f["ipca"])) - 1),
        "maxViableCapex": number(
            bisect(
                lambda k: net_present(rate, paid_capex(case, k), flows(case, k)["cash"]),
                max(capex, Decimal(10**6)),
            )
        ),
    }
    if case["case"] == "contracted":
        rising = lambda bid: net_present(rate, paid, flows(case, capex, bid)["cash"])  # noqa: E731
        result["minViableBid"] = (
            0.0
            if rising(Decimal(0)) >= 0
            else number(bisect(lambda bid: -rising(bid), Decimal(10**5)))
        )
    return result


BASE: dict[str, Any] = {
    "fixedRevenue": 1_580_000,
    "ipca": 0.045,
    "discountRate": 0.12,
    "realPldGrowth": 0.0,
    "captureFactor": 0.98,
    "capex": 180_000_000,
    "capexIndexYears": 1.75,
    "opex": 3_600_000,
    "revenueTax": 0.0925,
    "incomeTax": 0.34,
    "depreciationYears": 10,
    "calendarFade": 0.01,
    "replacementShare": 0.5,
    "penaltyAllowance": 0,
    "merchantReplacementYears": [],
}
#: E delivers 4.8 h when new, so the contract's 4 h hold for some years.
ROOMY = {
    "powerMw": 30,
    "volumeMwh": 156.2,
    "dischargeEfficiency": 0.9219544457292888,
    "degradationPerCycle": 0.00001,
    "cyclesPerYear": 250,
}
EXACT = {**ROOMY, "volumeMwh": 4 * 30 / 0.9219544457292888}


def vectors() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = [
        {
            "name": "contracted, base inputs",
            "case": "contracted",
            "inputs": BASE,
            "physical": ROOMY,
            "reimbursement": 12_000.0,
        },
        {
            "name": "contracted, IPCA 8%",
            "case": "contracted",
            "inputs": {**BASE, "ipca": 0.08},
            "physical": ROOMY,
            "reimbursement": 12_000.0,
        },
        {
            "name": "contracted, discount rate 18%",
            "case": "contracted",
            "inputs": {**BASE, "discountRate": 0.18},
            "physical": ROOMY,
            "reimbursement": 12_000.0,
        },
        {
            "name": "contracted, real PLD growth moves only the reimbursement",
            "case": "contracted",
            "inputs": {**BASE, "realPldGrowth": 0.03},
            "physical": ROOMY,
            "reimbursement": 200_000.0,
        },
        {
            "name": "contracted, no margin over 4 h adds modules every year",
            "case": "contracted",
            "inputs": BASE,
            "physical": EXACT,
            "reimbursement": 0.0,
        },
        {
            "name": "contracted, margin runs out mid-term at IPCA 8%",
            "case": "contracted",
            "inputs": {**BASE, "ipca": 0.08},
            "physical": {**ROOMY, "volumeMwh": 4.2 * 30 / 0.9219544457292888},
            "reimbursement": 12_000.0,
        },
        {
            "name": "contracted, product A price and penalties",
            "case": "contracted",
            "inputs": {**BASE, "fixedRevenue": 1_760_000, "penaltyAllowance": 500_000},
            "physical": ROOMY,
            "reimbursement": 12_000.0,
        },
        {
            "name": "merchant, base inputs",
            "case": "merchant",
            "inputs": BASE,
            "physical": ROOMY,
            "revenue": 7_000_000.0,
        },
        {
            "name": "merchant, real PLD growth 2%",
            "case": "merchant",
            "inputs": {**BASE, "realPldGrowth": 0.02},
            "physical": ROOMY,
            "revenue": 7_000_000.0,
        },
        {
            "name": "merchant, real PLD decline 2%",
            "case": "merchant",
            "inputs": {**BASE, "realPldGrowth": -0.02},
            "physical": ROOMY,
            "revenue": 7_000_000.0,
        },
        {
            "name": "merchant, IPCA 3% and rate 9%",
            "case": "merchant",
            "inputs": {**BASE, "ipca": 0.03, "discountRate": 0.09},
            "physical": ROOMY,
            "revenue": 40_000_000.0,
        },
        {
            "name": "merchant, replacement in year 8",
            "case": "merchant",
            "inputs": {**BASE, "merchantReplacementYears": [8]},
            "physical": ROOMY,
            "revenue": 40_000_000.0,
        },
        {
            "name": "merchant, losses carried forward",
            "case": "merchant",
            "inputs": {**BASE, "capex": 60_000_000},
            "physical": ROOMY,
            "revenue": 9_000_000.0,
        },
        {
            "name": "merchant, late replacement changes the sign twice",
            "case": "merchant",
            "inputs": {
                **BASE,
                "capex": 20_000_000,
                "replacementShare": 30.0,
                "merchantReplacementYears": [15],
            },
            "physical": ROOMY,
            "revenue": 30_000_000.0,
        },
    ]
    return [{**case, "expected": expected(case)} for case in cases]


def monthly_vectors() -> list[dict[str, Any]]:
    out = []
    for inflation in (0.0, 0.045, 0.09):
        for wanted in ("merchant", "contracted"):
            case = next(
                c for c in EXAMPLE["cases"] if c["submarket"] == "SE" and c["case"] == wanted
            )
            block = case["monthly"]
            pi = dec(inflation)
            out.append(
                {
                    "name": f"SE {wanted}, IPCA {inflation:.3f}",
                    "ipca": inflation,
                    "monthly": block,
                    "baseRevenue": float(base_revenue(block, pi)),
                    "baseReimbursement": float(base_reimbursement(block, pi)),
                }
            )
    # A partial, repeated calendar: the months past the published index extrapolate.
    partial = {
        "month": [f"2025-{m:02d}" for m in range(1, 13)] + ["2026-01", "2026-11", "2026-12"],
        "days": [12, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31, 31, 20, 5],
        "value_brl": [100.0 + 7 * i for i in range(15)],
        "charge_mwh": [50.0 + i for i in range(15)],
        "injected_mwh": [40.0 + i for i in range(15)],
        "charge_cost_brl": [900.0 + 11 * i for i in range(15)],
        "storage_end_mwh": [3.0 + (i % 4) for i in range(15)],
        "injections": [3 if i == 2 else 10 for i in range(15)],
    }
    out.append(
        {
            "name": "partial months and an extrapolated index",
            "ipca": 0.06,
            "monthly": partial,
            "baseRevenue": float(base_revenue(partial, Decimal("0.06"))),
            "baseReimbursement": float(base_reimbursement(partial, Decimal("0.06"))),
        }
    )
    return out


def main() -> None:
    payload = {
        "generated_by": "scripts/finance_golden_vectors.py",
        "cases": vectors(),
        "monthly": monthly_vectors(),
    }
    OUTPUT.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(f"{len(payload['cases'])} cases, {len(payload['monthly'])} monthly vectors -> {OUTPUT}")


if __name__ == "__main__":
    main()
