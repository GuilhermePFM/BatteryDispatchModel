# Glossary

*Every term the model, the code and the write-up use, with the one word chosen
for each idea.*

[← README](../README.md) · [data](data.md) · [architecture](architecture.md) ·
[solve](solve.md) · [validation](validation.md)

---

## 1. One idea, one word

| Idea | The word | Never called |
| --- | --- | --- |
| Energy flowing into the battery | **charge** (`charge_mw`) | — |
| Energy flowing out of the store | **discharge** (`discharge_mw`) | — |
| Energy in the store | **storage**, `S_t` (`storage_mwh`) | *charge*, *state of charge* |
| BRL/MWh settled by the market | **PLD** (`pld`) | — |
| The model's output | **dispatch plan** | *schedule* |
| One of the eight solved programs | **case** of a **submarket** | *scenario* |

## 2. The market

| Term | Meaning |
| --- | --- |
| **PLD** | *Preço de Liquidação das Diferenças*: the hourly settlement price, per submarket, in BRL/MWh |
| **Submarket** | SE, S, NE or N. The battery sits in exactly one |
| **CCEE** | The chamber that publishes the PLD and settles the market |
| **ONS** | The system operator, which centrally dispatches a contracted battery |
| **LRCAP** | The 2026 capacity reserve auction for storage |
| **CRCAP** | The capacity contract signed in that auction |
| **CONCAP** | The account that receives the PLD settlement of a contracted battery |
| **RF₀** | Fixed revenue at the May 2026 base, BRL/MW-year |
| **IPCA** | The inflation index that corrects the fixed revenue, opex and replacement |

## 3. The business cases

| Term | Meaning |
| --- | --- |
| **Contracted case** | LRCAP fixed revenue less reimbursements and penalties. The PLD dispatch is only a proxy for the ONS, used to measure cycles, wear and losses |
| **Merchant case** | PLD arbitrage, with no fixed revenue and no contract limits |
| **Portfolio** | The eight solutions of a run: 4 submarkets × 2 cases |
| **Ranking** | Submarkets ordered by merchant value |
| **Regret** | Value lost by building in a submarket other than the best |

## 4. The battery

| Term | Symbol | Meaning |
| --- | --- | --- |
| **Delivered power** | $P$ (`power_mw`) | Power at the grid, the contracted availability |
| **Storage volume** | $E$ (`volume_mwh`) | Nominal volume before degradation |
| **Charge / discharge rate** | $\overline{C}$, $\overline{D}$ | Measured on the grid side and on the storage side |
| **One-way efficiencies** | $\eta_c$, $\eta_d$ | Their product is the round-trip efficiency (RTE) |
| **Degradation** | | Share of the nominal volume lost per equivalent full cycle |
| **Equivalent full cycle** | $n_t$ | Physical cycle count: discharge throughput over the volume |
| **Full cycle (contractual)** | | Discharged energy equal to contracted power × 4 h, net of losses |
| **κ** | | Contractual cycles per physical cycle |

## 5. The valuation

| Term | Meaning |
| --- | --- |
| **Perfect foresight** | The plan is chosen knowing the whole horizon, so its value is a ceiling |
| **24+0 backtest** | Each day decided seeing that day's prices and none of the next |
| **Capture factor (φ)** | Backtest value over perfect-foresight value |
| **Balanced year** | Annual revenue giving each calendar month equal weight |
| **Last twelve months** | The sum over the twelve months ending on the last day, a sensitivity |
| **NPV, IRR, payback** | The investment metrics of §8, on nominal cash flows |
| **Maximum viable capex** | The capex at which NPV is zero |
| **Minimum viable bid** | The fixed revenue, BRL/MW-year, at which the contracted NPV is zero |

## 6. The solve

| Term | Meaning |
| --- | --- |
| **Relaxation** | The contracted program without the 12 h binary, an upper bound on it |
| **Binary day** | A day whose hours carry the injection binary $z_t$, because its relaxed plan broke the limit |
| **Netting** | Settling a same-hour charge and discharge, which only a zero-loss tie can leave |
| **Params hash** | The sha256 that identifies a run by what it computes ([contracts](../contracts/README.md#the-params-hash)) |
| **Model version** | The `MODEL_VERSION` hashed into it, bumped when a change moves results |
