import { DownloadSimple, FileCsv, SignIn, WarningCircle, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import templateUrl from "../../../contracts/examples/pld-template.csv?url";
import { useAuth } from "../auth/AuthProvider";
import type { Me } from "../contracts/types";
import { api, ApiError, describeError, uploadToPresigned } from "../lib/api";
import { day, num, pct } from "../lib/format";
import { sha256Hex } from "../lib/sha256";
import {
  automaticRates,
  BATTERY_FIELDS,
  BUNDLED_END,
  BUNDLED_START,
  buildRequest,
  contractWarnings,
  CYCLE_BUDGET_FIELD,
  defaultValues,
  MAX_SPAN_DAYS,
  MAX_UPLOAD_BYTES,
  MIN_SPAN_DAYS,
  inspectPriceCsv,
  physicalBattery,
  roundTrip,
  spanDays,
  validate,
  type FieldSpec,
  type FormErrors,
  type FormValues,
  type PriceFileInfo,
} from "../lib/validation";

/** The form survives a sign-in redirect and an "edit and retry" in sessionStorage. */
export const DRAFT_KEY = "batteryplan:draft";

function readDraft(): FormValues {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) {
      const draft = JSON.parse(raw) as FormValues;
      const base = defaultValues();
      // A draft saved before the move to the PLD has none of these fields or dates.
      if (typeof draft.battery?.duration_hours !== "string") return base;
      return { ...base, ...draft, battery: { ...base.battery, ...draft.battery } };
    }
  } catch {
    // ignore a broken draft
  }
  return defaultValues();
}

function saveDraft(values: FormValues) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(values));
  } catch {
    // storage may be unavailable; the form still works
  }
}

const plain = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 6 });
function bounds(field: FieldSpec): string {
  return `${plain(field.min)} and ${plain(field.max)}`;
}

/** Where the schema's description is written for API clients, the form says it its own way. */
const HELP: Record<string, string> = {
  cycle_budget: "Equivalent full cycles the run may spend over the horizon. Leave empty for no budget.",
};

interface NumberFieldProps {
  field: FieldSpec;
  name: string;
  value: string;
  error?: string;
  optional?: boolean;
  help?: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

function NumberField({ field, name, value, error, optional, help, placeholder, onChange }: NumberFieldProps) {
  const id = `f-${name}`;
  return (
    <div className="field">
      <label htmlFor={id}>
        <span>
          {field.label}
          {optional ? <span style={{ color: "var(--muted)", fontWeight: 400 }}> (optional)</span> : null}
        </span>
        <span className="unit">{field.unit}</span>
      </label>
      <input
        id={id}
        name={name}
        type="text"
        inputMode={field.integer ? "numeric" : "decimal"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder ?? (optional ? "no budget" : undefined)}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? (
        <span className="error-text" id={`${id}-help`}>
          {error}
        </span>
      ) : (
        <span className="help" id={`${id}-help`}>
          {help ?? HELP[field.key] ?? field.description} Between {bounds(field)}.
        </span>
      )}
    </div>
  );
}

type Phase = "idle" | "hashing" | "uploading" | "sending";
const PHASE_LABEL: Record<Phase, string> = {
  idle: "Run the plan",
  hashing: "Reading the file",
  uploading: "Uploading prices",
  sending: "Queueing the run",
};

export function Run() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [values, setValues] = useState<FormValues>(readDraft);
  const [touched, setTouched] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileInfo, setFileInfo] = useState<PriceFileInfo | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<{ title: string; detail: string } | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const errors: FormErrors = useMemo(() => validate(values, fileInfo), [values, fileInfo]);
  const shown = touched ? errors : {};
  const valid = Object.keys(errors).length === 0;
  const rt = roundTrip(values);
  const span = spanDays(values);

  useEffect(() => saveDraft(values), [values]);

  const { token, dropSession } = auth;
  const refreshMe = useCallback(async () => {
    if (!token) return;
    try {
      setMe(await api.me(token));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) dropSession();
    }
  }, [token, dropSession]);
  useEffect(() => {
    let live = true;
    if (token) {
      api
        .me(token)
        .then((next) => live && setMe(next))
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 401) dropSession();
        });
    }
    return () => {
      live = false;
    };
  }, [token, dropSession]);
  const quota = token ? me : null;

  const setBattery = (key: string, value: string) =>
    setValues((v) => ({ ...v, battery: { ...v.battery, [key]: value } }));

  async function chooseFile(next: File | null) {
    setFile(next);
    setFailure(null);
    if (!next) {
      setFileInfo(null);
      return;
    }
    const data = next.size <= MAX_UPLOAD_BYTES ? new Uint8Array(await next.arrayBuffer()) : new Uint8Array();
    setFileInfo(inspectPriceCsv(next.name, next.size, data));
    setTouched(true);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) void chooseFile(dropped);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    setFailure(null);
    if (!valid) {
      const first = document.querySelector<HTMLInputElement>("[aria-invalid='true']");
      first?.focus();
      return;
    }
    if (!auth.token) {
      saveDraft(values);
      auth.signIn("/run");
      return;
    }
    try {
      let pricesKey: string | undefined;
      if (file) {
        setPhase("hashing");
        const bytes = await file.arrayBuffer();
        const digest = await sha256Hex(bytes);
        setPhase("uploading");
        const ticket = await api.createUpload(auth.token, digest, file.size);
        await uploadToPresigned(ticket, new Blob([bytes], { type: "text/csv" }), file.name);
        pricesKey = ticket.prices_key;
      }
      setPhase("sending");
      const created = await api.createRun(auth.token, buildRequest(values, pricesKey));
      navigate(`/runs/${encodeURIComponent(created.run_id)}`, { state: { cached: created.cached } });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) auth.dropSession();
      setFailure(describeError(error));
      void refreshMe();
    } finally {
      setPhase("idle");
    }
  }

  function onChangeDate(key: "start" | "end") {
    return (e: ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [key]: e.target.value }));
  }

  const dateMin = fileInfo?.firstDay && !fileInfo.problem ? fileInfo.firstDay : BUNDLED_START;
  const dateMax = fileInfo?.lastDay && !fileInfo.problem ? fileInfo.lastDay : BUNDLED_END;
  const busy = phase !== "idle";
  const warnings = contractWarnings(values);
  const sized = errors["battery.power_mw"] || errors["battery.duration_hours"] || errors["battery.round_trip_efficiency"] || errors["battery.charge_rate_mw"] || errors["battery.discharge_rate_mw"] ? null : physicalBattery(values);
  const automatic = automaticRates(values);
  const automaticMw = (key: string) => (key === "charge_rate_mw" ? automatic?.chargeMw : key === "discharge_rate_mw" ? automatic?.dischargeMw : undefined);

  return (
    <div className="page">
      <div className="wrap">
        <div className="page-head">
          <h1>Run your own battery</h1>
          <p>
            Change the battery, pick at least a year of the bundled CCEE prices or upload your own PLD, and the solver plans every hour of the four submarkets, contracted and
            merchant. Its progress shows live while it works. Financial inputs come afterwards, on the results page, and need no new run.
          </p>
        </div>

        <form className="run-layout" onSubmit={onSubmit} noValidate>
          <div>
            <fieldset className="group">
              <legend>The battery</legend>
              <p className="group-note">Defaults are the smallest battery the auction accepts: 30 MW, 4 h delivered, 85% round trip, charging and discharging at 30 MW.</p>
              <div className="fields">
                {BATTERY_FIELDS.map((field) => {
                  const auto = automaticMw(field.key);
                  return (
                    <NumberField
                      key={field.key}
                      field={auto === undefined ? field : { ...field, max: Math.min(field.max, auto) }}
                      name={field.key}
                      value={values.battery[field.key as keyof FormValues["battery"]]}
                      error={shown[`battery.${field.key}`]}
                      optional={field.optional}
                      placeholder={field.optional ? (auto === undefined ? "automatic" : `automatic: ${num(auto, 2)}`) : undefined}
                      help={field.optional ? `${field.description} Empty follows the battery.` : undefined}
                      onChange={(v) => setBattery(field.key, v)}
                    />
                  );
                })}
              </div>
              <p className="derived">
                {rt ? (
                  <>
                    Round trip <span className="num">{pct(rt.efficiency, 2)}</span>: a sale must beat its purchase by{" "}
                    <span className="num">{pct(rt.markup, 2)}</span> to pay.
                  </>
                ) : (
                  "Enter the efficiency to see the round trip."
                )}
                {sized ? (
                  <>
                    {" "}
                    Nominal volume <span className="num">{num(sized.volume_mwh, 1)} MWh</span>, charging at up to <span className="num">{num(sized.max_charge_mw, 2)} MW</span> and discharging at up to{" "}
                    <span className="num">{num(sized.max_discharge_mw * sized.discharge_efficiency, 2)} MW</span>. A full recharge takes{" "}
                    <span className="num">{num(sized.volume_mwh / (sized.charge_efficiency * sized.max_charge_mw), 2)} h</span>.
                  </>
                ) : null}
              </p>
              {warnings.map((warning) => (
                <p className="help" key={warning}>
                  {warning} The merchant case still runs.
                </p>
              ))}
            </fieldset>

            <fieldset className="group">
              <legend>Horizon and planning</legend>
              <p className="group-note">
                One program over the whole horizon, per submarket and case (<Link to="/methodology#one-program-per-horizon">why</Link>). Between {MIN_SPAN_DAYS + 1} and {MAX_SPAN_DAYS + 1} days, so every calendar month is seen.
              </p>
              <div className="fields">
                <div className="field">
                  <label htmlFor="f-start">
                    <span>Start</span>
                    <span className="unit">date</span>
                  </label>
                  <input id="f-start" type="date" value={values.start} min={dateMin} max={dateMax} onChange={onChangeDate("start")} aria-invalid={shown.start ? true : undefined} />
                  {shown.start ? <span className="error-text">{shown.start}</span> : <span className="help">From {day(dateMin)}.</span>}
                </div>
                <div className="field">
                  <label htmlFor="f-end">
                    <span>End</span>
                    <span className="unit">date, inclusive</span>
                  </label>
                  <input id="f-end" type="date" value={values.end} min={dateMin} max={dateMax} onChange={onChangeDate("end")} aria-invalid={shown.end ? true : undefined} />
                  {shown.end ? <span className="error-text">{shown.end}</span> : <span className="help">{span ? `${num(span)} days.` : `Up to ${day(dateMax)}.`}</span>}
                </div>
                <NumberField
                  field={CYCLE_BUDGET_FIELD}
                  name="cycle_budget"
                  value={values.cycle_budget}
                  error={shown.cycle_budget}
                  optional
                  onChange={(v) => setValues((s) => ({ ...s, cycle_budget: v }))}
                />
              </div>
            </fieldset>

            <fieldset className="group">
              <legend>Prices</legend>
              <p className="group-note">
                Leave this empty to use the bundled CCEE prices. Your own file must have the header <code>hora,submercado,pld</code>, local time, one row per hour and
                submarket in BRL/MWh, all above zero, and be at most 5 MB. The template shows the format with two days.
              </p>
              <div
                className={`drop${dragging ? " dragging" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <div className="drop-row">
                  {file ? (
                    <span className="file-chip">
                      <FileCsv size={16} aria-hidden="true" />
                      {file.name}
                      <button
                        type="button"
                        className="btn-quiet"
                        style={{ border: 0, background: "none", cursor: "pointer", padding: 0, color: "inherit", display: "inline-flex" }}
                        aria-label="Remove the file"
                        onClick={() => {
                          void chooseFile(null);
                          if (fileInput.current) fileInput.current.value = "";
                        }}
                      >
                        <X size={14} />
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileInput.current?.click()}>
                      <FileCsv size={16} aria-hidden="true" /> Choose a CSV
                    </button>
                  )}
                  <a className="btn btn-quiet" href={templateUrl} download="pld-template.csv">
                    <DownloadSimple size={16} aria-hidden="true" /> Template
                  </a>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,text/csv"
                  className="visually-hidden"
                  aria-label="Price file"
                  tabIndex={-1}
                  onChange={(e) => void chooseFile(e.target.files?.[0] ?? null)}
                />
                {fileInfo?.problem ? (
                  <span className="error-text" role="alert">
                    {fileInfo.problem}
                  </span>
                ) : fileInfo ? (
                  <span className="help">
                    {num(fileInfo.size / 1024, 0)} KB, from {day(fileInfo.firstDay)} to {day(fileInfo.lastDay)}. The solver checks it again when the run starts.
                  </span>
                ) : (
                  <span className="help">Or drop a file here.</span>
                )}
              </div>
            </fieldset>
          </div>

          <aside className="aside">
            <div className="aside-panel">
              <div className="summary">
                <span>
                  <span className="num">{span ? num(span) : "?"}</span> days, <span className="num">{span ? num(span * 24) : "?"}</span> hours
                </span>
                <span>{file ? `Prices from ${file.name}` : "Bundled CCEE PLD, 2025 to 2026"}</span>
              </div>
              {failure ? (
                <div className="banner error" role="alert">
                  <WarningCircle size={18} aria-hidden="true" />
                  <span>
                    <span className="banner-title">{failure.title}.</span> {failure.detail}
                  </span>
                </div>
              ) : null}
              {touched && !valid ? <span className="error-text">Fix the highlighted fields to run.</span> : null}
              {auth.account ? (
                <>
                  <button type="submit" className="btn btn-primary" disabled={busy}>
                    {PHASE_LABEL[phase]}
                  </button>
                  <p className="quota">
                    {quota ? (
                      <>
                        <strong>{quota.quota.remaining}</strong> of {quota.quota.limit} runs left today. Repeats are free.
                      </>
                    ) : (
                      "Checking today's runs."
                    )}
                  </p>
                </>
              ) : (
                <>
                  <button type="submit" className="btn btn-primary">
                    <SignIn size={16} weight="bold" aria-hidden="true" /> Sign in to run
                  </button>
                  <p className="quota">With Google. Three runs a day per account; the form keeps what you typed.</p>
                </>
              )}
            </div>
          </aside>
        </form>
      </div>
    </div>
  );
}
