// One ECharts option per figure of a run's dashboard, built
// from the result payload alone. Pure functions of (result, palette), so they
// are tested with nulls and with a payload of a few days.
import type { Result } from "../contracts/types";
import { day, gbp, gbpShort, hourLabel, monthLabel, num, pct, quarterLabel } from "../lib/format";
import {
  bandHeight,
  breakeven,
  cumulative,
  heatCells,
  histogram,
  histogramBars,
  isNum,
  linearFit,
  mean,
  negate,
  normaliseToFirst,
  pairs,
  quantile,
  scatter,
  type Value,
} from "./adapters";
import type { ChartOption } from "./echarts";
import type { Palette } from "./theme";

type Fmt = (v: unknown) => string;
const money: Fmt = (v) => (isNum(v) ? gbp(v) : "n/a");
const price: Fmt = (v) => (isNum(v) ? `£${num(v, 2)}/MWh` : "n/a");
const mw: Fmt = (v) => (isNum(v) ? `${num(v, 2)} MW` : "n/a");

function base(p: Palette, grid: Record<string, unknown> = {}) {
  return {
    backgroundColor: "transparent",
    animationDuration: 500,
    textStyle: { fontFamily: p.font, color: p.muted, fontSize: 12 },
    grid: { left: 8, right: 24, top: 36, bottom: 8, outerBoundsMode: "same", outerBoundsContain: "all", ...grid },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: p.dark ? "#1c1c1b" : "#ffffff",
      borderColor: p.grid,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: p.ink, fontFamily: p.font, fontSize: 12 },
      axisPointer: { type: "line", lineStyle: { color: p.faint, width: 1 } },
      extraCssText: "box-shadow:0 6px 24px rgba(20,20,18,.12);border-radius:8px;",
    },
  };
}

function legend(p: Palette, extra: Record<string, unknown> = {}) {
  return {
    top: 0,
    left: 0,
    icon: "roundRect",
    itemWidth: 12,
    itemHeight: 4,
    itemGap: 16,
    textStyle: { color: p.muted, fontFamily: p.font, fontSize: 12 },
    inactiveColor: p.faint,
    ...extra,
  };
}

function axis(p: Palette, extra: Record<string, unknown> = {}) {
  return {
    axisLine: { lineStyle: { color: p.grid } },
    axisTick: { show: false },
    axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11 },
    splitLine: { lineStyle: { color: p.grid, type: [3, 3] } },
    // Names above a y axis start at the axis line, so they never run off the left edge.
    nameTextStyle: { color: p.muted, fontFamily: p.font, fontSize: 11, align: extra.nameLocation === "middle" ? "center" : "left" },
    ...extra,
  };
}

function timeAxis(p: Palette, extra: Record<string, unknown> = {}) {
  return axis(p, { type: "time", splitLine: { show: false }, ...extra });
}

/** Inside zoom always, plus a slider once there is something to zoom across. */
function zoom(p: Palette, n: number, xAxisIndex: number | number[] = 0) {
  const inside = { type: "inside", xAxisIndex, filterMode: "none" };
  if (n <= 21) return [inside];
  return [
    inside,
    {
      type: "slider",
      xAxisIndex,
      height: 18,
      bottom: 4,
      filterMode: "none",
      borderColor: p.grid,
      backgroundColor: "transparent",
      fillerColor: p.dark ? "rgba(236,235,231,0.08)" : "rgba(11,11,11,0.05)",
      dataBackground: { lineStyle: { color: p.faint }, areaStyle: { color: "transparent" } },
      selectedDataBackground: { lineStyle: { color: p.muted }, areaStyle: { color: "transparent" } },
      handleStyle: { color: p.surface, borderColor: p.faint },
      moveHandleStyle: { color: p.grid },
      textStyle: { color: p.muted, fontFamily: p.mono, fontSize: 10 },
      labelFormatter: (value: number) => day(new Date(value).toISOString()),
    },
  ];
}

const zoomRoom = (n: number) => (n > 21 ? 36 : 8);

function lineSeries(name: string, data: unknown[], color: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    type: "line",
    data,
    showSymbol: data.length <= 3,
    symbolSize: 6,
    connectNulls: false,
    lineStyle: { width: 2, color },
    itemStyle: { color },
    emphasis: { focus: "series" },
    ...extra,
  };
}

function refLine(p: Palette, value: number, label: string, axisName: "yAxis" | "xAxis" = "yAxis") {
  return {
    silent: true,
    symbol: "none",
    lineStyle: { color: p.faint, type: [4, 3], width: 1 },
    label: { formatter: label, color: p.muted, fontFamily: p.font, fontSize: 11, position: axisName === "yAxis" ? "insideStartTop" : "insideEndTop" },
    data: [{ [axisName]: value }],
  };
}

// -- profit -----------------------------------------------------------------

export function cumulativeProfit(r: Result, p: Palette): ChartOption {
  const d = r.series.daily;
  const n = d.date.length;
  return {
    ...base(p, { bottom: zoomRoom(n), top: 16 }),
    xAxis: timeAxis(p),
    yAxis: axis(p, { type: "value", axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, formatter: (v: number) => gbpShort(v) } }),
    tooltip: { ...base(p).tooltip, valueFormatter: money },
    dataZoom: zoom(p, n),
    series: [
      lineSeries("Cumulative profit", pairs(d.date, cumulative(d.profit_gbp)), p.discharge, {
        areaStyle: { color: p.dischargeSoft },
      }),
    ],
  };
}

export function monthlyProfit(r: Result, p: Palette): ChartOption {
  const m = r.series.monthly;
  return {
    ...base(p, { top: 16 }),
    tooltip: { ...base(p).tooltip, axisPointer: { type: "shadow" }, valueFormatter: money },
    xAxis: axis(p, { type: "category", data: m.month.map(monthLabel), splitLine: { show: false } }),
    yAxis: axis(p, { type: "value", axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, formatter: (v: number) => gbpShort(v) } }),
    series: [
      {
        name: "Profit",
        type: "bar",
        barMaxWidth: 22,
        data: m.profit_gbp.map((v) => ({
          value: isNum(v) ? v : null,
          itemStyle: { color: isNum(v) && v < 0 ? p.charge : p.discharge, borderRadius: isNum(v) && v < 0 ? [0, 0, 3, 3] : [3, 3, 0, 0] },
        })),
      },
    ],
  };
}

// -- prices -----------------------------------------------------------------

export function monthlyPrices(r: Result, p: Palette): ChartOption {
  const m = r.series.monthly;
  // The band series share the market's name so the legend toggles them too, and its colour so the legend swatch is right.
  const band = (name: string, lo: Value[], hi: Value[], color: string, line: string, stack: string) => [
    { name, type: "line", stack, data: lo, lineStyle: { opacity: 0 }, itemStyle: { color: line }, symbol: "none", silent: true, tooltip: { show: false } },
    { name, type: "line", stack, data: bandHeight(lo, hi), lineStyle: { opacity: 0 }, itemStyle: { color: line }, symbol: "none", areaStyle: { color }, silent: true, tooltip: { show: false } },
  ];
  const labels = m.month.map(monthLabel);
  return {
    ...base(p),
    legend: legend(p, { data: ["Market 1 (half-hourly)", "Market 2 (hourly)"] }),
    tooltip: {
      ...base(p).tooltip,
      formatter: (items: { dataIndex: number }[]) => {
        const i = items[0]?.dataIndex ?? 0;
        return `<b>${labels[i]}</b><br/>Market 1: ${price(m.price_1_mean[i])} <span style="color:${p.muted}">(${price(m.price_1_p10[i])} to ${price(m.price_1_p90[i])})</span><br/>Market 2: ${price(m.price_2_mean[i])} <span style="color:${p.muted}">(${price(m.price_2_p10[i])} to ${price(m.price_2_p90[i])})</span>`;
      },
    },
    xAxis: axis(p, { type: "category", data: labels, boundaryGap: false, splitLine: { show: false } }),
    yAxis: axis(p, { type: "value", name: "£/MWh", nameGap: 8 }),
    series: [
      ...band("Market 1 (half-hourly)", m.price_1_p10, m.price_1_p90, p.chargeSoft, p.charge, "b1"),
      ...band("Market 2 (hourly)", m.price_2_p10, m.price_2_p90, p.dischargeSoft, p.discharge, "b2"),
      lineSeries("Market 1 (half-hourly)", m.price_1_mean, p.charge),
      lineSeries("Market 2 (hourly)", m.price_2_mean, p.discharge),
    ],
  };
}

export function spreadHistogram(r: Result, p: Palette): ChartOption {
  const h = r.series.spread_histogram;
  const bars = histogramBars({ edges: h.edges, counts: h.counts });
  return {
    ...base(p, { top: 16 }),
    tooltip: {
      ...base(p).tooltip,
      trigger: "item",
      formatter: (item: { data: [number, number, number, number] }) =>
        `£${num(item.data[2], 1)} to £${num(item.data[3], 1)}/MWh<br/><b>${num(item.data[1])}</b> periods`,
    },
    xAxis: axis(p, { type: "value", min: -h.clip, max: h.clip, name: `Market 2 less Market 1, £/MWh (clipped at ±${num(h.clip)})`, nameLocation: "middle", nameGap: 28, splitLine: { show: false } }),
    yAxis: axis(p, { type: "value" }),
    series: [
      {
        name: "Periods",
        type: "bar",
        data: bars,
        barWidth: "92%",
        barCategoryGap: 0,
        itemStyle: { color: p.discharge, borderRadius: [2, 2, 0, 0] },
        encode: { x: 0, y: 1 },
        markLine: refLine(p, 0, "", "xAxis"),
      },
    ],
  };
}

export function priceProfile(r: Result, p: Palette): ChartOption {
  const pr = r.series.profile;
  const labels = pr.hour.map(hourLabel);
  return {
    ...base(p),
    legend: legend(p),
    tooltip: { ...base(p).tooltip, valueFormatter: price },
    xAxis: axis(p, { type: "category", data: labels, boundaryGap: false, splitLine: { show: false }, axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, interval: 11 } }),
    yAxis: axis(p, { type: "value", scale: true, name: "mean £/MWh", nameGap: 8 }),
    series: [lineSeries("Market 1", pr.price_1, p.charge), lineSeries("Market 2", pr.price_2, p.discharge, { step: false })],
  };
}

export function rangeVsBreakeven(r: Result, p: Palette): ChartOption {
  const d = r.series.daily;
  const n = d.date.length;
  const ceilingMax = Math.max(0, ...d.sell_ceiling.filter(isNum));
  return {
    ...base(p, { bottom: zoomRoom(n) }),
    legend: legend(p, { data: ["Day's range", "Breakeven on the floor"] }),
    tooltip: {
      ...base(p).tooltip,
      formatter: (items: { dataIndex: number }[]) => {
        const i = items[0]?.dataIndex ?? 0;
        const be = breakeven([d.buy_floor[i]], r.battery.breakeven_markup)[0];
        const clears = isNum(be) && isNum(d.sell_ceiling[i]) ? (d.sell_ceiling[i]! > be ? "clears it" : "does not clear it") : "";
        return `<b>${day(d.date[i])}</b><br/>Floor ${price(d.buy_floor[i])}<br/>Ceiling ${price(d.sell_ceiling[i])}<br/>Breakeven ${price(be)} <span style="color:${p.muted}">${clears}</span>`;
      },
    },
    xAxis: timeAxis(p),
    yAxis: axis(p, { type: "value", name: "£/MWh", nameGap: 8, min: 0, max: ceilingMax > 200 ? 200 : undefined }),
    dataZoom: zoom(p, n),
    series: [
      { name: "Day's range", type: "line", stack: "range", data: pairs(d.date, d.buy_floor), lineStyle: { opacity: 0 }, itemStyle: { color: p.charge }, symbol: "none", silent: true },
      { name: "Day's range", type: "line", stack: "range", data: pairs(d.date, bandHeight(d.buy_floor, d.sell_ceiling)), lineStyle: { opacity: 0 }, itemStyle: { color: p.charge }, symbol: "none", areaStyle: { color: p.chargeSoft } },
      lineSeries("Breakeven on the floor", pairs(d.date, breakeven(d.buy_floor, r.battery.breakeven_markup)), p.discharge, { lineStyle: { width: 1.2, color: p.discharge } }),
    ],
  };
}

// -- dispatch ---------------------------------------------------------------

/** The representative week in three stacked panels sharing one time axis: prices, power, storage. */
export function week(r: Result, p: Palette, compact = false): ChartOption {
  const w = r.series.week;
  const t = w.timestamp;
  const grids = compact
    ? [
        { left: 8, right: 8, top: 28, height: "36%", containLabel: true },
        { left: 8, right: 8, top: "52%", height: "40%", containLabel: true },
      ]
    : [
        { left: 8, right: 16, top: 36, height: "28%", containLabel: true },
        { left: 8, right: 16, top: "43%", height: "30%", containLabel: true },
        { left: 8, right: 16, top: "80%", height: "13%", containLabel: true },
      ];
  const panels = grids.length;
  const xAxes = grids.map((_, i) =>
    timeAxis(p, { gridIndex: i, axisLabel: { show: i === panels - 1, color: p.muted, fontFamily: p.mono, fontSize: 11 } }),
  );
  const bar = (name: string, values: Value[], color: string, stack: string, xi: number) => ({
    name,
    type: "bar",
    stack,
    xAxisIndex: xi,
    yAxisIndex: xi,
    data: pairs(t, values),
    barWidth: "70%",
    itemStyle: { color },
  });
  const series: unknown[] = [
    lineSeries("Market 1", pairs(t, w.price_1), p.charge, { lineStyle: { width: 1.5, color: p.charge }, showSymbol: false }),
    lineSeries("Market 2", pairs(t, w.price_2), p.discharge, { step: "start", lineStyle: { width: 1.5, color: p.discharge }, showSymbol: false }),
    bar("Market 1", w.discharge_1_mw, p.charge, "out", 1),
    bar("Market 2", w.discharge_2_mw, p.discharge, "out", 1),
    bar("Market 1", negate(w.charge_1_mw), p.charge, "in", 1),
    bar("Market 2", negate(w.charge_2_mw), p.discharge, "in", 1),
  ];
  if (!compact) {
    series.push(
      lineSeries("Storage", pairs(t, w.storage_mwh), p.muted, {
        xAxisIndex: 2,
        yAxisIndex: 2,
        showSymbol: false,
        lineStyle: { width: 1.5, color: p.muted },
        areaStyle: { color: p.dark ? "rgba(163,162,157,0.12)" : "rgba(82,81,78,0.08)" },
      }),
    );
  }
  const yAxes = [
    axis(p, { gridIndex: 0, type: "value", scale: true, name: compact ? "" : "£/MWh", nameGap: 6, splitNumber: 3 }),
    axis(p, { gridIndex: 1, type: "value", name: compact ? "" : "MW  (+ delivering, − charging)", nameGap: 6, splitNumber: 4 }),
  ];
  if (!compact) {
    yAxes.push(axis(p, { gridIndex: 2, type: "value", min: 0, max: Math.ceil(r.battery.volume_mwh * 1.05 * 10) / 10, name: "MWh stored", nameGap: 6, splitNumber: 2 }));
  }
  return {
    ...base(p),
    grid: grids,
    legend: legend(p, { data: compact ? ["Market 1", "Market 2"] : ["Market 1", "Market 2", "Storage"] }),
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: {
      ...base(p).tooltip,
      formatter: (items: { dataIndex: number }[]) => {
        const i = items[0]?.dataIndex ?? 0;
        const stamp = t[i] ?? "";
        const net = [w.discharge_1_mw[i], w.discharge_2_mw[i]].filter(isNum).reduce((a, b) => a + b, 0) -
          [w.charge_1_mw[i], w.charge_2_mw[i]].filter(isNum).reduce((a, b) => a + b, 0);
        const doing = net > 1e-5 ? `delivering ${mw(net)}` : net < -1e-5 ? `charging ${mw(-net)}` : "idle";
        return `<b>${day(stamp)} ${stamp.slice(11, 16)}</b><br/>Market 1 ${price(w.price_1[i])}<br/>Market 2 ${price(w.price_2[i])}<br/>${doing}<br/>Stored ${isNum(w.storage_mwh[i]) ? num(w.storage_mwh[i], 2) + " MWh" : "n/a"}`;
      },
    },
    xAxis: xAxes,
    yAxis: yAxes,
    dataZoom: compact ? [] : [{ type: "inside", xAxisIndex: Array.from({ length: panels }, (_, i) => i), filterMode: "none" }],
    series,
  };
}

export function netPowerHeatmap(r: Result, p: Palette): ChartOption {
  const np = r.series.net_power;
  const { cells, maxAbs } = heatCells(np.values);
  const n = np.days.length;
  return {
    ...base(p, { top: 12, right: 72, bottom: zoomRoom(n) }),
    tooltip: {
      ...base(p).tooltip,
      trigger: "item",
      formatter: (item: { data: [number, number, number] }) => {
        const [d, h, v] = item.data;
        const what = v > 0 ? "delivering" : v < 0 ? "charging" : "idle";
        return `<b>${day(np.days[d])} ${hourLabel(np.hours[h] ?? h / 2)}</b><br/>${mw(Math.abs(v))} ${what}`;
      },
    },
    xAxis: axis(p, { type: "category", data: np.days.map((d) => day(d)), splitLine: { show: false }, axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, hideOverlap: true } }),
    yAxis: axis(p, {
      type: "category",
      data: np.hours.map(hourLabel),
      inverse: true,
      splitLine: { show: false },
      axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, interval: 11 },
    }),
    visualMap: {
      type: "continuous",
      min: -maxAbs,
      max: maxAbs,
      calculable: false,
      orient: "vertical",
      right: 0,
      top: "middle",
      itemHeight: 140,
      itemWidth: 10,
      text: ["delivering", "charging"],
      textStyle: { color: p.muted, fontFamily: p.font, fontSize: 11 },
      formatter: (v: number) => `${num(v, 1)} MW`,
      inRange: { color: [p.charge, p.surface, p.discharge] },
    },
    dataZoom: zoom(p, n),
    series: [{ name: "Net power", type: "heatmap", data: cells, progressive: 4000, emphasis: { itemStyle: { borderColor: p.ink, borderWidth: 1 } } }],
  };
}

export function profilePower(r: Result, p: Palette): ChartOption {
  const pr = r.series.profile;
  const labels = pr.hour.map(hourLabel);
  const bar = (name: string, values: Value[], color: string, stack: string) => ({ name, type: "bar", stack, data: values, itemStyle: { color }, barWidth: "72%" });
  return {
    ...base(p),
    legend: legend(p, { data: ["Market 1", "Market 2"] }),
    tooltip: {
      ...base(p).tooltip,
      axisPointer: { type: "shadow" },
      formatter: (items: { dataIndex: number }[]) => {
        const i = items[0]?.dataIndex ?? 0;
        return `<b>${labels[i]}</b>, mean<br/>Charging: Market 1 ${mw(pr.charge_1_mw[i])}, Market 2 ${mw(pr.charge_2_mw[i])}<br/>Delivering: Market 1 ${mw(pr.discharge_1_mw[i])}, Market 2 ${mw(pr.discharge_2_mw[i])}`;
      },
    },
    xAxis: axis(p, { type: "category", data: labels, splitLine: { show: false }, axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, interval: 11 } }),
    yAxis: axis(p, { type: "value", name: "mean MW  (+ delivering, − charging)", nameGap: 8 }),
    series: [
      bar("Market 1", pr.discharge_1_mw, p.charge, "out"),
      bar("Market 2", pr.discharge_2_mw, p.discharge, "out"),
      bar("Market 1", negate(pr.charge_1_mw), p.charge, "in"),
      bar("Market 2", negate(pr.charge_2_mw), p.discharge, "in"),
    ],
  };
}

export function shareByHour(r: Result, p: Palette): ChartOption {
  const pr = r.series.profile;
  const labels = pr.hour.map(hourLabel);
  const area = (name: string, values: Value[], color: string) => ({
    name,
    type: "line",
    stack: "share",
    data: values,
    symbol: "none",
    lineStyle: { width: 0 },
    areaStyle: { color, opacity: 1 },
    itemStyle: { color },
  });
  return {
    ...base(p),
    legend: legend(p),
    tooltip: { ...base(p).tooltip, valueFormatter: (v: unknown) => (isNum(v) ? pct(v, 0) : "n/a") },
    xAxis: axis(p, { type: "category", data: labels, boundaryGap: false, splitLine: { show: false }, axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, interval: 11 } }),
    yAxis: axis(p, { type: "value", min: 0, max: 1, axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, formatter: (v: number) => pct(v, 0) } }),
    series: [area("Charging", pr.share_charging, p.charge), area("Delivering", pr.share_delivering, p.discharge), area("Idle", pr.share_idle, p.idle)],
  };
}

// -- cycles -----------------------------------------------------------------

export function cyclesAgainstBudgets(r: Result, p: Palette, fitToBudget: boolean): ChartOption {
  const d = r.series.daily;
  const n = d.date.length;
  const c = r.cycles;
  const used = Math.max(0, ...d.cycles_cumulative.filter(isNum));
  const top = fitToBudget ? Math.max(c.budget, used) * 1.06 : Math.max(used, c.prorated_budget) * 1.15;
  const marks: unknown[] = [];
  if (c.budget <= top) marks.push({ yAxis: c.budget, label: { formatter: `budget ${num(c.budget)}` } });
  if (c.prorated_budget <= top) marks.push({ yAxis: c.prorated_budget, label: { formatter: `pro-rated ${num(c.prorated_budget, c.prorated_budget < 100 ? 1 : 0)}` } });
  if (c.prorated_crossed_at) {
    marks.push({ xAxis: c.prorated_crossed_at.replace("T", " "), label: { formatter: "crossed", position: "insideEndTop" } });
  }
  return {
    ...base(p, { bottom: zoomRoom(n), top: 16 }),
    tooltip: { ...base(p).tooltip, valueFormatter: (v: unknown) => (isNum(v) ? `${num(v, 1)} cycles` : "n/a") },
    xAxis: timeAxis(p),
    yAxis: axis(p, { type: "value", min: 0, max: Math.ceil(top), axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, showMaxLabel: false } }),
    dataZoom: zoom(p, n),
    series: [
      lineSeries("Cycles spent", pairs(d.date, d.cycles_cumulative), p.discharge, {
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: p.faint, type: [4, 3], width: 1 },
          label: { color: p.muted, fontFamily: p.font, fontSize: 11, position: "insideStartTop" },
          data: marks,
        },
      }),
    ],
  };
}

export function dailyCyclesHistogram(r: Result, p: Palette): ChartOption {
  const values = r.series.daily.cycles;
  const bars = histogramBars(histogram(values, 40));
  const m = mean(values);
  return {
    ...base(p, { top: 16 }),
    tooltip: {
      ...base(p).tooltip,
      trigger: "item",
      formatter: (item: { data: [number, number, number, number] }) =>
        `${num(item.data[2], 2)} to ${num(item.data[3], 2)} cycles<br/><b>${num(item.data[1])}</b> days`,
    },
    xAxis: axis(p, { type: "value", scale: true, name: "cycles in a day", nameLocation: "middle", nameGap: 28, splitLine: { show: false } }),
    yAxis: axis(p, { type: "value", minInterval: 1 }),
    series: [
      {
        name: "Days",
        type: "bar",
        data: bars,
        barWidth: "90%",
        itemStyle: { color: p.charge, borderRadius: [2, 2, 0, 0] },
        encode: { x: 0, y: 1 },
        markLine: isNum(m) ? refLine(p, m, `mean ${num(m, 1)}/day`, "xAxis") : undefined,
      },
    ],
  };
}

export function usableVolume(r: Result, p: Palette): ChartOption {
  const d = r.series.daily;
  const n = d.date.length;
  const vol = r.battery.volume_mwh;
  const lo = Math.min(vol * 0.995, ...d.usable_volume_mwh.filter(isNum));
  return {
    ...base(p, { bottom: zoomRoom(n), top: 16 }),
    tooltip: { ...base(p).tooltip, valueFormatter: (v: unknown) => (isNum(v) ? `${num(v, 4)} MWh` : "n/a") },
    xAxis: timeAxis(p),
    yAxis: axis(p, { type: "value", min: Math.floor(lo * 1000) / 1000, max: vol * 1.0005, axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, showMaxLabel: false, showMinLabel: false, formatter: (v: number) => num(v, 3) } }),
    dataZoom: zoom(p, n),
    series: [lineSeries("Usable volume", pairs(d.date, d.usable_volume_mwh), p.ink, { lineStyle: { width: 1.8, color: p.ink } })],
  };
}

// -- spread or level --------------------------------------------------------

export function profitScatter(r: Result, p: Palette, column: "harvestable_spread" | "mean_price"): ChartOption {
  const d = r.series.daily;
  const xs = d[column];
  const points = scatter(xs, d.profit_gbp, d.date);
  const fit = linearFit(xs, d.profit_gbp);
  const color = column === "harvestable_spread" ? p.discharge : p.charge;
  const xMax = quantile(xs, 0.995);
  const yLo = quantile(d.profit_gbp, 0.002);
  const yHi = quantile(d.profit_gbp, 0.998);
  const lineData =
    fit && points.length
      ? (() => {
          const x0 = Math.min(...points.map((pt) => pt[0]));
          const x1 = Math.max(...points.map((pt) => pt[0]));
          return [
            [x0, fit.slope * x0 + fit.intercept],
            [x1, fit.slope * x1 + fit.intercept],
          ];
        })()
      : [];
  return {
    ...base(p, { top: 16, bottom: 8 }),
    tooltip: {
      ...base(p).tooltip,
      trigger: "item",
      formatter: (item: { seriesType: string; data: [number, number, string] }) =>
        item.seriesType === "scatter" ? `<b>${day(item.data[2])}</b><br/>${price(item.data[0])}<br/>profit ${money(item.data[1])}` : "least-squares fit",
    },
    xAxis: axis(p, {
      type: "value",
      min: 0,
      max: isNum(xMax) && points.length > 30 ? Math.ceil(xMax / 10) * 10 : undefined,
      name: column === "harvestable_spread" ? "the day's harvestable spread, £/MWh" : "the day's mean price, £/MWh",
      nameLocation: "middle",
      nameGap: 28,
      axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, showMaxLabel: false },
    }),
    yAxis: axis(p, {
      type: "value",
      min: isNum(yLo) && points.length > 30 ? Math.min(0, Math.floor(yLo / 50) * 50) : undefined,
      max: isNum(yHi) && points.length > 30 ? Math.ceil(yHi / 100) * 100 : undefined,
      axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, showMinLabel: false, formatter: (v: number) => gbpShort(v) },
    }),
    series: [
      { name: "Days", type: "scatter", data: points, symbolSize: points.length > 300 ? 4 : 7, itemStyle: { color, opacity: points.length > 300 ? 0.45 : 0.85 } },
      { name: "Fit", type: "line", data: lineData, symbol: "none", silent: true, lineStyle: { color: p.ink, width: 1.4 } },
    ],
  };
}

export function quarterlyLevelAndSpread(r: Result, p: Palette): ChartOption {
  const q = r.series.quarterly;
  const labels = q.quarter.map(quarterLabel);
  return {
    ...base(p),
    legend: legend(p),
    tooltip: { ...base(p).tooltip, valueFormatter: (v: unknown) => (isNum(v) ? `${num(v, 2)}× ${labels[0] ?? ""}` : "n/a") },
    xAxis: axis(p, { type: "category", data: labels, boundaryGap: false, splitLine: { show: false } }),
    yAxis: axis(p, { type: "value", scale: true, name: `relative to ${labels[0] ?? "the first quarter"}`, nameGap: 8 }),
    series: [
      lineSeries("Price level", normaliseToFirst(q.mean_price), p.charge, { showSymbol: true, markLine: refLine(p, 1, "") }),
      lineSeries("Harvestable spread", normaliseToFirst(q.harvestable_spread), p.discharge, { showSymbol: true }),
    ],
  };
}

// -- yardstick --------------------------------------------------------------

export function yardstickScatter(r: Result, p: Palette): ChartOption {
  const d = r.series.daily;
  const points = scatter(d.yardstick_gbp, d.profit_gbp, d.date);
  const limit = Math.max(quantile(d.yardstick_gbp, 0.99) ?? 0, quantile(d.profit_gbp, 0.99) ?? 0, 1);
  const top = points.length > 30 ? Math.ceil(limit / 100) * 100 : undefined;
  const parityEnd = top ?? Math.max(1, ...points.flatMap((pt) => [pt[0], pt[1]])) * 1.05;
  return {
    ...base(p, { top: 16 }),
    tooltip: {
      ...base(p).tooltip,
      trigger: "item",
      formatter: (item: { seriesType: string; data: [number, number, string] }) =>
        item.seriesType === "scatter" ? `<b>${day(item.data[2])}</b><br/>one ideal cycle ${money(item.data[0])}<br/>the plan ${money(item.data[1])}` : "parity",
    },
    xAxis: axis(p, { type: "value", min: 0, max: top, name: "one ideal cycle that day", nameLocation: "middle", nameGap: 28, axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, formatter: (v: number) => gbpShort(v) } }),
    yAxis: axis(p, { type: "value", min: (v: { min: number }) => Math.min(0, v.min), max: top, name: "the plan that day", nameGap: 8, axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, showMinLabel: false, formatter: (v: number) => gbpShort(v) } }),
    series: [
      { name: "Days", type: "scatter", data: points, symbolSize: points.length > 300 ? 4 : 7, itemStyle: { color: p.discharge, opacity: points.length > 300 ? 0.45 : 0.85 } },
      { name: "Parity", type: "line", data: [[0, 0], [parityEnd, parityEnd]], symbol: "none", silent: true, lineStyle: { color: p.faint, type: [4, 3], width: 1 } },
    ],
  };
}

export function yardstickByYear(r: Result, p: Palette): ChartOption {
  const y = r.series.yearly;
  return {
    ...base(p, { top: 16 }),
    tooltip: { ...base(p).tooltip, axisPointer: { type: "shadow" }, valueFormatter: (v: unknown) => (isNum(v) ? `${num(v, 2)}× the yardstick` : "n/a") },
    xAxis: axis(p, { type: "category", data: y.year.map(String), splitLine: { show: false } }),
    yAxis: axis(p, { type: "value", min: 0, name: "plan / yardstick, median day", nameGap: 8 }),
    series: [
      {
        name: "Median ratio",
        type: "bar",
        data: y.yardstick_median_ratio,
        barMaxWidth: 56,
        itemStyle: { color: p.charge, borderRadius: [3, 3, 0, 0] },
        markLine: refLine(p, 1, "parity"),
      },
    ],
  };
}

/** Every chart builder, for the tests to run over a payload. */
export const ALL_BUILDERS: ((r: Result, p: Palette) => ChartOption)[] = [
  cumulativeProfit,
  monthlyProfit,
  monthlyPrices,
  spreadHistogram,
  priceProfile,
  rangeVsBreakeven,
  (r, p) => week(r, p),
  (r, p) => week(r, p, true),
  netPowerHeatmap,
  profilePower,
  shareByHour,
  (r, p) => cyclesAgainstBudgets(r, p, true),
  (r, p) => cyclesAgainstBudgets(r, p, false),
  dailyCyclesHistogram,
  usableVolume,
  (r, p) => profitScatter(r, p, "harvestable_spread"),
  (r, p) => profitScatter(r, p, "mean_price"),
  quarterlyLevelAndSpread,
  yardstickScatter,
  yardstickByYear,
];
