import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Result } from "../contracts/types";
import { Chart } from "./Chart";
import type { ChartOption } from "./echarts";
import { usePalette, type Palette } from "./theme";

/** Mounts its children once they come near the viewport: a full payload is twenty charts. */
function useNearViewport(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near || !ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near];
}

interface FigureProps {
  title: ReactNode;
  note?: ReactNode;
  result: Result;
  build: (result: Result, palette: Palette) => ChartOption;
  height: number;
  /** Text for screen readers. */
  label: string;
  /** When false, the figure says why instead of drawing an empty chart. */
  available?: boolean;
  empty?: string;
  controls?: ReactNode;
  className?: string;
}

export function Figure({ title, note, result, build, height, label, available = true, empty, controls, className }: FigureProps) {
  const palette = usePalette();
  const [ref, near] = useNearViewport();
  const option = useMemo(() => (available && near ? build(result, palette) : null), [available, near, build, result, palette]);
  return (
    <figure className={`fig ${className ?? ""}`} style={{ margin: 0 }}>
      <div className="fig-head">
        <div>
          <h3>{title}</h3>
          {note ? <p className="fig-note">{note}</p> : null}
        </div>
        {controls}
      </div>
      <div ref={ref}>
        {!available ? (
          <div className="fig-empty" style={{ height: Math.min(height, 160) }}>
            {empty ?? "Nothing to draw for this run."}
          </div>
        ) : option ? (
          <Chart option={option} height={height} label={label} />
        ) : (
          <div className="chart-placeholder" style={{ height }} aria-hidden="true" />
        )}
      </div>
    </figure>
  );
}
