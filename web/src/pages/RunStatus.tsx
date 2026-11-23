import { ArrowCounterClockwise, Check, DownloadSimple, LinkSimple, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { isCurrentRecord, type Progress, type RunRecord } from "../contracts/types";
import { Dashboard } from "../dashboard/Dashboard";
import { api, ApiError, describeError } from "../lib/api";
import { day, duration, num, pct } from "../lib/format";
import { valuesFromRequest } from "../lib/validation";
import { DRAFT_KEY } from "./Run";

const POLL_MS = 3000;

function phaseLabel(progress: Progress | undefined, status: RunRecord["status"]): string {
  if (status === "queued") return "Waiting for a solver";
  if (!progress) return "Starting";
  if (progress.phase === "done") return "Writing the results";
  return progress.submarket && progress.case ? `Solving ${progress.submarket}, ${progress.case}` : "Solving";
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v" style={{ fontSize: "1.1rem" }}>
        {v}
      </div>
    </div>
  );
}

function ProgressPanel({ record }: { record: RunRecord }) {
  const p = record.progress;
  const queued = record.status === "queued";
  const fraction = p ? Math.max(0, Math.min(1, p.fraction)) : 0;
  return (
    <>
      <div
        className={`progress${queued || !p ? " indeterminate" : ""}`}
        role="progressbar"
        aria-label="Run progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={queued || !p ? undefined : Math.round(fraction * 100)}
      >
        <span style={{ width: `${fraction * 100}%` }} />
      </div>
      <div className="progress-facts">
        <Fact k="Done" v={queued || !p ? "n/a" : pct(fraction, 0)} />
        <Fact k="Programs" v={p ? `${p.cases_done} of ${p.cases_total}` : "n/a"} />
        <Fact k="In flight" v={p?.submarket && p.case ? `${p.submarket}, ${p.case}` : "n/a"} />
        <Fact k="Elapsed" v={p ? duration(p.elapsed) : "n/a"} />
      </div>
      <p className="help">
        Each submarket is solved twice, as a merchant asset and under the capacity contract. A battery that cannot meet the contract runs the four merchant programs only.
      </p>
    </>
  );
}

function RequestSummary({ record }: { record: RunRecord }) {
  const r = record.request;
  const b = r.battery;
  return (
    <p className="dash-meta">
      {day(r.start)} to {day(r.end)}. {num(b.power_mw, 1)} MW, {num(b.volume_mwh, 1)} MWh,{" "}
      {r.cycle_budget !== undefined ? `${num(r.cycle_budget)} cycle budget, ` : ""}
      {r.prices_key ? "uploaded prices" : "bundled prices"}.
    </p>
  );
}

/** Keyed by id, so moving to another run starts from a clean state. */
export function RunStatus() {
  const { id = "" } = useParams();
  return <RunStatusView key={id} id={id} />;
}

function RunStatusView({ id }: { id: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const cached = (location.state as { cached?: boolean } | null)?.cached ?? false;
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [failure, setFailure] = useState<{ title: string; detail: string; notFound: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    let misses = 0;
    async function poll() {
      try {
        const next = await api.getRun(id);
        if (!live) return;
        misses = 0;
        setRecord(next);
        setFailure(null);
        if (next.status === "queued" || next.status === "running") timer = window.setTimeout(poll, POLL_MS);
      } catch (error) {
        if (!live) return;
        const notFound = error instanceof ApiError && error.status === 404;
        // A dropped poll is retried quietly a few times before it is shown.
        misses += 1;
        if (notFound || misses >= 3) setFailure({ ...describeError(error), notFound });
        if (!notFound) timer = window.setTimeout(poll, POLL_MS * Math.min(4, misses));
      }
    }
    void poll();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [id]);

  function editAndRetry() {
    if (!record) return;
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(valuesFromRequest(record.request)));
    } catch {
      // ignore
    }
    navigate("/run");
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  const stale = record !== null && !isCurrentRecord(record);
  const status = stale ? undefined : record?.status;
  const result = stale ? undefined : record?.result;

  return (
    <div className="page">
      <div className="wrap">
        <div className="page-head">
          <h1>{stale ? "An older run" : status === "succeeded" ? "Your plan" : status === "failed" ? "The run failed" : "Planning your battery"}</h1>
          {record && !stale ? <RequestSummary record={record} /> : null}
        </div>

        {stale ? (
          <div className="status-panel">
            <div className="banner" role="status">
              <WarningCircle size={18} aria-hidden="true" />
              <span>
                <span className="banner-title">This run predates the current model.</span> It was solved for another market, so its result cannot be shown here. Start a new run with the hourly PLD.
              </span>
            </div>
            <div className="actions">
              <Link className="btn btn-primary" to="/run">
                Start a run
              </Link>
            </div>
          </div>
        ) : failure && !record ? (
          <div className="status-panel">
            <div className="banner error" role="alert">
              <WarningCircle size={18} aria-hidden="true" />
              <span>
                <span className="banner-title">{failure.title}.</span> {failure.detail}
              </span>
            </div>
            <div className="actions">
              <Link className="btn btn-primary" to="/run">
                Start a run
              </Link>
            </div>
          </div>
        ) : !record ? (
          <div className="status-panel">
            {/* Nothing to show until the first poll answers. */}
            <div className="progress indeterminate">
              <span />
            </div>
          </div>
        ) : status === "queued" || status === "running" ? (
          <div className="status-panel" aria-live="polite">
            <div className="status-line">
              <span className="status-badge" data-status={status}>
                {status}
              </span>
              {phaseLabel(record.progress, record.status)}
            </div>
            <ProgressPanel record={record} />
            {failure ? <p className="help">Lost touch with the server; still trying.</p> : null}
            <p className="help">You can leave this page: the run carries on, and this link shows it whenever you come back.</p>
          </div>
        ) : status === "failed" ? (
          <div className="status-panel">
            <div className="status-line">
              <span className="status-badge" data-status="failed">
                failed
              </span>
              {record.error?.code === "prices_invalid" ? "The price file was rejected" : record.error?.code === "request_invalid" ? "The request was rejected" : "The solver could not finish"}
            </div>
            <div className="error-message">{record.error?.message ?? "No reason was recorded."}</div>
            <p className="help">A failed run is not counted against your daily runs.</p>
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={editAndRetry}>
                <ArrowCounterClockwise size={16} aria-hidden="true" /> Edit and retry
              </button>
            </div>
          </div>
        ) : null}

        {status === "succeeded" ? (
          <>
            <div className="actions" style={{ marginTop: 24 }}>
              {record?.plan_csv_url ? (
                <a className="btn btn-primary" href={record.plan_csv_url} download="dispatch_plan.csv">
                  <DownloadSimple size={16} weight="bold" aria-hidden="true" /> Download the plan
                </a>
              ) : null}
              <button type="button" className="btn btn-secondary" onClick={copyLink}>
                {copied ? <Check size={16} aria-hidden="true" /> : <LinkSimple size={16} aria-hidden="true" />} {copied ? "Copied" : "Copy link"}
              </button>
              <button type="button" className="btn btn-quiet" onClick={editAndRetry}>
                Change and run again
              </button>
              {cached ? <span className="help">Answered from an earlier identical run: not counted.</span> : null}
            </div>
            <div className="dashboard" style={{ paddingTop: 0 }}>
              {result ? (
                <div style={{ marginTop: 28 }}>
                  <Dashboard result={result} runMonth={record?.created_at.slice(0, 7)} />
                </div>
              ) : (
                <div className="banner error" style={{ marginTop: 24 }}>
                  <WarningCircle size={18} aria-hidden="true" />
                  <span>The run succeeded but its result is missing from the record.</span>
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
