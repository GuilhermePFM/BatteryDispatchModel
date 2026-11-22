# ---
# jupyter:
#   jupytext:
#     formats: py:percent
#     text_representation:
#       extension: .py
#       format_name: percent
#   kernelspec:
#     display_name: battery-plan
#     language: python
#     name: python3
# ---

# %% [markdown]
# # Results analysis
#
# What the dispatch of 2018–2020 actually did, read off the plan the model
# wrote: `data/results/dispatch_plan.csv`, plus the committed measurement CSVs
# under `docs/model/`.
#
# Every reading is a function in `battery_plan.analysis`, the module the solver
# job builds a run's results page from, so this notebook and the site compute
# each figure by one code path; what stays here is the plotting and the
# comparison against the documents.
#
# Two things happen here. §1 re-derives every figure
# [`docs/model/results.md`](../docs/model/results.md) quotes and diffs it
# against the documented value, so the document and the plan cannot drift apart
# unnoticed. §2 onwards goes past the document, into the dispatch behaviour the
# plan records but the prose only asserts.
#
# Nothing in this notebook solves anything — every number is an arithmetic
# reading of a committed artefact, so a full run is seconds. If the plan is
# missing, solve one first:
#
# ```
# uv run battery-plan dispatch
# ```
#
# Percent-format script: each `# %%` starts a cell. In Zed, put the cursor in a
# cell and press `ctrl-shift-enter` to run it in the REPL.

# %%
import hashlib
from datetime import UTC, datetime

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
from IPython import get_ipython
from matplotlib.ticker import FuncFormatter

from battery_plan import load_battery_spec
from battery_plan.analysis import (
    breakeven_markup,
    constraint_checks,
    daily_summary,
    days_worth_trading,
    fit,
    half_hour_profile,
    headline_figures,
    lifetime_cost,
    market_pair,
    monthly_prices,
    monthly_profit,
    net_power_grid,
    profit_split,
    prorated_crossing,
    quarterly_level_and_spread,
    spread_explanation,
    spread_histogram,
    spread_readings,
    trading_periods,
    wear_cost,
    with_derived_columns,
    yardstick_summary,
    yearly_summary,
)
from battery_plan.data_io.paths import RESULTS_DIR
from battery_plan.modelling.parameters import ModelParameters

# Reload the package on edit, when running under an IPython kernel. Spelled out
# rather than as %load_ext so this file stays importable, lintable Python.
_ipython = get_ipython()
if _ipython is not None:
    _ipython.run_line_magic("load_ext", "autoreload")
    _ipython.run_line_magic("autoreload", "2")

# The palette fixed in scripts/plot_cutting_plane.py, so the figures here and
# the figures in the documents are one set. CHARGE and DISCHARGE keep one
# colour each throughout the notebook; identity is never left to colour alone.
CHARGE = "#2a78d6"
DISCHARGE = "#eb6834"
INK = "#0b0b0b"
MUTED = "#52514e"
SURFACE = "#fcfcfb"

sns.set_theme(style="ticks", context="notebook")
plt.rcParams.update(
    {
        "figure.facecolor": SURFACE,
        "axes.facecolor": SURFACE,
        "figure.dpi": 110,
        "axes.labelcolor": INK,
        "text.color": INK,
    }
)

GBP = FuncFormatter(lambda v, _: f"£{v:,.0f}")

# %% [markdown]
# ## §0 Provenance
#
# Which plan is being read, and whether it is the shape the rest of the
# notebook assumes. A stale or partial plan should be visible here rather than
# halfway down a figure.

# %%
PLAN_PATH = RESULTS_DIR / "dispatch_plan.csv"

if not PLAN_PATH.exists():
    raise SystemExit(f"no plan at {PLAN_PATH}\nsolve one first:  uv run battery-plan dispatch")

spec = load_battery_spec()
params = ModelParameters.from_spec(spec)
plan = pd.read_csv(PLAN_PATH, index_col=0, parse_dates=True)

digest = hashlib.sha256(PLAN_PATH.read_bytes()).hexdigest()
written = datetime.fromtimestamp(PLAN_PATH.stat().st_mtime, tz=UTC)

print(f"plan     {PLAN_PATH}")
print(f"written  {written:%Y-%m-%d %H:%M} UTC")
print(f"sha256   {digest[:16]}…")
print(f"horizon  {plan.index[0]:%Y-%m-%d %H:%M} to {plan.index[-1]:%Y-%m-%d %H:%M}")
print(f"periods  {len(plan):,}")
print(f"round trip  {params.round_trip_efficiency:.2%}   cycle budget  {params.cycle_budget:,.0f}")

# %%
# The assumptions every cell below rests on, checked once.
gaps = plan.index.to_series().diff().dropna().unique()

assert len(plan) == 52_608, f"expected the full three years, got {len(plan):,} periods"
assert list(gaps) == [pd.Timedelta("30min")], f"not a regular half-hourly index: {gaps}"
assert not plan.index.has_duplicates, "duplicate timestamps"
assert not plan.isna().to_numpy().any(), "missing values in the plan"
assert plan["storage_mwh"].between(0.0, params.nominal_volume_mwh + 1e-6).all(), (
    "storage outside [0, nominal volume]"
)
# The cycle count is cumulative, so it must not fall — but it is accumulated
# window by window in floating point, and 369 of its 52,607 steps come back
# negative by up to 6e-11. That is solver and summation noise, eleven orders of
# magnitude below one cycle, not a decision to un-spend wear.
worst_step = float(plan["cycles"].diff().min())
assert worst_step > -1e-9, f"the cycle count falls by {worst_step:,.3g}, beyond rounding noise"

print("provenance checks passed")
print(f"worst backward step in the cycle count:  {worst_step:,.3g}  (rounding noise)")

# %%
# The derived columns the rest of the notebook works in (with_derived_columns):
# signed net power, positive delivering, and buy_at / sell_at — a trader with
# both markets open buys at the cheaper of the two and sells into the dearer, in
# every period. Everything below that talks about "the day's prices" is built
# from those two.
plan = with_derived_columns(plan)

# How many periods a day the plan is actually on each side. These two counts
# calibrate the harvestable spread: the battery does not take the day's one best
# trade, it takes about fourteen of them. The daily frame carries the day's
# range (the one best trade, which §2 uses) and that harvestable spread (what the
# battery's own throughput can reach, which §4 and §6 use).
PERIODS_SELLING, PERIODS_BUYING = trading_periods(plan)
daily = daily_summary(plan, params)
print(f"the plan buys in {PERIODS_BUYING} periods a day and sells in {PERIODS_SELLING}, on average")
daily.head()

# %% [markdown]
# ## §1 Headline reconciliation
#
# The figures of `results.md`, recomputed from the plan and placed beside the
# documented value. `delta` is what moved; anything other than a rounding
# difference means the document is quoting a run that no longer exists.

# %%
# The values as the document prints them, transcribed once. Rounded as the
# document rounds them, so the tolerance column below is what matters.
DOCUMENTED = {
    "profit_gbp": 207_365.0,
    "energy_bought_mwh": 14_495.0,
    "mean_buy_price_gbp_per_mwh": 34.98,
    "energy_delivered_mwh": 13_082.0,
    "mean_sell_price_gbp_per_mwh": 54.61,
    "cycles_used": 3_443.0,
    "final_usable_volume_mwh": 3.86,
    "periods_charging": 16_774.0,
    "periods_discharging": 15_179.0,
    "periods_idle": 20_655.0,
    "profit_per_cycle_gbp": 60.23,
}

figures = headline_figures(plan, params)

reconciliation = pd.DataFrame(
    {
        "plan": {k: figures[k] for k in DOCUMENTED},
        "documented": DOCUMENTED,
    }
)
reconciliation["delta"] = reconciliation["plan"] - reconciliation["documented"]
# The plan is quoted to the penny; the document rounds. A period count may move
# by one or two where a tie between idle and a near-zero trade breaks the other
# way, which README calls out, so the counts get a wider tolerance than the money.
tolerance = pd.Series(
    {k: 2.0 if k.startswith("periods") else 0.6 for k in DOCUMENTED},
)
reconciliation["agrees"] = reconciliation["delta"].abs() <= tolerance
reconciliation.style.format({"plan": "{:,.2f}", "documented": "{:,.2f}", "delta": "{:+,.2f}"})

# %%
if reconciliation["agrees"].all():
    print("every headline figure agrees with results.md")
else:
    print("DRIFT — results.md quotes a different run:")
    print(reconciliation[~reconciliation["agrees"]])

# %% [markdown]
# ### The markets as a pair
#
# The second set of claims in `results.md`: Market 2 is dearer most of the
# time, and the plan buys in Market 1 and sells into Market 2 to collect that.

# %%
markets = market_pair(plan, params)
pair = pd.DataFrame(
    {
        "plan": {
            "periods market 2 dearer (%)": 100 * markets["share_market_2_dearer"],
            "mean market 2 less market 1 (£/MWh)": markets["mean_spread_gbp_per_mwh"],
            "bought in market 1 (MWh)": markets["bought_market_1_mwh"],
            "bought in market 2 (MWh)": markets["bought_market_2_mwh"],
            "delivered into market 1 (MWh)": markets["delivered_market_1_mwh"],
            "delivered into market 2 (MWh)": markets["delivered_market_2_mwh"],
            "degradation, rho x cycles (% of volume)": figures["degradation_pct"],
        },
        "documented": {
            "periods market 2 dearer (%)": 77.5,
            "mean market 2 less market 1 (£/MWh)": 3.51,
            "bought in market 1 (MWh)": 11_208.0,
            "bought in market 2 (MWh)": np.nan,
            "delivered into market 1 (MWh)": np.nan,
            "delivered into market 2 (MWh)": 11_171.0,
            "degradation, rho x cycles (% of volume)": 3.4,
        },
    }
)
pair.style.format("{:,.2f}", na_rep="—")

# %% [markdown]
# ## §2 The price landscape
#
# What the model was handed. One line makes the rest of the notebook readable:
# at a 90.25% round trip, a spread has to clear about 11% of the buy price
# before a trade is worth making.

# %%
markup = breakeven_markup(params)
print(f"a round trip keeps {params.round_trip_efficiency:.2%}")
print(f"so a sale has to beat the purchase by {markup:.1%} before it pays")

# %%
monthly = monthly_prices(plan)

fig, ax = plt.subplots(figsize=(11, 4))
for column, colour, label in (
    ("price_1", CHARGE, "Market 1 (half-hourly)"),
    ("price_2", DISCHARGE, "Market 2 (hourly)"),
):
    mean = monthly[f"{column}_mean"]
    ax.fill_between(
        mean.index,
        monthly[f"{column}_p10"],
        monthly[f"{column}_p90"],
        color=colour,
        alpha=0.15,
        lw=0,
    )
    ax.plot(mean.index, mean, color=colour, lw=2.0)
    ax.text(mean.index[-1] + pd.Timedelta("20D"), mean.iloc[-1], label, color=colour, va="center")

ax.set_ylabel("£/MWh")
ax.set_title("Monthly mean price, with the inter-decile band", loc="left", color=INK)
ax.set_xlim(plan.index[0], plan.index[-1] + pd.Timedelta("400D"))
sns.despine(ax=ax)
plt.show()

# %% [markdown]
# The level falls year on year. What the battery is paid for is the spread, and
# the two parts of that spread — between the markets at one instant, and within
# one market across the day — are worth separating.

# %%
fig, axes = plt.subplots(1, 2, figsize=(11, 3.8))

share_dearer = markets["share_market_2_dearer"]
edges, counts = spread_histogram(plan)
axes[0].stairs(counts, edges, fill=True, color=DISCHARGE, alpha=0.85)
axes[0].axvline(0.0, color=MUTED, lw=1.0, ls=(0, (4, 3)))
axes[0].set_xlabel("price 2 − price 1  (£/MWh, clipped at ±20)")
axes[0].set_ylabel("periods")
axes[0].set_title(
    f"Market 2 is dearer in {share_dearer:.1%} of periods",
    loc="left",
    color=INK,
)

profile = half_hour_profile(plan)
axes[1].plot(profile["price_1"], color=CHARGE, lw=2.0, label="Market 1")
axes[1].plot(profile["price_2"], color=DISCHARGE, lw=2.0, label="Market 2")
axes[1].set_xlabel("hour of day")
axes[1].set_ylabel("mean £/MWh")
axes[1].set_title("The shape the battery trades against", loc="left", color=INK)
axes[1].legend(frameon=False)

sns.despine(fig=fig)
fig.tight_layout()
plt.show()

# %%
buy_floor = daily["buy_floor"]
breakeven_level = buy_floor * (1.0 + markup)
sell_ceiling = daily["sell_ceiling"]
share_worth_trading = days_worth_trading(daily, params)

fig, ax = plt.subplots(figsize=(11, 4))
ax.fill_between(
    sell_ceiling.index, buy_floor, sell_ceiling, color=CHARGE, alpha=0.18, lw=0, label="day's range"
)
ax.plot(
    breakeven_level.index, breakeven_level, color=DISCHARGE, lw=1.2, label="breakeven on the floor"
)
ax.set_ylabel("£/MWh")
ax.set_ylim(0, min(200, float(sell_ceiling.max())))
ax.set_title(
    f"The day's range against what a trade has to clear — "
    f"{share_worth_trading:.1%} of days clear it",
    loc="left",
    color=INK,
)
ax.legend(frameon=False, loc="upper right")
sns.despine(ax=ax)
plt.show()

# %% [markdown]
# ## §3 What the plan actually does
#
# The dispatch itself, which no document currently shows. Three zoom levels: a
# couple of days traced period by period, a year as one picture, and the mean
# day.
#
# In the close-up, colour is the *market* — blue Market 1, orange Market 2, the
# same as the price lines above it — and the sign is the direction: bars above
# the line are energy going in, bars below it energy going out.

# %%
week = plan.loc["2018-01-16":"2018-01-17"]

fig, (top, bottom) = plt.subplots(
    2, 1, figsize=(12, 6), sharex=True, gridspec_kw={"height_ratios": [1.0, 1.2]}
)

top.plot(week.index, week["price_1"], color=CHARGE, lw=1.4, label="Market 1")
top.plot(
    week.index, week["price_2"], color=DISCHARGE, lw=1.4, drawstyle="steps-post", label="Market 2"
)
top.set_ylabel("£/MWh")
top.legend(frameon=False, ncol=2, loc="upper left", fontsize=9)
top.set_title("Two days of dispatch: prices above, decisions below", loc="left", color=INK)

# Colour is the market, not the direction: a bar carries the same blue or
# orange as the price line it was traded against, and its sign says which way
# the energy went. Each side is stacked, so a period split across both markets
# shows as one bar in two colours.
width = pd.Timedelta("30min")
bottom.bar(week.index, week["charge_1_mw"], width=width, color=CHARGE)
bottom.bar(
    week.index, week["charge_2_mw"], width=width, bottom=week["charge_1_mw"], color=DISCHARGE
)
bottom.bar(week.index, -week["discharge_1_mw"], width=width, color=CHARGE)
bottom.bar(
    week.index,
    -week["discharge_2_mw"],
    width=width,
    bottom=-week["discharge_1_mw"],
    color=DISCHARGE,
)
bottom.axhline(0.0, color=MUTED, lw=0.8)
bottom.set_ylabel("MW")

# The direction is in the sign, so it is named on the axis rather than in a
# legend that would repeat the one above.
for height, text, align in ((0.93, "charging", "top"), (0.07, "delivering", "bottom")):
    bottom.text(
        0.006,
        height,
        text,
        transform=bottom.transAxes,
        color=MUTED,
        fontsize=9,
        va=align,
    )

storage = bottom.twinx()
storage.plot(week.index, week["storage_mwh"], color=MUTED, lw=1.6, alpha=0.8)
storage.set_ylabel("storage (MWh)", color=MUTED)
storage.set_ylim(0, params.nominal_volume_mwh * 1.05)
storage.grid(visible=False)

sns.despine(ax=top)
sns.despine(ax=bottom, right=False)
fig.tight_layout()
plt.show()

# %% [markdown]
# A year at once. Each column is a day, each row a half hour: blue is charging,
# orange delivering. The diurnal pattern and its seasonal drift read together.

# %%
heat = net_power_grid(plan.loc["2020"])

fig, ax = plt.subplots(figsize=(12, 4.2))
limit = float(np.abs(heat.to_numpy()).max())
mesh = ax.pcolormesh(
    heat.columns,
    heat.index / 2.0,
    heat.to_numpy(),
    cmap=sns.blend_palette([CHARGE, SURFACE, DISCHARGE], as_cmap=True),
    vmin=-limit,
    vmax=limit,
    shading="nearest",
)
ax.set_ylabel("hour of day")
ax.set_yticks([0, 6, 12, 18, 24])
ax.set_title("2020, half hour by half hour: net power", loc="left", color=INK)
bar = fig.colorbar(mesh, ax=ax, pad=0.015)
bar.set_label("MW  (− charging, + delivering)")
fig.tight_layout()
plt.show()

# %%
fig, axes = plt.subplots(1, 2, figsize=(11, 3.8))

axes[0].plot(profile.index, -profile["charge_1_mw"], color=CHARGE, lw=2.0, label="charge, market 1")
axes[0].plot(
    profile.index,
    -profile["charge_2_mw"],
    color=CHARGE,
    lw=1.4,
    ls=(0, (4, 2)),
    label="charge, market 2",
)
axes[0].plot(
    profile.index,
    profile["discharge_1_mw"],
    color=DISCHARGE,
    lw=1.4,
    ls=(0, (4, 2)),
    label="deliver, market 1",
)
axes[0].plot(
    profile.index, profile["discharge_2_mw"], color=DISCHARGE, lw=2.0, label="deliver, market 2"
)
axes[0].axhline(0.0, color=MUTED, lw=0.8)
axes[0].set_xlabel("hour of day")
axes[0].set_ylabel("mean MW")
axes[0].set_title("Each market is used for one side of the trade", loc="left", color=INK)
axes[0].legend(frameon=False, fontsize=8)

axes[1].stackplot(
    profile.index,
    profile["share_charging"],
    profile["share_delivering"],
    profile["share_idle"],
    colors=[CHARGE, DISCHARGE, "#dcdcd8"],
    labels=["charging", "delivering", "idle"],
)
axes[1].set_xlabel("hour of day")
axes[1].set_ylabel("share of periods")
axes[1].set_ylim(0, 1)
axes[1].set_title("What the battery is doing, by hour", loc="left", color=INK)
axes[1].legend(frameon=False, fontsize=8, loc="lower center", ncol=3)

sns.despine(fig=fig)
fig.tight_layout()
plt.show()

# %% [markdown]
# ### The constraints, verified on the plan
#
# §4.3 forbids charging and delivering in the same period; §4.5 holds each
# Market 2 decision flat across its hour. Both are asserted in `tests/`
# against freshly solved windows — here they are read off the committed plan,
# which is the artefact every figure above and every number in `results.md`
# comes from.

# %%
checks = constraint_checks(plan, params).rename(
    {
        "both_charging_and_delivering": "§4.3 periods both charging and delivering",
        "market_2_not_flat_hours": "§4.5 hours with a non-flat market 2 decision",
        "over_rate_limit": "§4.3 periods over the rate limit",
        "over_degraded_volume": "§4.1 periods over the degraded volume",
        "over_cycle_budget": "§4.6 cycles spent beyond the budget",
    }
)
print(checks.to_string())
print(f"\n{'all clear' if checks.sum() == 0 else 'VIOLATIONS — see above'}")

# %% [markdown]
# ## §4 Where the profit comes from
#
# `results.md` reads the profit as part arbitrage over time, part the standing
# gap between the two markets. Here it is split.
#
# Take Market 1, the half-hourly market, as the reference. Valuing every
# decision at the Market 1 price of its own period gives the first part: what
# the same volumes would have earned traded entirely in Market 1. The rest is
# what using Market 2 added, period by period. The split is exact — the two
# parts sum to the profit — but the first part is a *valuation*, not a feasible
# alternative plan: a plan confined to Market 1 would not face §4.5 and would
# choose different volumes.

# %%
split = profit_split(plan, params).rename(
    {
        "time_arbitrage_gbp": "time arbitrage, valued at market 1",
        "market_2_gap_gbp": "the market 2 gap",
        "profit_gbp": "profit",
    }
)
from_market_2 = split["the market 2 gap"]
assert abs(split["profit"] - figures["profit_gbp"]) < 0.01, "the split must be exact"
print(split.map("£{:,.0f}".format).to_string())
print(f"\nthe market 2 gap is {from_market_2 / figures['profit_gbp']:.1%} of the profit")

# %%
fig, axes = plt.subplots(1, 2, figsize=(11, 3.8))

cumulative = plan["net_revenue_gbp"].cumsum()
axes[0].fill_between(cumulative.index, 0, cumulative, color=DISCHARGE, alpha=0.2, lw=0)
axes[0].plot(cumulative.index, cumulative, color=DISCHARGE, lw=1.8)
axes[0].yaxis.set_major_formatter(GBP)
axes[0].set_title("Cumulative profit", loc="left", color=INK)
axes[0].tick_params(axis="x", rotation=30)

by_month = monthly_profit(plan)
axes[1].bar(
    by_month.index,
    by_month,
    width=25,
    color=np.where(by_month >= 0, DISCHARGE, CHARGE),
)
axes[1].axhline(0.0, color=MUTED, lw=0.8)
axes[1].yaxis.set_major_formatter(GBP)
axes[1].set_title("Profit by month", loc="left", color=INK)
axes[1].tick_params(axis="x", rotation=30)

sns.despine(fig=fig)
fig.tight_layout()
plt.show()

# %%
# Year by year, as results.md tables it, with the spread added as the column
# that explains the progression.
by_year = yearly_summary(plan, daily)
by_year.style.format("{:,.2f}").format({"profit_gbp": "£{:,.0f}", "cycles": "{:,.0f}"})

# %% [markdown]
# ## §5 Cycles, wear, and the budget that did not bind
#
# 3,443 of 5,000 cycles spent, so the cap of §4.6 never bound and the shadow
# price of §6 stayed at zero. The pro-rated reading of §5 — three years of a
# ten-year life, 1,500 cycles — is crossed less than halfway through, which is
# where λ would start to matter.

# %%
prorated, crossing = prorated_crossing(plan, spec)
print(f"full budget      {params.cycle_budget:,.0f} cycles — {figures['cycles_used']:,.0f} spent")
print(f"pro-rated (§5)   {prorated:,.0f} cycles — crossed on {crossing:%Y-%m-%d}")

# %%
fig, axes = plt.subplots(1, 3, figsize=(12, 3.6))

axes[0].plot(plan.index, plan["cycles"], color=DISCHARGE, lw=1.8)
for level, label in ((params.cycle_budget, "5,000 cycle life"), (prorated, "1,500 pro-rated (§5)")):
    axes[0].axhline(level, color=MUTED, lw=0.9, ls=(0, (4, 3)))
    axes[0].text(plan.index[0], level + 70, label, color=MUTED, fontsize=8)
axes[0].set_ylabel("equivalent full cycles")
axes[0].set_ylim(0, params.cycle_budget * 1.08)
axes[0].set_title("Cycles spent against both budgets", loc="left", color=INK)
axes[0].tick_params(axis="x", rotation=30)

axes[1].hist(daily["cycles"], bins=40, color=CHARGE, alpha=0.85)
mean_per_day = float(daily["cycles"].mean())
axes[1].axvline(mean_per_day, color=INK, lw=1.2)
axes[1].text(
    mean_per_day, axes[1].get_ylim()[1] * 0.92, f"  mean {mean_per_day:.1f}/day", fontsize=9
)
axes[1].set_xlabel("cycles in a day")
axes[1].set_ylabel("days")
axes[1].set_title("One cycle a day is not the constraint", loc="left", color=INK)

axes[2].plot(plan.index, plan["effective_volume_mwh"], color=INK, lw=1.8)
axes[2].set_ylabel("usable volume (MWh)")
axes[2].set_ylim(params.nominal_volume_mwh * 0.94, params.nominal_volume_mwh * 1.005)
axes[2].set_title("$S_{max}(t)$ after degradation (§4.7)", loc="left", color=INK)
axes[2].tick_params(axis="x", rotation=30)

sns.despine(fig=fig)
fig.tight_layout()
plt.show()

# %%
# What the wear cost, priced at the spreads the plan actually realised. Not a
# charge in the objective — §5 keeps degradation physical, in the volume — so
# this is the opportunity cost of the capacity given up, for context.
wear = wear_cost(params, figures, daily)
volume_lost_mwh = wear["volume_lost_mwh"]
realised_margin = wear["realised_margin_gbp_per_mwh"]
cycles_per_day = wear["cycles_per_day"]
forgone_per_year = wear["forgone_per_year_gbp"]

print(f"volume lost over the horizon  {volume_lost_mwh:.3f} MWh of {params.nominal_volume_mwh:.2f}")
print(f"realised margin per MWh       £{realised_margin:,.2f}")
print(
    f"forgone trading, per year     £{forgone_per_year:,.0f} at {cycles_per_day:.1f} cycles a day"
)

# %% [markdown]
# ## §6 Is the result tracking the spread, or the level?
#
# `results.md` reads 2020 — the cheapest year and the most profitable — as the
# battery being paid for the spread rather than the level. That reading rests
# on three annual rows. There are 1,096 daily ones.
#
# First, *which* spread. "The day's spread" has at least four readings, and
# they are not interchangeable:
#
# - **the range**, highest price less lowest, which is one perfect trade and
#   the battery makes about three a day;
# - **the harvestable spread** of §0, the same thing averaged over as many
#   periods as the plan actually trades;
# - **volatility**, the within-day standard deviation, which is agnostic about
#   how the battery would capture it;
# - **the realised spread**, what the plan itself paid and received that day.
#
# The last one is tempting and wrong as an explanation: it is an output of the
# dispatch, not a property of the day, so regressing profit on it explains the
# result with the result. It is still worth measuring, as a description of what
# was captured — which is why it is in the table and not in the figure.

# %%
# What each reading of "the day's spread" explains, measured the same way.
readings = spread_readings(plan, params, daily)
explained = (
    spread_explanation(readings, daily)
    .set_index("reading")
    .rename(columns={"gbp_per_unit": "£ per unit", "r2": "R²"})
)
explained.style.format({"£ per unit": "{:,.2f}", "R²": "{:.3f}"})

# %%
fig, axes = plt.subplots(1, 2, figsize=(11, 4), sharey=True)

for ax, column, colour, label in (
    (axes[0], "harvestable_spread", DISCHARGE, "the day's harvestable spread (£/MWh)"),
    (axes[1], "mean_price", CHARGE, "the day's mean price (£/MWh)"),
):
    slope, intercept, r2 = fit(daily[column], daily["profit_gbp"])
    ax.scatter(daily[column], daily["profit_gbp"], s=6, color=colour, alpha=0.35, lw=0)
    line = np.linspace(daily[column].min(), daily[column].max(), 50)
    ax.plot(line, slope * line + intercept, color=INK, lw=1.4)
    ax.set_xlabel(label)
    ax.set_title(f"£{slope:,.1f} per unit · $R^2$ = {r2:.2f}", loc="left", color=INK)

axes[0].set_ylabel("profit in the day (£)")
axes[0].yaxis.set_major_formatter(GBP)
for ax in axes:
    ax.set_xlim(0, 150)
    ax.set_ylim(-50, 1_000)
sns.despine(fig=fig)
fig.tight_layout()
plt.show()

# %%
# The two moving apart is the mechanism the document asserts: the level fell
# while the spread widened.
quarterly = quarterly_level_and_spread(daily).rename(
    columns={"mean_price": "mean price", "harvestable_spread": "mean harvestable spread"}
)
normalised = quarterly / quarterly.iloc[0]

fig, ax = plt.subplots(figsize=(10, 3.6))
ax.plot(normalised.index, normalised["mean price"], color=CHARGE, lw=2.0, label="price level")
ax.plot(
    normalised.index,
    normalised["mean harvestable spread"],
    color=DISCHARGE,
    lw=2.0,
    label="harvestable spread",
)
ax.axhline(1.0, color=MUTED, lw=0.8, ls=(0, (4, 3)))
ax.set_ylabel("relative to Q1 2018")
ax.set_title("The level fell; the spread did not follow it down", loc="left", color=INK)
ax.legend(frameon=False)
sns.despine(ax=ax)
plt.show()

# %% [markdown]
# ## §7 The yardstick, as a distribution
#
# `results.md` compares the model against one perfect 4 MWh cycle a day, bought
# at the day's floor and sold at its ceiling over both markets: £178,254 over
# the horizon. That yardstick ignores the rate limits of §4.3, the hourly
# commitment of §4.5 and the cycle cap of §4.6, so it is not a bound — it is
# the order-of-magnitude check. Taken daily rather than summed, it also says
# *where* the model beats it.

# %%
# daily_summary prices one ideal cycle of the nominal volume a day: the
# yardstick spends no wear.
yardstick = yardstick_summary(daily, figures)
yardstick_total = yardstick["total_gbp"]
print(f"one ideal cycle a day   £{yardstick_total:,.0f}   (results.md: £178,254)")
print(f"the model, against it   {yardstick['ratio']:.2f}x")
print(f"cycles a day, mean      {figures['cycles_used'] / (len(plan) / 48):.1f}")
days_lost = int(yardstick["days_below"])
print(f"days the model loses    {days_lost} of {len(daily):,}")

# %%
fig, axes = plt.subplots(1, 2, figsize=(11, 3.8))

axes[0].scatter(daily["yardstick_gbp"], daily["profit_gbp"], s=6, color=DISCHARGE, alpha=0.35, lw=0)
# The axes stop at the 99th percentile: a handful of storm days would otherwise
# push the thousand days that matter into one corner. They are still plotted.
limit = float(max(daily["yardstick_gbp"].quantile(0.99), daily["profit_gbp"].quantile(0.99)))
axes[0].plot([0, limit], [0, limit], color=MUTED, lw=1.0, ls=(0, (4, 3)))
axes[0].text(limit * 0.55, limit * 0.62, "parity", color=MUTED, fontsize=9, rotation=36)
axes[0].set_xlabel("one ideal cycle that day (£)")
axes[0].set_ylabel("the model that day (£)")
axes[0].xaxis.set_major_formatter(GBP)
axes[0].yaxis.set_major_formatter(GBP)
axes[0].set_xlim(0, limit)
axes[0].set_ylim(0, limit)
axes[0].set_xticks(np.arange(0, limit, 200))
axes[0].set_yticks(np.arange(0, limit, 200))
axes[0].set_title("Mostly above parity, on narrower spreads too", loc="left", color=INK)

by_year_ratio = by_year["yardstick_median_ratio"]
axes[1].bar(by_year_ratio.index.astype(str), by_year_ratio, width=0.55, color=CHARGE)
axes[1].axhline(1.0, color=MUTED, lw=0.9, ls=(0, (4, 3)))
axes[1].set_ylabel("model / yardstick, median day")
axes[1].set_title("The edge is steady across the three years", loc="left", color=INK)

sns.despine(fig=fig)
fig.tight_layout()
plt.show()

# %%
# The costs §5 leaves out of the objective, for context only.
costs = lifetime_cost(spec, len(plan))
print(f"trading profit                     £{figures['profit_gbp']:,.0f}")
print(f"capex + opex over {costs['years']:.1f} years        £{costs['total_gbp']:,.0f}")
print(f"short of paying for itself by      £{costs['total_gbp'] - figures['profit_gbp']:,.0f}")

# %% [markdown]
# ## §8 Solver evidence
#
# The committed measurement CSVs behind
# [`tractability.md`](../docs/model/tractability.md) and
# [`cycle-value-experiments.md`](../docs/model/cycle-value-experiments.md),
# plotted. They are the reason the horizon is decomposed at all, and the reason
# cutting planes are the default method for λ.

# %%
DOCS_MODEL = PLAN_PATH.parents[2] / "docs" / "model"

tractability = pd.read_csv(DOCS_MODEL / "tractability.csv")
sweep = pd.read_csv(DOCS_MODEL / "cycle-value-sweep.csv")
tolerance_sweep = pd.read_csv(DOCS_MODEL / "cycle-value-tolerance.csv")
long_horizons = pd.read_csv(DOCS_MODEL / "cycle-value-long-horizons.csv")

tractability

# %%
fig, ax = plt.subplots(figsize=(7.5, 4))

solved = tractability[tractability["status"] == "Optimal"]
stopped = tractability[tractability["status"] != "Optimal"]

ax.plot(
    solved["periods"], solved["solve_seconds"].clip(lower=0.05), "o-", color=CHARGE, lw=1.8, ms=6
)
ax.plot(stopped["periods"], stopped["solve_seconds"], "X", color=DISCHARGE, ms=11)
for _, row in stopped.iterrows():
    ax.annotate(
        f"the whole horizon as one MILP:\nstopped at the hour, {row['gap_pct']:.1f}% gap",
        xy=(row["periods"], row["solve_seconds"]),
        xytext=(row["periods"] * 0.18, row["solve_seconds"] * 0.45),
        color=DISCHARGE,
        fontsize=9,
        ha="right",
        va="center",
        arrowprops=dict(arrowstyle="-", color=DISCHARGE, lw=0.8, shrinkA=2, shrinkB=6),
    )

ax.set_xscale("log")
ax.set_yscale("log")
ax.set_xlabel("periods in the program")
ax.set_ylabel("solve seconds")
ax.set_title(
    "Solve time against window length — why the horizon is decomposed", loc="left", color=INK
)
sns.despine(ax=ax)
plt.show()

# %%
fig, axes = plt.subplots(1, 3, figsize=(12, 3.6))

axes[0].plot(
    sweep["days"],
    sweep["cutting_seconds"],
    "o-",
    color=CHARGE,
    lw=1.8,
    ms=5,
    label="cutting planes",
)
axes[0].plot(
    sweep["days"],
    sweep["bisection_seconds"],
    "s--",
    color=DISCHARGE,
    lw=1.6,
    ms=5,
    label="bisection",
)
axes[0].plot(
    sweep["days"], sweep["exact_seconds"], "^:", color=INK, lw=1.4, ms=5, label="exact solve"
)
axes[0].set_yscale("log")
axes[0].set_xlabel("horizon (days)")
axes[0].set_ylabel("seconds")
axes[0].set_title("Cost", loc="left", color=INK)
axes[0].legend(frameon=False, fontsize=8)

axes[1].plot(sweep["days"], sweep["cutting_passes"], "o-", color=CHARGE, lw=1.8, ms=5)
axes[1].plot(sweep["days"], sweep["bisection_passes"], "s--", color=DISCHARGE, lw=1.6, ms=5)
axes[1].set_xlabel("horizon (days)")
axes[1].set_ylabel("passes")
axes[1].set_ylim(0, 16)
axes[1].set_title("Bisection pays a fixed 13 passes", loc="left", color=INK)

gap_cutting = 100 * (1 - sweep["cutting_profit_gbp"] / sweep["exact_profit_gbp"])
gap_bisection = 100 * (1 - sweep["bisection_profit_gbp"] / sweep["exact_profit_gbp"])
axes[2].plot(sweep["days"], gap_cutting, "o-", color=CHARGE, lw=1.8, ms=5)
axes[2].plot(sweep["days"], gap_bisection, "s--", color=DISCHARGE, lw=1.6, ms=5)
axes[2].axhline(0.0, color=MUTED, lw=0.8)
axes[2].set_xlabel("horizon (days)")
axes[2].set_ylabel("% below the exact solve")
axes[2].set_title("Both land within a percent", loc="left", color=INK)

sns.despine(fig=fig)
fig.tight_layout()
plt.show()

# %% [markdown]
# Bisection costs more passes and certifies nothing — its bound columns are
# empty by construction. Cutting planes return a dual bound with the plan,
# which is what the gap column below is. The λ the two methods find agree to
# within a pound or two, on budgets set to half what the horizon would spend.

# %%
comparison = sweep[
    [
        "days",
        "budget_cycles",
        "cutting_lambda",
        "bisection_lambda",
        "cutting_gap_pct",
        "profit_delta_pct",
    ]
].rename(
    columns={
        "cutting_lambda": "λ cutting",
        "bisection_lambda": "λ bisection",
        "cutting_gap_pct": "cutting gap %",
        "profit_delta_pct": "cutting vs bisection %",
    }
)
comparison.style.format("{:,.2f}").hide(axis="index")

# %%
# Where the tolerance stops buying anything, and the method on horizons long
# enough to matter.
fig, axes = plt.subplots(1, 2, figsize=(11, 3.6))

axes[0].plot(
    tolerance_sweep["tolerance"], tolerance_sweep["gap_pct"], "o-", color=CHARGE, lw=1.8, ms=6
)
for _, row in tolerance_sweep.iterrows():
    axes[0].annotate(
        f"{int(row['passes'])} passes",
        xy=(row["tolerance"], row["gap_pct"]),
        xytext=(0, 9),
        textcoords="offset points",
        fontsize=8,
        color=MUTED,
        ha="center",
    )
axes[0].set_xscale("log")
axes[0].set_xlabel("relative tolerance")
axes[0].set_ylabel("gap achieved (%)")
axes[0].set_title("30 days: $10^{-3}$ is where it stops paying", loc="left", color=INK)

slots = np.arange(len(long_horizons))
axes[1].bar(slots, long_horizons["cutting_seconds"], width=0.55, color=CHARGE)
axes[1].set_xticks(slots)
axes[1].set_xticklabels(long_horizons["days"].astype(int).astype(str))
for slot, row in zip(slots, long_horizons.itertuples(), strict=True):
    axes[1].annotate(
        f"{row.cutting_passes} passes\nλ = {row.cutting_lambda:.0f}",
        xy=(slot, row.cutting_seconds),
        xytext=(0, 6),
        textcoords="offset points",
        fontsize=8,
        color=MUTED,
        ha="center",
    )
axes[1].set_xlabel("horizon (days)")
axes[1].set_ylabel("seconds")
axes[1].set_ylim(0, long_horizons["cutting_seconds"].max() * 1.35)
axes[1].set_title("Cutting planes on long horizons", loc="left", color=INK)

sns.despine(fig=fig)
fig.tight_layout()
plt.show()

# %% [markdown]
# ## §9 Findings
#
# What the analysis above confirmed, and what it adds to the documents. Every
# figure quoted here is printed by a cell above.
#
# **The document reconciles.** Every headline figure of `results.md` is
# reproduced from the committed plan within its rounding, and the market-pair
# claims — Market 2 dearer in 77.5% of periods, £3.51/MWh on average, 11,208
# MWh bought in Market 1 against 11,171 MWh delivered into Market 2 — come back
# as quoted. The §1 cell is the one to re-run after any dispatch change: it
# fails loudly rather than quietly disagreeing.
#
# **One artefact of the plan is worth knowing about.** The cumulative cycle
# count is not quite monotonic: 369 of its 52,607 steps fall, by up to 6e-11,
# where wear accumulated window by window in floating point rounds backwards.
# Eleven orders of magnitude below one cycle, so it changes nothing — but a
# strict monotonicity check on that column fails, and §0 checks it against a
# tolerance for that reason.
#
# **The two markets are used for opposite sides of the trade, and the split is
# by hour.** §3's intraday profile shows what the annual MWh totals in
# `results.md` cannot: charging is Market 1 overnight, heaviest around 03:30,
# and delivery is Market 2 into the evening peak, heaviest at 17:00 and again
# at the 07:00 shoulder. Market 2 is also used to *buy* in the midday trough,
# peaking at 13:00 — the only hours where the dearer market is the cheaper one.
# That is the commitment of §4.5 being paid for, hour by hour.
#
# **The cross-market gap is a large minority of the profit, not the bulk of
# it.** Valuing every decision at Market 1 prices leaves £129,005 of time
# arbitrage against £78,360 from using Market 2 — 37.8% of the profit. Worth
# saying with numbers in `results.md`, which currently says only "part … part".
#
# **The cycle budget is slack by a wide margin, and would not be under §5.**
# 3,443 of 5,000 spent at a mean 3.1 cycles a day; the pro-rated 1,500 of §5 is
# crossed on 2019-06-29, halfway through the horizon. The 0.138 MWh of volume
# the wear cost is worth about £3,100 a year of forgone trading at the plan's
# own margin and cycling, which is the scale λ would have to price. The
# counterfactual dispatch under that budget is the obvious next experiment and
# is deliberately not run here — it solves, and this notebook does not.
#
# **The spread, not the level, explains the result — at daily resolution too.**
# Daily profit on the day's harvestable spread gives £6.16 per £/MWh at an
# $R^2$ of 0.57; on the day's mean price, 0.05. The level carries almost
# nothing. The three annual rows in `results.md` were reading this correctly.
#
# **Which spread matters, though.** The day's range — highest price less
# lowest — is one perfect trade, and the battery takes about fourteen a day, so
# it understates good days and explains less (£3.35, $R^2$ 0.52). Averaging the
# day's best fourteen selling periods against its cheapest fifteen measures the
# spread over the volume the battery can actually move, and explains more. The
# plan's *own* realised spread explains least of the four exogenous readings
# ($R^2$ 0.48) and is circular besides — it is an output of the dispatch, not a
# property of the day — so it is reported as a description and never used as an
# explanation.
#
# **The yardstick edge is steady, not a 2020 artefact.** The model beats one
# ideal 4 MWh cycle a day on 64%, 64% and 72% of the days of 2018, 2019 and
# 2020, at a median ratio near 1.17 in every year, by taking narrower spreads
# as well as the daily best. The 1.16x over the horizon is not one good year.
#
# **Open.** The profit split of §4 takes Market 1 as the reference; the mirror
# split, valued at Market 2, would attribute differently and is worth reporting
# beside it. Nothing here tests whether the dispatch pattern of §3 survives on
# different price data — that needs another three years, not another reading of
# these.
