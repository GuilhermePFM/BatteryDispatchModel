"""The contracts in ``contracts/v2``: examples, a built result, and the params hash.

The schemas are the source of truth the Go API codes against, so the checks here
run the other way round from the rest of the suite: the code is held to the
schema, not the schema to the code. The Go side checks the same vectors in
``services/api/internal/contracts``.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest
from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource

from battery_plan.contracts import (
    BUNDLED_PLD_END,
    BUNDLED_PLD_SHA256,
    BUNDLED_PLD_START,
    CONTRACT_VERSION,
    MAX_SPAN_DAYS,
    MIN_SPAN_DAYS,
    MODEL_VERSION,
    canonical_json,
    check_span,
    hourly_battery_from_request,
    params_hash,
    prices_sha256,
)
from battery_plan.data_io import SUBMARKETS, load_pld
from battery_plan.data_io.paths import PLD_HOURLY_CSV, PROJECT_ROOT
from battery_plan.modelling.hourly import HourlyBattery, solve_hourly
from battery_plan.modelling.portfolio import (
    BusinessCase,
    CaseResult,
    Portfolio,
    balanced_year,
    last_twelve_months,
    solve_portfolio,
)
from battery_plan.result_v2 import (
    MAX_RESULT_BYTES,
    PLAN_COLUMNS,
    _monthly,
    build_result,
    plan_csv,
)

CONTRACTS = PROJECT_ROOT / "contracts" / "v2"
EXAMPLES = PROJECT_ROOT / "contracts" / "examples" / "v2"
SCHEMAS = ("run-request", "job-message", "run-record", "result")


def _load(path: Path) -> Any:
    return json.loads(path.read_text())


def _validator(name: str) -> Draft202012Validator:
    schemas = {schema: _load(CONTRACTS / f"{schema}.schema.json") for schema in SCHEMAS}
    registry: Registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas.values()
    )
    return Draft202012Validator(schemas[name], registry=registry, format_checker=FormatChecker())


def _request(**changes: Any) -> dict[str, Any]:
    request: dict[str, Any] = _load(EXAMPLES / "run-request.example.json")
    request.update(changes)
    return request


def _year_of_prices(days: int = 365) -> pd.DataFrame:
    rng = np.random.default_rng(5)
    index = pd.date_range("2025-01-01", periods=days * 24, freq="h")
    shape = 150 + 100 * np.sin((index.hour.to_numpy() - 13) / 24 * 2 * np.pi)
    return pd.DataFrame(
        {name: shape * rng.uniform(0.7, 1.3, len(index)) + 60 for name in SUBMARKETS},
        index=index,
    )


@pytest.mark.parametrize("name", SCHEMAS)
def test_every_schema_is_valid_and_its_example_passes(name: str) -> None:
    Draft202012Validator.check_schema(_load(CONTRACTS / f"{name}.schema.json"))
    _validator(name).validate(_load(EXAMPLES / f"{name}.example.json"))


def test_a_succeeded_record_is_the_running_example_plus_the_result() -> None:
    record = _load(EXAMPLES / "run-record.example.json")
    record.update(
        status="succeeded",
        finished_at="2026-11-22T09:31:12Z",
        result=_load(EXAMPLES / "result.example.json"),
        plan_csv_key=f"plans/{record['run_id']}.csv",
    )
    _validator("run-record").validate(record)
    del record["result"]
    with pytest.raises(ValidationError):
        _validator("run-record").validate(record)


@pytest.mark.parametrize(
    "request_body",
    [
        _request(capex_brl=1000),
        _request(discount_rate=0.12),
        _request(commit_days=1),
        _request(prices_key=None),
        _request(prices_key="somewhere/else.csv"),
        _request(start="1 Jan 2025"),
        _request(battery={**_request()["battery"], "charge_efficiency": 0.4}),
        _request(battery={**_request()["battery"], "capex_brl": 1}),
        {key: value for key, value in _request().items() if key != "end"},
    ],
    ids=[
        "capex",
        "discount-rate",
        "window",
        "null-key",
        "foreign-key",
        "date",
        "efficiency",
        "battery-capex",
        "missing-end",
    ],
)
def test_the_request_is_physical_and_strict(request_body: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        _validator("run-request").validate(request_body)


def test_the_limits_allow_a_large_project() -> None:
    battery = {
        "power_mw": 2000,
        "volume_mwh": 60000,
        "max_charge_mw": 20000,
        "max_discharge_mw": 20000,
        "charge_efficiency": 1,
        "discharge_efficiency": 1,
        "degradation_pct_per_cycle": 0,
    }
    _validator("run-request").validate(_request(battery=battery))
    with pytest.raises(ValidationError):
        _validator("run-request").validate(_request(battery={**battery, "power_mw": 2001}))


def test_the_constants_are_the_ones_the_schemas_pin() -> None:
    job = _load(CONTRACTS / "job-message.schema.json")["properties"]
    assert job["version"]["const"] == CONTRACT_VERSION
    assert job["model_version"]["const"] == MODEL_VERSION
    assert _load(CONTRACTS / "result.schema.json")["properties"]["model_version"]["const"] == (
        MODEL_VERSION
    )


def test_the_bundled_constants_describe_the_bundled_file() -> None:
    assert prices_sha256(PLD_HOURLY_CSV.read_bytes()) == BUNDLED_PLD_SHA256
    prices = load_pld()
    assert f"{prices.index[0]:%Y-%m-%d}" == BUNDLED_PLD_START
    assert f"{prices.index[-1]:%Y-%m-%d}" == BUNDLED_PLD_END


def test_the_hash_vectors_reproduce() -> None:
    file = _load(EXAMPLES / "params-hash.json")
    assert file["model_version"] == MODEL_VERSION
    assert len(file["vectors"]) == 2
    for vector in file["vectors"]:
        body = {key: value for key, value in vector["request"].items() if key != "prices_key"}
        canonical = canonical_json(
            {
                "model_version": MODEL_VERSION,
                "prices_sha256": vector["prices_sha256"],
                "request": body,
            }
        )
        assert canonical == vector["canonical"]
        assert params_hash(vector["request"], vector["prices_sha256"]) == vector["params_hash"]


def test_the_hash_carries_the_model_and_ignores_where_prices_are() -> None:
    request = _request()
    digest = params_hash(request, "ab" * 32)
    without_model = canonical_json({"prices_sha256": "ab" * 32, "request": request})
    assert digest != hashlib.sha256(without_model.encode()).hexdigest()
    assert digest == params_hash({**request, "prices_key": "uploads/x.csv"}, "ab" * 32)
    assert digest != params_hash(request, "cd" * 32)
    assert digest != params_hash(_request(cycle_budget=100), "ab" * 32)


def test_the_hash_reads_number_spelling_as_the_same_request() -> None:
    request = _request()
    floats = {**request, "battery": {key: float(v) for key, v in request["battery"].items()}}
    assert params_hash(floats, BUNDLED_PLD_SHA256) == params_hash(request, BUNDLED_PLD_SHA256)


def test_the_hash_reads_key_order_as_the_same_request() -> None:
    request = _request()
    reordered = dict(reversed(list(request.items())))
    assert params_hash(reordered, BUNDLED_PLD_SHA256) == params_hash(request, BUNDLED_PLD_SHA256)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (5000.0, "5000"),
        (0.05, "0.05"),
        (1e-05, "0.00001"),
        (1.5e-07, "1.5e-7"),
        (1e21, "1e+21"),
        (-0.0, "0"),
        (0.1 + 0.2, "0.30000000000000004"),
        ({"b": [True, None], "a": "é"}, '{"a":"é","b":[true,null]}'),
    ],
)
def test_canonical_json_prints_as_ecmascript_does(value: object, expected: str) -> None:
    assert canonical_json(value) == expected


def test_a_request_maps_onto_the_battery() -> None:
    request = _request(cycle_budget=4.5)
    battery = hourly_battery_from_request(request)
    assert battery.power_mw == 30
    assert battery.degradation_per_cycle == pytest.approx(1e-5)
    assert battery.cycle_budget == 4.5
    assert hourly_battery_from_request(_request()).cycle_budget is None


@pytest.mark.parametrize(
    ("start", "end", "message"),
    [
        ("2025-01-01", "2025-12-30", "at least 365"),
        ("2025-01-01", "2027-01-03", "at most 730"),
    ],
)
def test_the_span_rule_refuses_what_a_balanced_year_or_a_lambda_cannot_hold(
    start: str, end: str, message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        check_span({"start": start, "end": end})


def test_the_span_bounds_are_inclusive() -> None:
    start = pd.Timestamp("2025-01-01")
    for days in (MIN_SPAN_DAYS, MAX_SPAN_DAYS):
        end = start + pd.Timedelta(days=days)
        check_span({"start": f"{start:%Y-%m-%d}", "end": f"{end:%Y-%m-%d}"})


def test_a_built_result_validates_and_its_months_add_up() -> None:
    prices = _year_of_prices()
    battery = HourlyBattery.sized(30.0)
    portfolio = solve_portfolio(prices, battery)
    request = _request(start="2025-01-01", end="2025-12-31")
    result = build_result(portfolio, battery, request, 1.0)

    _validator("result").validate(result)
    json.dumps(result, allow_nan=False)
    assert len(result["cases"]) == 8
    assert [row["rank"] for row in result["ranking"]] == [1, 2, 3, 4]
    assert result["ranking"][0]["regret_brl_per_year"] == 0
    assert result["detail"]["submarket"] == result["ranking"][0]["submarket"]
    assert result["detail"]["case"] == "merchant"

    for case in result["cases"]:
        monthly = case["monthly"]
        assert sum(monthly["days"]) == 365
        assert sum(monthly["value_brl"]) == pytest.approx(case["value_brl"], abs=0.01)
        assert case["balanced_year_brl"] == pytest.approx(case["value_brl"])
        solved = portfolio.results[(case["submarket"], BusinessCase(case["case"]))].solution
        assert sum(monthly["injected_mwh"]) == pytest.approx(
            float((solved.discharge_efficiency * solved.discharge_mw).sum()), abs=1e-3
        )
        assert monthly["storage_end_mwh"][-1] == pytest.approx(solved.storage_mwh[-1], abs=1e-5)


def test_an_injection_is_a_run_of_hours_counted_in_the_month_it_starts() -> None:
    index = pd.date_range("2025-01-31", periods=48, freq="h")
    prices = pd.Series(100.0, index=index, name="SE")
    discharge = np.zeros(48)
    discharge[[2, 3, 10, 23, 24, 30]] = 1.0  # the run at 23-24 crosses into February
    solution = solve_hourly(prices, HourlyBattery.sized(1.0))
    shaped = replace(solution, discharge_mw=discharge, charge_mw=np.zeros(48))
    monthly = _monthly(shaped, HourlyBattery.sized(1.0))
    assert monthly["month"] == ["2025-01", "2025-02"]
    assert monthly["injections"] == [3, 1]
    assert monthly["days"] == [1, 1]


def test_a_battery_that_misses_the_contract_gets_the_merchant_cases_only() -> None:
    prices = _year_of_prices()
    battery = HourlyBattery.sized(30.0, hours=2.0)
    request = _request(start="2025-01-01", end="2025-12-31")
    result = build_result(solve_portfolio(prices, battery), battery, request, 1.0)

    _validator("result").validate(result)
    assert {case["case"] for case in result["cases"]} == {"merchant"}
    assert result["eligibility"]["contract_eligible"] is False
    assert result["eligibility"]["contract_shortfalls"]


def test_the_largest_result_fits_the_ceiling() -> None:
    """Two full years, the largest project, a plan that moves every hour, and 8 cases."""
    prices = _year_of_prices(days=MAX_SPAN_DAYS + 1)
    battery = HourlyBattery.sized(2000.0, hours=24.0, recharge_hours=1.0)
    solution = solve_hourly(prices["SE"], battery)
    rng = np.random.default_rng(1)
    noisy = type(solution)(
        index=solution.index,
        prices=solution.prices,
        charge_mw=rng.uniform(1000.123, 1999.987, len(solution)),
        discharge_mw=rng.uniform(1000.123, 1999.987, len(solution)),
        storage_mwh=rng.uniform(10000.123, 49999.987, len(solution)),
        cycles=np.cumsum(rng.uniform(0.01, 0.05, len(solution))),
        discharge_efficiency=solution.discharge_efficiency,
        method="lp",
        solve_seconds=1.234567,
    )
    daily = noisy.daily_value
    results = {
        (submarket, case): CaseResult(
            submarket, case, noisy, balanced_year(daily), last_twelve_months(daily)
        )
        for submarket in SUBMARKETS
        for case in BusinessCase
    }
    portfolio = Portfolio(results=results, contract_shortfalls=(), below_minimum_power=False)
    request = _request(start="2025-01-01", end="2027-01-01")

    payload = build_result(portfolio, battery, request, 123.456)

    _validator("result").validate(payload)
    size = len(json.dumps(payload, separators=(",", ":")).encode())
    assert size <= MAX_RESULT_BYTES


def test_the_plan_csv_has_a_row_per_hour_submarket_and_case() -> None:
    prices = _year_of_prices()
    portfolio = solve_portfolio(prices, HourlyBattery.sized(1.0))
    lines = plan_csv(portfolio).decode().splitlines()
    assert lines[0] == ",".join(PLAN_COLUMNS)
    assert len(lines) == 1 + 8 * len(prices)
    assert lines[1].startswith("2025-01-01T00:00,SE,merchant,")
