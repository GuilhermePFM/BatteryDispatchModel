# Battery dispatch and investment model

Formulation of the BatteryPlan investment question for Brazil's hourly PLD
market: is this battery worth buying, in which submarket, and under which
business model?

> **Status: implemented.** `src/battery_plan/modelling/` solves §2 to §6, and
> `web/src/finance/` computes §8 in the browser.

---

## 1. Problem statement

A battery sits in **one** of Brazil's four submarkets (SE, S, NE or N), and that
choice is an output of the product. Two separate business cases are valued for
each submarket:

- **Contracted (LRCAP).** The owner sells capacity in the 2026 storage reserve
  auction and receives a fixed revenue, less reimbursements and penalties. The
  ONS dispatches the asset centrally and the result of settling its energy at
  the PLD goes to the CONCAP account (CRCAP 5.1.1(i), 5.6), so the owner earns
  no arbitrage. Arbitrage against the PLD serves here only as a **proxy for the
  ONS dispatch**, to measure cycles, wear and losses.
- **Merchant.** The owner trades the PLD and has no fixed revenue. The contract
  limits do not apply.

The two cases cannot be added together. The clarifications published on
16/11/2026 state that the contract leaves no accessory revenue to share (Leilão
5 item 84, Leilão 6 item 25).

The battery is a **price taker**: its own actions do not move the PLD, so the
price series is an exogenous input. Prices are also taken as
**known**: the whole horizon is given before any decision is made.

The typeset version of this note is
[`battery-dispatch.pdf`](battery-dispatch.pdf).

The problem has two layers. The **dispatch layer** (§2 to §6) is a program on an
hourly axis, solved once per submarket and case: eight solutions. The
**investment layer** (§8) turns each solution into cash flows, and runs in the
browser with no further solve. The market facts and their sources are in
[`mercado-brasileiro.md`](../mercado-brasileiro.md), and the official auction
documents are indexed in
[`leilao-lrcap-2026/README.md`](../leilao-lrcap-2026/README.md).

## 2. Notation

### Sets and indices

| Symbol | Meaning |
| --- | --- |
| $t \in \mathcal{T}$ | hourly settlement period, $t = 1, \dots, T$ |
| $\delta \in \mathcal{D}$ | calendar day, in local time |
| $\mathcal{T}_\delta$ | the 24 hours of day $\delta$, ending at hour $e(\delta)$ |
| $s \in \mathcal{S}$ | submarket: SE, S, NE, N |
| $b \in \{\text{C}, \text{M}\}$ | business case: contracted or merchant |

### Parameters

| Symbol | Default | Unit | Meaning |
| --- | --- | --- | --- |
| $\Delta t$ | 1 | h | length of a settlement period |
| $p_{s,t}$ | data | – | hourly PLD of submarket $s$ in BRL/MWh, above zero |
| $P$ | input | MW | power delivered to the grid, the contracted availability in case C |
| $E$ | $4P/\eta_d$ | MWh | nominal storage volume, before degradation |
| $\overline{C}$ | $P$ | MW | maximum charge rate, on the grid side |
| $\overline{D}$ | $P / \eta_d$ | MW | maximum discharge rate, on the storage side |
| $\eta_c,\ \eta_d$ | $\sqrt{0.85}$ | – | one-way charge and discharge efficiencies |
| $\rho$ | $10^{-5}$ | /cycle | storage volume lost per equivalent full cycle |
| $\overline{L}$ | none | cycles | optional cycle-life budget over the horizon |
| $\kappa$ | $\eta_d E / (4P)$ | – | contractual full cycles per physical full cycle |

The defaults size a battery to the contract: four hours delivered and a
round-trip efficiency of 85%. Charge and discharge are symmetric at $P$ on the
grid side, so a full recharge takes $4 / 0.85 \approx 4.7$ h, inside the six
hours the contract allows. With these
defaults $\kappa = 1$. An oversized battery has $\kappa > 1$, because one
physical cycle then delivers more than one contractual cycle.

### Decision variables

| Symbol | Domain | Unit | Meaning |
| --- | --- | --- | --- |
| $c_t$ | $\geq 0$ | MW | charging power imported from the grid |
| $d_t$ | $\geq 0$ | MW | discharging power drawn from storage |
| $S_t$ | $\geq 0$ | MWh | energy stored at the end of hour $t$ |
| $n_t$ | $\geq 0$ | cycles | physical equivalent full cycles accumulated up to $t$ |
| $z_t$ | binary, case C only | – | 1 when hour $t$ counts as an injection hour |

The two sides are measured at different points. $c_t$ is power **imported from
the grid**, of which $\eta_c c_t$ reaches storage. $d_t$ is power **drawn from
storage**, of which $\eta_d d_t$ reaches the grid. The store is debited the full
$d_t$ in §4.2, and only $\eta_d d_t$ is paid for in §3.

## 3. Objective

For submarket $s$ and case $b$, maximise the value of the energy traded over the
horizon:

$$
\max \; V_{s,b} = \sum_{t \in \mathcal{T}} p_{s,t} \,\bigl(\eta_d\, d_t - c_t\bigr)\, \Delta t
$$

In case M this is the merchant revenue, before the capture factor of §8. In case
C it is **not revenue**: CRCAP 5.6 sends the settlement result to the CONCAP. It
is the criterion that makes the proxy dispatch charge when energy is cheap and
inject when it is scarce.

## 4. Constraints

§4.1 to §4.4, §4.6 and §4.7 apply to both cases. §4.5 applies to case C only.

### 4.1 Storage bounds

Stored energy stays between empty and the effective storage volume, which
shrinks as the battery degrades (§4.7).

$$
0 \leq S_t \leq E\,\bigl(1 - \rho\, n_t\bigr) \qquad \forall t \in \mathcal{T}
$$

### 4.2 Energy balance

Energy stored carries from one hour to the next. Charging is lossy, so only
$\eta_c c_t$ is stored. Discharging debits the store by the full $d_t$, and the
discharge loss is taken in §3.

$$
S_t = S_{t-1} + \Delta t \,\bigl( \eta_c\, c_t - d_t \bigr) \qquad \forall t \in \mathcal{T}, \qquad S_0 = 0
$$

The round-trip efficiency is $\eta_c \eta_d$. At the contract minimum of 0.85, a
price spread of about 18% is needed before a cycle breaks even.

### 4.3 Rate limits

$$
0 \leq c_t \leq \overline{C}, \qquad 0 \leq d_t \leq \overline{D} \qquad \forall t \in \mathcal{T}
$$

No binary keeps charging and discharging apart: §5.1 proves that an optimal plan
never does both in the same hour.

### 4.4 Capacity constraints

Charging is limited by the headroom in the store, and discharging by what the
store holds.

$$
\begin{aligned}
\Delta t\, \eta_c\, c_t &\leq E\,(1 - \rho\, n_t) - S_{t-1} \\
\Delta t\, d_t &\leq S_{t-1}
\end{aligned}
$$

Both follow from §4.1 and §4.2 in any hour that does not charge and discharge
together, which §5.1 shows an optimal plan never does. They state explicitly what
the bounds enforce indirectly, and the implementation may omit them.

### 4.5 Capacity contract obligations

This section applies to **case C only**. The merchant case does not inherit any
of its limits. Clause numbers refer to the CRCAP draft, Annex I of Edital
5/2026 and 6/2026-ANEEL.

| Obligation | Clause | Treatment |
| --- | --- | --- |
| 4 h delivered per full cycle | 5.1.1(ii), Portaria 136 art. 7 IV | Sizing: $E\,\eta_d \geq 4P$ and $\overline{D}\,\eta_d \geq P$ |
| Recharge of the contracted storage within 6 h | 5.1.1(vii), Appendix III | Sizing: $\overline{C}\,\eta_c \geq 4P / (6\,\eta_d)$ |
| Round-trip efficiency of 85% | 8.1, Portaria 136 art. 7 VI | Sizing, and any shortfall feeds the reimbursement of §8 |
| Minimum of 30 MW | Portaria 136 art. 7 III | Warning only: the project does not qualify for the auction |
| At most 2 full cycles a day | 5.1.1(ii) | Row per day |
| At most 366 full cycles per 12 months | 5.1.1(ii), 5.1.2 | Rolling row per hour |
| At most 12 h of injection a day | 5.1.1(iii) | Binary $z_t$ |
| Capacity held for 15 years | 5.2.1, 7.7.1 | Investment layer (§8) |

**Full cycle.** The contract counts cycles on **discharged energy**: the sum of
partial discharges that together equal the contracted power times four hours,
net of losses (Appendix III, CICLO COMPLETO). The energy delivered in hour $t$
is $\eta_d d_t \Delta t$, so the contractual count is the physical count of §4.6
scaled by $\kappa$:

$$
\frac{\eta_d \sum_{\tau \leq t} d_\tau \Delta t}{4P} = \kappa\, n_t
$$

**Daily and yearly cycle limits.** Both are linear in $n_t$:

$$
\begin{aligned}
\kappa\,\bigl(n_{e(\delta)} - n_{e(\delta - 1)}\bigr) &\leq 2 && \forall \delta \in \mathcal{D} \\
\kappa\,\bigl(n_t - n_{t - 8760}\bigr) &\leq 366 && \forall t \geq 8760, \quad n_0 = 0
\end{aligned}
$$

The window is read as **rolling**, the conservative reading. The clause says "a
cada 12 (doze) meses" and the Portaria says "anuais" (art. 4, §3). Bidders asked
which applies, and the published answer defers to the Procedimentos de Rede
without settling it (clarifications of Leilão 5, items 154 and 466). Because
$n_t$ is non-decreasing, the row at $t = 8760$ also covers every earlier hour.

**Twelve hours of injection a day.** CRCAP 5.1.1(iii) lets the ONS dispatch for
more than four hours at reduced power, up to "12 (doze) horas de despacho ao
longo do dia", across all cycles of the day. The count is of **injection** hours
and the recharge is limited separately. A binary per hour states it exactly:

$$
\begin{aligned}
d_t &\leq \overline{D}\, z_t, \quad z_t \in \{0, 1\} && \forall t \in \mathcal{T} \\
\sum_{t \in \mathcal{T}_\delta} z_t &\leq 12 && \forall \delta \in \mathcal{D}
\end{aligned}
$$

Any positive injection in an hour uses that whole hour, which is the conservative
reading at hourly resolution. This row makes case C a mixed-integer program, and
§6 shows when the binaries can be skipped.

### 4.6 Cycle life

One physical equivalent full cycle is the throughput of one nominal storage
volume. A cycle is only completed when the energy is discharged, so the count is
taken on the discharge side alone, at the storage side:

$$
n_t = n_{t-1} + \frac{\Delta t\, d_t}{E} \quad \forall t \in \mathcal{T}, \qquad n_0 = 0
$$

and, when a budget is set, $n_T \leq \overline{L}$.

$n_t$ is left continuous. The nominal $E$ is the denominator rather than the
degraded volume, which keeps the constraint linear.

### 4.7 Storage volume degradation

Each equivalent full cycle costs a fixed fraction $\rho$ of the storage volume:

$$
S^{\max}_t = E\,\bigl(1 - \rho\, n_t\bigr) \qquad \forall t \in \mathcal{T}
$$

This is linear in $n_t$ and is substituted into §4.1 rather than carried as a
variable. Calendar fade does not depend on the dispatch, so it is applied in the
investment layer (§8).

## 5. Assumptions and simplifications

- **Price taker.** Prices are exogenous, in both cases.
- **Prices are known over the whole horizon.** The plan is chosen with
  perfect foresight, so the merchant value is a **ceiling** on what an operator
  could earn rather than a forecast of revenue. §8 applies a capture factor to
  it.
- **Prices are strictly positive.** The PLD has a positive floor, and the loader
  rejects any price at or below zero, in uploads too. §5.1 depends on this.
- **The proxy is not a forecast of the ONS dispatch.** In case C it estimates
  cycles, wear and losses. Whether the ONS would dispatch the asset this way is
  outside the model.
- **The battery starts empty.** $S_0 = 0$, and the final state is free.
- **One connection point.** Losses between the PMI and the substation bus (CRCAP
  8.2) are not separated from $\eta_c$ and $\eta_d$. Auxiliary consumption counts
  as charging energy for the RTE (clarifications of Leilão 5, item 236), so the
  efficiencies entered must include it.
- **Out of scope.** TUST/TUSD, hydrological scenarios, and any revenue beyond
  those of §8.

### 5.1 Why no charge/discharge binary is needed

**Claim.** If $p_t > 0$ and $\eta_c \eta_d < 1$, no optimal plan charges and
discharges in the same hour.

**Proof.** Take a feasible plan with $c_t > 0$ and $d_t > 0$. Let
$\epsilon = \min(c_t,\ d_t / \eta_c) > 0$ and replace

$$
c_t' = c_t - \epsilon, \qquad d_t' = d_t - \eta_c\, \epsilon
$$

The new plan is feasible:

- $\eta_c c_t - d_t$ is unchanged, so $S_\tau$ is the same at every hour.
- The rates fall and stay non-negative, by the choice of $\epsilon$.
- $n_\tau$ falls or stays the same for all $\tau \geq t$, so the bound of §4.1
  loosens. So do the cycle rows of §4.5 and §4.6, since the differences
  $n_{e(\delta)} - n_{e(\delta-1)}$ and $n_\tau - n_{\tau - 8760}$ can only fall
  when the single increment at $t$ falls.
- $z_t$ is unchanged, and $d_t' \leq d_t \leq \overline{D} z_t$.

The objective changes by

$$
p_t \bigl(\eta_d (d_t' - d_t) - (c_t' - c_t)\bigr) \Delta t = p_t\, \epsilon\, \bigl(1 - \eta_c \eta_d\bigr) \Delta t > 0
$$

so the original plan was not optimal. $\blacksquare$

**Zero loss.** With $\eta_c \eta_d = 1$ the change is zero and ties exist. The
same substitution, applied as a netting step after the solve, returns a plan of
equal value with no simultaneous flows.

**Non-positive prices** would break the claim, since being paid to import could
make wheeling energy profitable. They are rejected at the input.

## 6. Solution approach

### Solver

HiGHS, through `pulp`. Each submarket and case is one program over the whole
horizon.

### One program per horizon

The merchant case is a **linear program**. The test case (1 MW delivered, 4 h,
RTE 85%, 0.001%/cycle, 670 days) solves in about 2.3 s and 245 MB through PuLP,
against the solver Lambda's limit of 600 s, at stock HiGHS settings.
A rolling 24+24 h window came within 0.03–0.12% of that value, so it saves
nothing worth its complexity.

### The contracted case: relaxation first

Case C carries the binaries of §4.5, but they rarely matter. The solver first
solves case C **without** $z_t$. That program is a relaxation of the MILP, so
its value is an upper bound.

**If no day of the relaxed solution has more than 12 injection hours, that
solution is optimal for the MILP.** Setting $z_t = 1$ exactly where $d_t > 0$
makes it feasible, and a feasible point that attains an upper bound is optimal.
Branch and bound is then skipped.

Otherwise the MILP is solved. Two full cycles at full power take
$2E/\overline{D}$ hours, so the limit is expected to bind mainly for batteries
of more than 6 h. On the CCEE data it did not bind in any of 28 configurations
from 4 to 24 h, and with the binaries forced on every day the slowest solve took
57.8 s ([`solve.md`](../solve.md#the-12-h-limit)).

### Choosing the submarket

The battery is in one submarket and submarkets do not couple, so solving each
one independently and comparing is **exact**. No location binary is needed. With
$V^\star_b = \max_{s} V_{s,b}$, the **regret** of building in $s$ is

$$
\text{regret}_{s,b} = V^\star_b - V_{s,b} \geq 0
$$

The product solves **eight programs**, four submarkets by two cases.

**The ranking comes from the merchant case.** The fixed revenue is the same in
every submarket, so differences in case C are artefacts of the proxy. For case C
the product reports "no material locational difference".

### How much foresight is enough

A single program sees the whole horizon, including the days an operator would
not yet know. Even a 24+24 h rolling window sees tomorrow while deciding today.
A **24+0 backtest** therefore decides each day without the next one in view. The
ratio between that revenue and the perfect-foresight value defines the **capture
factor** $\phi$ of §8, shown with its sensitivity. At 4 h it is 0.965 to 0.980
depending on the submarket ([`solve.md`](../solve.md#capture-factor-240-backtest)).
It is still an upper bound, since the backtest sees each day's prices in full.

## 7. Results

On the CCEE data, a battery delivering 1 MW for 4 h at the §2 defaults earns a
balanced-year merchant value of BRL 244,503 per MW-year in SE, and BRL 298,920
over the last twelve months, a spread that shows how much the choice of period
moves the answer. Both are perfect-foresight ceilings. The four submarkets and
the solve times are in [`solve.md`](../solve.md#the-eight-programs).

## 8. Investment layer

> Implemented in `web/src/finance/`, and checked against the independent
> reference `scripts/finance_golden_vectors.py`. Every input here runs in the
> browser, needs no solve and is **outside the params hash**.

### 8.1 Inputs

Inputs with a contract source are fixed by it. Every other default is an
**editable assumption** with no market source, and the interface must label it
so.

| Symbol | Meaning | Source |
| --- | --- | --- |
| $RF_0$ | fixed revenue at the May 2026 base (BRL/MW-year) | the bid; ceilings of BRL 1,760,000 (product A) and BRL 1,580,000 (product B), Edital 5/2026 and 6/2026, item 10.5.1 |
| $\pi$ | IPCA (%/year) | editable assumption |
| $r$ | nominal discount rate (hurdle rate or WACC) (%/year) | client input; DI and NTN-B shown as reference only |
| $g$ | real PLD growth (%/year) | editable assumption, default 0% |
| $\phi$ | capture factor of the merchant ceiling | measured by the 24+0 backtest, per submarket and duration; editable |
| $K$ | capex, in BRL of the month the model was run | editable assumption |
| $O_0$ | fixed opex at the May 2026 base (BRL/year) | editable assumption |
| $\theta_R,\ \theta_I$ | tax rates on revenue and on income | editable assumptions |
| $N_D$ | straight-line tax depreciation life (years) | editable assumption |
| $\gamma$ | calendar fade (%/year) | editable assumption |
| $x_R$ | cost of renewing the whole volume, as a share of the capex paid, $K_0$ | editable assumption |
| $\Pi_k$ | penalty allowance in contract year $k$ (BRL) | editable assumption, default 0 |

Edital item 11.8.2.6.2 uses BRL 6,000,000 per MW as the base of the consortium
net-worth test (10% of it, BRL 600,000 per MW, per the clarifications of Leilão
5, item 20). The documents do not name it an investment reference. It may be
offered as a **starting point for $K$**, labelled as an assumption.

### 8.2 Timeline and indexation

Contract years $k = 1, \dots, 15$ run from August to July. Supply starts on
1 August 2028 for both products, with a 15-year term (Portaria 136, art. 9,
paragraphs 2 and 3). The fixed revenue is referenced to **May 2026** and adjusted each August by
the IPCA of the preceding July (CRCAP 7.2, 7.3). Year $k$ is therefore

$$
a_k = \frac{26}{12} + (k - 1)
$$

years after the base date, 26 months being May 2026 to July 2028. The fixed
revenue, opex and PLD use this same exponent, so products A and B and both
business cases share one base date. The capex $K$ is priced in the month the
model was run. With $b$ the years from that month to August 2028 (zero if it
has passed), the nominal payment at $k = 0$ is $K_0 = K(1 + \pi)^b$, and §8.4
indexes reinvestment from that date. Cash flows are nominal, at year end, and discounted to
$k = 0$ by the nominal rate $r$. The equivalent real rate, shown for reference
and not used to discount, is

$$
r_{\text{real}} = \frac{1 + r}{1 + \pi} - 1
$$

### 8.3 Base revenue from the dispatch

The solver sees 670 days. 305 calendar days occur in both 2025 and 2026 and 60
in only one of them, so a plain sum would overweight part of the year. The
annual base gives **each calendar month the same weight**. With $v_\delta$ the
value of day $\delta$ restated to the May 2026 base by the IPCA index $I$,
$\mathcal{D}_m$ the days observed in calendar month $m$, and $D_m$ its days in a
365-day year,

$$
R_{\text{base}} = \sum_{m=1}^{12} \frac{D_m}{\lvert \mathcal{D}_m \rvert} \sum_{\delta \in \mathcal{D}_m} v_\delta,
\qquad
v_\delta = \frac{I_{\text{May 2026}}}{I_{m(\delta)}} \sum_{t \in \mathcal{T}_\delta} p_{s,t}\,(\eta_d d_t - c_t)\,\Delta t
$$

The dispatch itself is solved on nominal PLD. Restating the daily values
afterwards is an approximation that keeps the macro inputs out of the solver.
The last twelve months are shown as a sensitivity.

### 8.4 Capacity, fade and replacement

With $\nu$ physical cycles a year, the usable fraction of the nominal volume
falls each year by

$$
y = (1 - \gamma)(1 - \rho\,\nu), \qquad h_1 = 1
$$

If $s_k$ is the share of $E$ bought in year $k$, its cost is

$$
\text{Repl}_k = x_R\, s_k\, K_0\, (1 + \pi)^{k - 1}
$$

$K_0$ is the price at $k = 0$, so the index runs from there: $a_k - a_1 = k - 1$.

In **case C** the contracted capacity must be held throughout (CRCAP 5.2.1). The
contract anticipates reinvestment to swap or **add** storage modules, and does
not revise the fixed revenue for it (7.7.1). The case therefore adds only what
fade removed. With $\underline{h} = 4P / (E\,\eta_d)$ the share of $E$ that
delivers the contracted 4 h,

$$
s_k = \max\bigl(0,\ \underline{h} - y\, h_{k-1}\bigr), \qquad h_k = y\, h_{k-1} + s_k \qquad (k \geq 2)
$$

Added modules are taken to fade with the rest of the store, and their cost to
scale with the energy added. Both are simplifications: there is no fixed
mobilisation cost, and $x_R$ is an editable assumption.

In **case M** the schedule is an input. A replacement renews the whole volume,
so $s_k = 1$ and $h_k = 1$ in a scheduled year and $h_k = y\,h_{k-1}$ otherwise,
and revenue scales with $h_k$.

### 8.5 Cash flows

**Contracted.** Fixed revenue, indexed by IPCA, less what the contract charges:

$$
\begin{aligned}
\text{Rev}^{\text{C}}_k ={}& RF_0\, P\, (1 + \pi)^{a_k} \\
&- \text{Ress}_{\text{base}}\, \bigl[(1 + g)(1 + \pi)\bigr]^{a_k} - \Pi_k
\end{aligned}
$$

The PLD settlement of the dispatch does not appear, since it belongs to the
CONCAP (CRCAP 5.6). $\text{Ress}_{\text{base}}$ is the balanced-year sum, as in
§8.3, of the monthly reimbursement of CRCAP 8.1:

$$
\text{Ress}_m = \max\!\left(0,\ E^{\text{rec}}_m - \frac{S_{\text{end}(m)} + E^{\text{inj}}_m - S_{\text{end}(m-1)}}{0.85}\right) \frac{\text{Cost}_m}{E^{\text{rec}}_m}
$$

where $E^{\text{rec}}_m = \sum c_t \Delta t$ is the charging energy,
$E^{\text{inj}}_m = \sum \eta_d d_t \Delta t$ the injected energy and
$\text{Cost}_m = \sum p_t c_t \Delta t$ the charging cost, over the hours of month
$m$. The term is zero in a month with no charging, and in a month with fewer than
four injections (8.1.3).

An efficiency of 85% does **not** make this term vanish in every month. The
stock is measured inside the store and the injection after the discharge loss,
so energy carried in from the previous month reduces the month's allowance by
its discharge loss. A month that ends with less stored than it began can
therefore owe a small amount, which the floor at zero keeps later months from
returning.

**Merchant.** The perfect-foresight value, scaled by the capture factor, the
real PLD growth, the IPCA and the remaining capacity:

$$
\text{Rev}^{\text{M}}_k = \phi\, R_{\text{base}}\, h_k\, \bigl[(1 + g)(1 + \pi)\bigr]^{a_k}
$$

**Common to both.** Opex is $O_k = O_0 (1 + \pi)^{a_k}$. Depreciation $\text{Dep}_k$
is straight-line over $N_D$ years on the amounts actually paid for $K_0$ and for
each replacement, **not corrected by $\pi$**. With taxable income
$B_k = (1 - \theta_R)\,\text{Rev}_k - O_k - \text{Dep}_k$ and a loss balance
$\ell_k$ carried forward,

$$
\begin{aligned}
\text{Tax}_k &= \theta_I \max\bigl(0,\ B_k - \ell_{k-1}\bigr) \\
\ell_k &= \max\bigl(0,\ \ell_{k-1} - B_k\bigr), \qquad \ell_0 = 0 \\
CF_k &= (1 - \theta_R)\,\text{Rev}_k - O_k - \text{Tax}_k - \text{Repl}_k
\end{aligned}
$$

Statutory limits on offsetting losses are not modelled.

### 8.6 Investment metrics

$$
\text{NPV}(r) = -K_0 + \sum_{k=1}^{15} \frac{CF_k}{(1 + r)^k}
$$

- **IRR:** the rate with $\text{NPV} = 0$. It is reported as `null` unless there
  is exactly one root above $-100\%$, since replacements can change the sign of
  the flows more than once.
- **Payback:** the first year in which cumulative $CF_k$ reaches $K_0$, both plain
  and discounted at $r$. It is `null` if that never happens.
- **Maximum viable capex:** the $K$, in BRL of the run month, with
  $\text{NPV} = 0$, holding the other inputs. NPV falls as $K$ rises for $r \geq 0$, because the depreciation shield
  returns less than each BRL spent, so a bracketed root search finds it.
- **Minimum viable bid (case C):** the $RF_0$ with $\text{NPV}^{\text{C}} = 0$,
  in BRL/MW-year at the May 2026 base. NPV rises with $RF_0$. The result is
  compared with the opening price of the product (item 10.5.1), and a value above
  it means the project cannot win at that price.

### 8.7 What the contract adds at the edges

These terms are not in the base flows and are surfaced as risks: the delay
penalty (CRCAP 6.8), the dispatch deviation penalties at 1.15 times the unit fixed
revenue (9.2, 9.3), the declared availability penalty at 1.1 times (9.4), scheduled
unavailability above 2.5% a year (5.7.3), and the termination fine of three times
the annual fixed revenue (13.1).

---

## Reading and rendering this document

It renders as-is on GitHub, which needs no toolchain. To render it locally:

```bash
make preview   # render to HTML and open in the browser
make html      # re-render after an edit, then refresh the page
make pdf       # export a LaTeX article, docs/model/model.pdf
```

`preview` and `html` need `pandoc`; the PDF target also needs `tectonic`. The
tracked `docs/model/battery-dispatch.pdf` is a copy of `model.pdf`. They typeset
the note as a LaTeX article through `docs/model/latex/`: a preamble, a metadata
file per document, and a Lua filter that drops the title heading, the `---`
rules and the hand-written section numbers, which LaTeX then assigns itself in
the same order, so the `§4.2` references in the prose still hold. The HTML uses
MathJax, the same engine GitHub uses, so the local preview and the rendered
repository agree. The equations are written to the intersection of the two:
`$$` and `$` delimiters, `aligned` rather than `align`, and no cross-references.
