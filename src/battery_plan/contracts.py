"""The Python side of ``contracts/``: what a run request means, and its hash.

The JSON Schemas in ``contracts/`` are the source of truth, shared with the Go
API; this module holds the two things a schema cannot say. One is the mapping
from a validated run request onto :class:`BatterySpec` and
:class:`~battery_plan.dispatch.DispatchConfig` — kept trivial by naming the
request's battery fields after the spec's own. The other is the params hash,
which both sides must compute identically, so its rule is written out in
``contracts/README.md`` and pinned by the test vector in
``contracts/examples/params-hash.json``.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from battery_plan.data_models import BatterySpec
from battery_plan.dispatch import DispatchConfig
from battery_plan.modelling.cycle_value.searches import DEFAULT_SEARCH

#: sha256 of ``data/raw/attachment_2_market_prices.xlsx``, the bundled
#: 2018-2020 prices. A run on them hashes this in place of an upload's bytes.
BUNDLED_PRICES_SHA256 = "f26dc09b7eb4bcb3755b615c0595132937dee3dbb4b82e915648be7e53a95ce9"

#: The search every web run uses; the request has no field for it.
WEB_SEARCH = DEFAULT_SEARCH


def spec_from_request(request: Mapping[str, Any]) -> BatterySpec:
    """The battery of a validated run request, field for field."""
    return BatterySpec(**{key: float(value) for key, value in request["battery"].items()})


def config_from_request(request: Mapping[str, Any]) -> DispatchConfig:
    """The horizon and window scheme of a validated run request.

    ``end`` is a date, so it includes the whole of that day.
    """
    budget = request.get("cycle_budget")
    return DispatchConfig(
        start=request["start"],
        end=request["end"],
        commit_days=int(request["commit_days"]),
        lookahead_days=int(request["lookahead_days"]),
        search=WEB_SEARCH,
        cycle_budget=None if budget is None else float(budget),
    )


def prices_sha256(content: bytes) -> str:
    """The content hash of a price file: sha256 of its bytes, as stored, in lowercase hex."""
    return hashlib.sha256(content).hexdigest()


def params_hash(request: Mapping[str, Any], prices_digest: str) -> str:
    """The hash that identifies a run by what it computes, not by who asked or when.

    sha256 of the canonical JSON of ``{"prices_sha256": ..., "request": ...}``,
    with ``prices_key`` left out of the request: where an upload is stored says
    nothing about what it contains, and its content hash already does.
    """
    body = {key: value for key, value in request.items() if key != "prices_key"}
    canonical = canonical_json({"prices_sha256": prices_digest, "request": body})
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
