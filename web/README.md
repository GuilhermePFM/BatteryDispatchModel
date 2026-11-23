# BatteryPlan web

The site: React 19 + Vite + TypeScript, pnpm, react-router, ECharts, KaTeX, oidc-client-ts.

```sh
mise exec -- pnpm install
mise exec -- pnpm dev        # http://localhost:5173, /api proxied to http://localhost:8080
mise exec -- pnpm dev:mock   # no backend: a fetch shim plays the API in the tab
mise exec -- pnpm test       # vitest: validation, methodology filter, chart adapters
mise exec -- pnpm lint       # eslint + tsc
mise exec -- pnpm build      # dist/
```

The build reads files outside `web/`: the JSON Schemas under `../contracts` (form bounds and
defaults), `../contracts/examples/pld-template.csv` and `../docs/model/model.md` with its
figures. Build from a full checkout.

The site answers the investment question in BRL: submarket ranking, Contracted × Merchant and instant sensitivity. `src/finance/` implements §8 of [`model.md`](../docs/model/model.md) in the browser, so a change of capex, IPCA, nominal discount rate or real PLD growth needs no new run and no sign-in. Its tests run against `src/finance/golden-vectors.json`, written by the independent reference `scripts/finance_golden_vectors.py`.

## Pages

| Route | What |
| --- | --- |
| `/` | Intro and the precomputed PLD dashboard with the investment layer, from `public/scenarios/pld-2025-2026.json` (a v2 result, written by `scripts/build_scenario_v2.py`). In dev, a missing file falls back to the contract example with a banner. |
| `/run` | The run form. Sign-in required to send; the draft survives the redirect in sessionStorage. |
| `/runs/:id` | Polls every 3 s while queued or running; the dashboard and the plan CSV once succeeded. A run of an earlier model is flagged and offers a new run. |
| `/methodology` | `docs/model/model.md` §1 to §6 and §8, filtered by `src/methodology/extract.ts` and rendered with KaTeX. |
| `/privacy` | Privacy notice. |

## Configuration

| Variable | |
| --- | --- |
| `VITE_AUTH_MODE` | `cognito` or `dev` (default). Dev asks for a name and email and sends `Bearer dev:<sub>:<email>`. Either way the bearer goes in `X-Authorization` (CloudFront's OAC overwrites `Authorization`), and every request with a body carries `x-amz-content-sha256`. |
| `VITE_COGNITO_AUTHORITY` | `https://cognito-idp.<region>.amazonaws.com/<pool id>` |
| `VITE_COGNITO_CLIENT_ID` | App client id (public client, PKCE). |
| `VITE_COGNITO_DOMAIN` | Managed login domain, for logout. |
| `VITE_API_MOCK` | `1` to install the mock API (forces dev auth). |
| `VITE_SCENARIO_URL` | Override the scenario file URL. |
| `VITE_REPO_URL` | Base for links to repository documents. |

Redirect URIs come from the page's origin: register `<origin>/auth/callback` as the callback and
`<origin>/` as the sign-out URL. The ID token is kept in memory only, so a reload signs out.

## Mock mode

Runs queue for 2.5 s, then take 5 s per pass (four passes with a cycle budget, one without).
Three runs a day per account, repeats come back `cached`, and a run with an uploaded file fails
with `prices_invalid`. To force an API error on the next `POST /api/runs`:

```js
sessionStorage.setItem("mock:force", "global_cap") // or rate_limited, unavailable, request_invalid
```
