"""The Python side of ``contracts/v2``: what a run request means, and its hash.

The JSON Schemas in ``contracts/v2`` are the source of truth, shared with the Go
API; this module holds what a schema cannot say. One is the mapping from a
validated run request onto :class:`HourlyBattery`, and the rule on its dates.
The other is the params hash, which both sides must compute identically, so its
rule is written out in ``contracts/README.md`` and pinned by the test vectors in
``contracts/examples/v2/params-hash.json``.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping
from datetime import date
from decimal import Decimal
from typing import Any

from battery_plan.data_io.pld import PLD_HOURLY_SHA256
from battery_plan.modelling.hourly import HourlyBattery

#: The version of ``contracts/v2``, on every message, record and result.
CONTRACT_VERSION = 2

#: What the solver computes. Bump it when a change moves results: it is hashed,
#: so earlier runs stop answering from the cache, and pinned by the schemas.
MODEL_VERSION = "pld-hourly-1"

#: Hash of the bundled hourly PLD, which a run hashes in place of an upload's bytes.
BUNDLED_PLD_SHA256 = PLD_HOURLY_SHA256

#: The first and last day of the bundled PLD.
BUNDLED_PLD_START = "2025-01-20"
BUNDLED_PLD_END = "2026-11-20"

#: Bounds on ``end - start``, in days (:func:`check_span`).
MIN_SPAN_DAYS = 364
MAX_SPAN_DAYS = 730


def hourly_battery_from_request(request: Mapping[str, Any]) -> HourlyBattery:
    """The battery of a validated request; only the degradation changes unit."""
    battery = request["battery"]
    budget = request.get("cycle_budget")
    return HourlyBattery(
        power_mw=float(battery["power_mw"]),
        volume_mwh=float(battery["volume_mwh"]),
        max_charge_mw=float(battery["max_charge_mw"]),
        max_discharge_mw=float(battery["max_discharge_mw"]),
        charge_efficiency=float(battery["charge_efficiency"]),
        discharge_efficiency=float(battery["discharge_efficiency"]),
        degradation_per_cycle=float(battery["degradation_pct_per_cycle"]) / 100.0,
        cycle_budget=None if budget is None else float(budget),
    )


def check_span(request: Mapping[str, Any]) -> None:
    """The horizon rule, also held by the API: at least a year, at most two.

    Any 365 consecutive days hold all twelve calendar months, which the balanced
    year of §8.3 needs. The ceiling keeps the worst case inside a Lambda's 600 s.
    """
    span = (date.fromisoformat(request["end"]) - date.fromisoformat(request["start"])).days
    if span < MIN_SPAN_DAYS:
        raise ValueError(
            f"A run covers at least {MIN_SPAN_DAYS + 1} days, so that every calendar month "
            "is in it; extend the dates."
        )
    if span > MAX_SPAN_DAYS:
        raise ValueError(
            f"A run covers at most {MAX_SPAN_DAYS} days after its start; shorten the dates."
        )


def prices_sha256(content: bytes) -> str:
    """The content hash of a price file: sha256 of its bytes, as stored, in lowercase hex."""
    return hashlib.sha256(content).hexdigest()


def params_hash(request: Mapping[str, Any], prices_digest: str) -> str:
    """The hash that identifies a run by what it computes, not by who asked or when.

    sha256 of the canonical JSON of ``{"model_version": ..., "prices_sha256": ...,
    "request": ...}``, with ``prices_key`` left out of the request: where an upload
    is stored says nothing about what it contains, and its content hash already
    does. A change to the model therefore misses the cache of every earlier run.
    """
    body = {key: value for key, value in request.items() if key != "prices_key"}
    canonical = canonical_json(
        {"model_version": MODEL_VERSION, "prices_sha256": prices_digest, "request": body}
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def canonical_json(value: Any) -> str:
    """JSON in the canonical form of RFC 8785 (JCS), for the values a request holds.

    Keys sorted, no whitespace, strings as :func:`json.dumps` writes them
    without ASCII escaping, and numbers as ECMAScript prints them — which is
    the part Python and Go disagree on by default: ``5000.0`` must be ``5000``
    and ``1e-05`` must be ``0.00001``.
    """
    if isinstance(value, Mapping):
        items = sorted(value.items(), key=lambda item: _utf16(str(item[0])))
        return "{" + ",".join(f"{_string(str(k))}:{canonical_json(v)}" for k, v in items) + "}"
    if isinstance(value, list | tuple):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, str):
        return _string(value)
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return _number(float(value))
    raise TypeError(f"cannot canonicalise {type(value).__name__}")


def _string(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


def _utf16(text: str) -> bytes:
    """JCS orders keys by their UTF-16 code units, not by code point."""
    return text.encode("utf-16-be")


def _number(number: float) -> str:
    """A number as ECMAScript's ``Number.prototype.toString`` writes it."""
    if not math.isfinite(number):
        raise ValueError("JSON has no NaN or infinity")
    if number == 0.0:
        return "0"
    if number.is_integer() and abs(number) < 1e21:
        return str(int(number))
    shortest = repr(number)  # the shortest string that reads back as the same float
    if 1e-6 <= abs(number) < 1e21:
        return format(Decimal(shortest), "f")
    mantissa, exponent = shortest.split("e")
    return f"{mantissa}e{'+' if int(exponent) > 0 else '-'}{abs(int(exponent))}"
