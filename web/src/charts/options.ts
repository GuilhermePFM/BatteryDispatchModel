// One ECharts option per figure of the results page, built from the v2 result
// payload alone. Pure functions of (result, palette), so they are tested with
// nulls and with a payload of a few days.
import type { Result, ResultCase } from "../contracts/types";
import type { YearFlow } from "../finance/model";
import { brl, brlShort, day, hourLabel, monthLabel, num } from "../lib/format";
import { bandHeight, cumulative, heatCells, histogram, histogramBars, isNum, mean, negate, pairs, type Value } from "./adapters";
import type { ChartOption } from "./echarts";
import type { Palette } from "./theme";

type Fmt = (v: unknown) => string;
const money: Fmt = (v) => (isNum(v) ? brl(v) : "n/a");
const price: Fmt = (v) => (isNum(v) ? `R$ ${num(v, 2)}/MWh` : "n/a");
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

const moneyAxis = (p: Palette) => ({ color: p.muted, fontFamily: p.mono, fontSize: 11, formatter: (v: number) => brlShort(v) });

// -- value ------------------------------------------------------------------

/** The case the detail block describes. */
export function detailCase(r: Result): ResultCase | undefined {
  return r.cases.find((c) => c.submarket === r.detail.submarket && c.case === r.detail.case);
}

export function cumulativeValue(r: Result, p: Palette): ChartOption {
  const d = r.detail.daily;
  const n = d.date.length;
  return {
    ...base(p, { bottom: zoomRoom(n), top: 16 }),
    xAxis: timeAxis(p),
    yAxis: axis(p, { type: "value", axisLabel: moneyAxis(p) }),
    tooltip: { ...base(p).tooltip, valueFormatter: money },
    dataZoom: zoom(p, n),
    series: [lineSeries("Cumulative value", pairs(d.date, cumulative(d.value_brl)), p.discharge, { areaStyle: { color: p.dischargeSoft } })],
  };
}

export function monthlyValue(r: Result, p: Palette): ChartOption {
  const m = detailCase(r)?.monthly;
  const months = m?.month ?? [];
  const values = m?.value_brl ?? [];
  return {
    ...base(p, { top: 16 }),
    tooltip: { ...base(p).tooltip, axisPointer: { type: "shadow" }, valueFormatter: money },
    xAxis: axis(p, { type: "category", data: months.map(monthLabel), splitLine: { show: false } }),
    yAxis: axis(p, { type: "value", axisLabel: moneyAxis(p) }),
    series: [
      {
        name: "Value",
        type: "bar",
        barMaxWidth: 22,
        data: values.map((v) => ({
          value: isNum(v) ? v : null,
          itemStyle: { color: isNum(v) && v < 0 ? p.charge : p.discharge, borderRadius: isNum(v) && v < 0 ? [0, 0, 3, 3] : [3, 3, 0, 0] },
        })),
      },
    ],
  };
}

/** The merchant balanced year of each submarket, best first. */
export function rankingBars(r: Result, p: Palette): ChartOption {
  const rows = r.ranking;
  return {
    ...base(p, { top: 16 }),
    tooltip: { ...base(p).tooltip, axisPointer: { type: "shadow" }, valueFormatter: money },
    xAxis: axis(p, { type: "category", data: rows.map((row) => row.submarket), splitLine: { show: false } }),
    yAxis: axis(p, { type: "value", axisLabel: moneyAxis(p) }),
    series: [{ name: "Merchant, balanced year", type: "bar", barMaxWidth: 56, data: rows.map((row) => row.balanced_year_brl), itemStyle: { color: p.discharge, borderRadius: [3, 3, 0, 0] } }],
  };
}

// -- prices -----------------------------------------------------------------

/** The day's floor to ceiling with its mean. The axis follows the data: the PLD has no 200 cap. */
export function dailyPriceBand(r: Result, p: Palette): ChartOption {
  const d = r.detail.daily;
  const n = d.date.length;
  return {
    ...base(p, { bottom: zoomRoom(n) }),
    legend: legend(p, { data: ["Day's range", "Mean"] }),
    tooltip: {
      ...base(p).tooltip,
      formatter: (items: { dataIndex: number }[]) => {
        const i = items[0]?.dataIndex ?? 0;
        return `<b>${day(d.date[i])}</b><br/>Floor ${price(d.price_min[i])}<br/>Mean ${price(d.price_mean[i])}<br/>Ceiling ${price(d.price_max[i])}`;
      },
    },
    xAxis: timeAxis(p),
    yAxis: axis(p, { type: "value", name: "R$/MWh", nameGap: 8, min: 0 }),
    dataZoom: zoom(p, n),
    series: [
      { name: "Day's range", type: "line", stack: "range", data: pairs(d.date, d.price_min), lineStyle: { opacity: 0 }, itemStyle: { color: p.charge }, symbol: "none", silent: true },
      { name: "Day's range", type: "line", stack: "range", data: pairs(d.date, bandHeight(d.price_min, d.price_max)), lineStyle: { opacity: 0 }, itemStyle: { color: p.charge }, symbol: "none", areaStyle: { color: p.chargeSoft } },
      lineSeries("Mean", pairs(d.date, d.price_mean), p.discharge, { lineStyle: { width: 1.2, color: p.discharge } }),
    ],
  };
}

export function priceProfile(r: Result, p: Palette): ChartOption {
  const pr = r.detail.profile;
  return {
    ...base(p),
    tooltip: { ...base(p).tooltip, valueFormatter: price },
    xAxis: axis(p, { type: "category", data: pr.hour.map(hourLabel), boundaryGap: false, splitLine: { show: false }, axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, interval: 5 } }),
    yAxis: axis(p, { type: "value", scale: true, name: "mean R$/MWh", nameGap: 8 }),
    series: [lineSeries("PLD", pr.price, p.charge)],
  };
}

// -- dispatch ---------------------------------------------------------------

/** The representative week in stacked panels sharing one time axis: price, power, storage. */
export function week(r: Result, p: Palette, compact = false): ChartOption {
  const w = r.detail.week;
  const t = w.hora;
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
  const xAxes = grids.map((_, i) => timeAxis(p, { gridIndex: i, axisLabel: { show: i === panels - 1, color: p.muted, fontFamily: p.mono, fontSize: 11 } }));
  const bar = (name: string, values: Value[], color: string) => ({ name, type: "bar", stack: "power", xAxisIndex: 1, yAxisIndex: 1, data: pairs(t, values), barWidth: "70%", itemStyle: { color } });
  const series: unknown[] = [
    lineSeries("PLD", pairs(t, w.price), p.muted, { step: "start", lineStyle: { width: 1.5, color: p.muted }, showSymbol: false }),
    bar("Delivering", w.discharge_mw, p.discharge),
    bar("Charging", negate(w.charge_mw), p.charge),
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
    axis(p, { gridIndex: 0, type: "value", scale: true, name: compact ? "" : "R$/MWh", nameGap: 6, splitNumber: 3 }),
    axis(p, { gridIndex: 1, type: "value", name: compact ? "" : "MW  (+ delivering, − charging)", nameGap: 6, splitNumber: 4 }),
  ];
  if (!compact) {
    yAxes.push(axis(p, { gridIndex: 2, type: "value", min: 0, max: Math.ceil(r.battery.volume_mwh * 1.05 * 10) / 10, name: "MWh stored", nameGap: 6, splitNumber: 2 }));
  }
  return {
    ...base(p),
    grid: grids,
    legend: legend(p, { data: compact ? ["PLD", "Delivering", "Charging"] : ["PLD", "Delivering", "Charging", "Storage"] }),
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    tooltip: {
      ...base(p).tooltip,
      formatter: (items: { dataIndex: number }[]) => {
        const i = items[0]?.dataIndex ?? 0;
        const stamp = t[i] ?? "";
        const net = (isNum(w.discharge_mw[i]) ? w.discharge_mw[i] : 0) - (isNum(w.charge_mw[i]) ? w.charge_mw[i] : 0);
        const doing = net > 1e-5 ? `delivering ${mw(net)}` : net < -1e-5 ? `charging ${mw(-net)}` : "idle";
        return `<b>${day(stamp)} ${stamp.slice(11, 16)}</b><br/>PLD ${price(w.price[i])}<br/>${doing}<br/>Stored ${isNum(w.storage_mwh[i]) ? num(w.storage_mwh[i], 2) + " MWh" : "n/a"}`;
      },
    },
    xAxis: xAxes,
    yAxis: yAxes,
    dataZoom: compact ? [] : [{ type: "inside", xAxisIndex: Array.from({ length: panels }, (_, i) => i), filterMode: "none" }],
    series,
  };
}

export function netPowerHeatmap(r: Result, p: Palette): ChartOption {
  const np = r.detail.net_power;
  const power = r.battery.power_mw;
  const { cells, maxAbs } = heatCells(np.permille.map((row) => row.map((v) => (isNum(v) ? (v / 1000) * power : null))));
  const n = np.date.length;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return {
    ...base(p, { top: 12, right: 72, bottom: zoomRoom(n) }),
    tooltip: {
      ...base(p).tooltip,
      trigger: "item",
      formatter: (item: { data: [number, number, number] }) => {
        const [d, h, v] = item.data;
        const what = v > 0 ? "delivering" : v < 0 ? "charging" : "idle";
        return `<b>${day(np.date[d])} ${hourLabel(h)}</b><br/>${mw(Math.abs(v))} ${what}`;
      },
    },
    xAxis: axis(p, { type: "category", data: np.date.map((d) => day(d)), splitLine: { show: false }, axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, hideOverlap: true } }),
    yAxis: axis(p, { type: "category", data: hours.map(hourLabel), inverse: true, splitLine: { show: false }, axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, interval: 5 } }),
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
  const pr = r.detail.profile;
  const labels = pr.hour.map(hourLabel);
  const bar = (name: string, values: Value[], color: string) => ({ name, type: "bar", stack: "power", data: values, itemStyle: { color }, barWidth: "72%" });
  return {
    ...base(p),
    legend: legend(p, { data: ["Delivering", "Charging"] }),
    tooltip: {
      ...base(p).tooltip,
      axisPointer: { type: "shadow" },
      formatter: (items: { dataIndex: number }[]) => {
        const i = items[0]?.dataIndex ?? 0;
        return `<b>${labels[i]}</b>, mean<br/>Charging ${mw(pr.charge_mw[i])}<br/>Delivering ${mw(pr.discharge_mw[i])}`;
      },
    },
    xAxis: axis(p, { type: "category", data: labels, splitLine: { show: false }, axisLabel: { color: p.muted, fontFamily: p.mono, fontSize: 11, interval: 5 } }),
    yAxis: axis(p, { type: "value", name: "mean MW  (+ delivering, − charging)", nameGap: 8 }),
    series: [bar("Delivering", pr.discharge_mw, p.discharge), bar("Charging", negate(pr.charge_mw), p.charge)],
  };
}

// -- cycles -----------------------------------------------------------------

export function dailyCyclesHistogram(r: Result, p: Palette): ChartOption {
  const values = r.detail.daily.cycles;
  const bars = histogramBars(histogram(values, 40));
  const m = mean(values);
  return {
    ...base(p, { top: 16 }),
    tooltip: {
      ...base(p).tooltip,
      trigger: "item",
      formatter: (item: { data: [number, number, number, number] }) => `${num(item.data[2], 2)} to ${num(item.data[3], 2)} cycles<br/><b>${num(item.data[1])}</b> days`,
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

// -- investment -------------------------------------------------------------

/** Yearly cash flows as bars, with the cumulative position after capex as a line. */
export function cashFlowChart(flows: YearFlow[], capex: number, p: Palette): ChartOption {
  const labels = ["0", ...flows.map((f) => String(f.year))];
  const values = [-capex, ...flows.map((f) => f.cashFlow)];
  return {
    ...base(p),
    legend: legend(p, { data: ["Cash flow", "Cumulative"] }),
    tooltip: { ...base(p).tooltip, axisPointer: { type: "shadow" }, valueFormatter: money },
    xAxis: axis(p, { type: "category", data: labels, name: "contract year", nameLocation: "middle", nameGap: 26, splitLine: { show: false } }),
    yAxis: axis(p, { type: "value", axisLabel: moneyAxis(p) }),
    series: [
      {
        name: "Cash flow",
        type: "bar",
        barMaxWidth: 26,
        data: values.map((v) => ({ value: v, itemStyle: { color: v < 0 ? p.charge : p.discharge } })),
      },
      lineSeries("Cumulative", cumulative(values), p.ink, { lineStyle: { width: 1.6, color: p.ink } }),
    ],
  };
}

/** Every chart builder of a result, for the tests to run over a payload. */
export const ALL_BUILDERS: ((r: Result, p: Palette) => ChartOption)[] = [
  cumulativeValue,
  monthlyValue,
  rankingBars,
  dailyPriceBand,
  priceProfile,
  (r, p) => week(r, p),
  (r, p) => week(r, p, true),
  netPowerHeatmap,
  profilePower,
  dailyCyclesHistogram,
];
