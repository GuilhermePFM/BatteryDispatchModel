"""The contracts in ``contracts/``: the examples, a real payload, and the params hash.

The schemas are the source of truth the Go API codes against, so the checks
here run the other way round from the rest of the suite: the code is held to
the schema, not the schema to the code.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource

from battery_plan.analysis import build_result_payload
from battery_plan.contracts import (
    BUNDLED_PRICES_SHA256,
    canonical_json,
    config_from_request,
    params_hash,
    prices_sha256,
    spec_from_request,
)
from battery_plan.data_io import load_market_prices
from battery_plan.data_io.paths import MARKET_PRICES_XLSX, PROJECT_ROOT
from battery_plan.dispatch import DispatchConfig, run_dispatch
from battery_plan.modelling import ModelParameters, RollingPolicy
from battery_plan.modelling.cycle_value import CuttingPlaneSearch, CycleOracle
from tests.helpers import SPEC, make_periods

CONTRACTS = PROJECT_ROOT / "contracts"
EXAMPLES = CONTRACTS / "examples"
SCHEMAS = ("run-request", "job-message", "run-record", "result")


def _load(path: Path) -> Any:
    return json.loads(path.read_text())


def _validator(name: str) -> Draft202012Validator:
    """A validator for one schema, with the other three registered for its ``$ref`` s."""
    schemas = {schema: _load(CONTRACTS / f"{schema}.schema.json") for schema in SCHEMAS}
    registry: Registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas.values()
    )
    return Draft202012Validator(schemas[name], registry=registry, format_checker=FormatChecker())


@pytest.mark.parametrize("name", SCHEMAS)
def test_every_schema_is_itself_valid_draft_2020_12(name: str) -> None:
    Draft202012Validator.check_schema(_load(CONTRACTS / f"{name}.schema.json"))


@pytest.mark.parametrize("name", SCHEMAS)
def test_every_example_validates_against_its_schema(name: str) -> None:
    _validator(name).validate(_load(EXAMPLES / f"{name}.example.json"))


def _request(**changes: Any) -> dict[str, Any]:
    request: dict[str, Any] = _load(EXAMPLES / "run-request.example.json")
    request.update(changes)
    return request


@pytest.mark.parametrize(
    "request_body",
    [
        _request(lookahead_days=1),
        _request(commit_days=1),
        _request(search="bisection"),
        _request(prices_key=None),
        _request(start="1 Jan 2018"),
        _request(battery={**_request()["battery"], "charging_loss_fraction": 0.9}),
        {key: value for key, value in _request().items() if key != "end"},
    ],
    ids=[
        "lookahead",
        "commit",
        "search",
        "null-key",
        "date",
        "efficiency",
        "missing-end",
    ],
)
def test_the_request_schema_rejects_what_the_api_must_not_queue(
    request_body: dict[str, Any],
) -> None:
    with pytest.raises(ValidationError):
        _validator("run-request").validate(request_body)


def test_a_record_cannot_succeed_without_its_result() -> None:
    record = _load(EXAMPLES / "run-record.example.json")
    del record["result"]
    with pytest.raises(ValidationError):
        _validator("run-record").validate(record)


def test_a_payload_built_from_a_synthetic_plan_validates() -> None:
    """No spreadsheet needed: the schema has to hold for any plan, not just the bundled data."""
    cheap, dear = [20.0] * 24, [100.0] * 24
    settlement = make_periods((cheap + dear) * 3)
    params = ModelParameters.from_spec(SPEC)
    plan = RollingPolicy().dispatch(settlement, params)

    payload = build_result_payload(plan, SPEC, params)
    _validator("result").validate(payload)
    json.dumps(payload, allow_nan=False)


def test_a_payload_from_a_search_stopped_early_validates_and_says_so() -> None:
    """A deadline already passed: one relaxed pass, then the recovery, and a
    certificate that admits it and still quantifies the plan against its bound."""
    cheap, dear = [20.0] * 24, [100.0] * 24
    settlement = make_periods((cheap + dear) * 3)
    params = ModelParameters.from_spec(SPEC, cycle_budget=1.0)
    oracle = CycleOracle(settlement=settlement, params=params, deadline=float("-inf"))
    search = CuttingPlaneSearch().search(oracle)

    payload = build_result_payload(search.plan, SPEC, params, search)

    _validator("result").validate(payload)
    certificate = payload["certificate"]
    assert certificate["stopped_early"] is True
    assert certificate["stop_reason"] == "time_limit"
    assert certificate["passes"] == 2
    assert certificate["plan_gap"] >= 0


requires_prices = pytest.mark.skipif(
    not MARKET_PRICES_XLSX.exists(), reason="raw spreadsheets are not present"
)


@requires_prices
def test_a_payload_from_a_real_run_validates_against_the_result_schema() -> None:
    run = run_dispatch(
        SPEC, load_market_prices(), DispatchConfig(start="2018-03-01", end="2018-03-04")
    )
    payload = build_result_payload(run.plan, SPEC, run.params, run.search)

    _validator("result").validate(payload)
    assert payload["certificate"]["passes"] == run.search.passes
    assert payload["horizon"]["days"] == 4


def test_the_hash_vectors_reproduce() -> None:
    for vector in _load(EXAMPLES / "params-hash.json")["vectors"]:
        body = {key: value for key, value in vector["request"].items() if key != "prices_key"}
        assert (
            canonical_json({"prices_sha256": vector["prices_sha256"], "request": body})
            == vector["canonical"]
        )
        assert params_hash(vector["request"], vector["prices_sha256"]) == vector["params_hash"]


def test_the_hash_ignores_where_prices_are_stored_but_not_what_they_are() -> None:
    request = _request()
    stored = params_hash({**request, "prices_key": "uploads/a.csv"}, "ab" * 32)
    assert stored == params_hash({**request, "prices_key": "uploads/b.csv"}, "ab" * 32)
    assert stored != params_hash(request, "cd" * 32)
    assert params_hash(request, BUNDLED_PRICES_SHA256) != params_hash(
        _request(cycle_budget=100), BUNDLED_PRICES_SHA256
    )


def test_the_hash_reads_key_order_and_number_spelling_as_the_same_request() -> None:
    """``5000`` and ``5000.0`` are one request; Go and Python print them differently."""
    request = _request()
    reordered = dict(reversed(list(request.items())))
    floats = {**request, "battery": {key: float(v) for key, v in request["battery"].items()}}
    digest = params_hash(request, BUNDLED_PRICES_SHA256)
    assert params_hash(reordered, BUNDLED_PRICES_SHA256) == digest
    assert params_hash(floats, BUNDLED_PRICES_SHA256) == digest


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


@requires_prices
def test_the_bundled_prices_hash_is_the_spreadsheet_it_names() -> None:
    assert prices_sha256(MARKET_PRICES_XLSX.read_bytes()) == BUNDLED_PRICES_SHA256


def test_a_request_maps_onto_the_spec_and_the_config() -> None:
    request = _request(cycle_budget=4.5)
    assert spec_from_request(request) == SPEC
    config = config_from_request(request)
    assert config == DispatchConfig(
        start="2018-01-01",
        end="2018-01-03",
        commit_days=1,
        lookahead_days=1,
        search="cutting-plane",
        cycle_budget=4.5,
    )
    assert config_from_request(_request()).cycle_budget is None
