/*
 * The panel's only drawing primitives. Hand-rolled SVG on purpose: a chart library is ~40 KB
 * and its own theming system, and everything below is geometry the funnel dashboard already
 * knows how to compute. Colours are `--chart-*` semantic tokens only, so light/dark is free.
 *
 * The viewBox is fixed and the element is `width: 100%; height: auto`, so the drawing scales
 * with its container without letterboxing — which is what lets the tooltip be positioned as a
 * plain percentage of the container width.
 */

import { useState } from 'react';

const VB_W = 960;
const VB_H = 260;
const PAD_T = 14;
const PAD_R = 16;
const PAD_B = 30;
const PAD_L = 46;
const PLOT_W = VB_W - PAD_L - PAD_R;
const PLOT_H = VB_H - PAD_T - PAD_B;
const BASE_Y = PAD_T + PLOT_H;

/** Percent gridlines. The y-scale is always 0–100%: a completion rate has fixed bounds, and
 *  auto-scaling one would make a 2% dip look like a collapse. */
const Y_TICKS = [0, 25, 50, 75, 100];

/** Past this many buckets the per-point dots merge into a bead chain; the line carries it. */
const MAX_DOTS = 40;

/** One plotted bucket. Every funnel-specific format decision is made by the page, not here. */
export interface ChartPoint {
  /** x-axis tick text. */
  label: string;
  /** Full timestamp, for the tooltip readout. */
  title: string;
  /** 0..1. */
  value: number;
  entrants: number;
  completed: number;
  /** The cohort has not finished yet, so its rate is artificially low — dashed and hollow. */
  partial: boolean;
}

const px = (i: number, n: number) => (n > 1 ? PAD_L + (i / (n - 1)) * PLOT_W : PAD_L + PLOT_W / 2);
const py = (v: number) => PAD_T + (1 - Math.min(1, Math.max(0, v))) * PLOT_H;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function LineChart({ points }: { points: ChartPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const n = points.length;
  const hasData = points.some((p) => p.entrants > 0);
  const xy = points.map((p, i) => ({ x: px(i, n), y: py(p.value), p }));

  // Solid runs break at every partial point; the segments that touch one are drawn dashed on
  // top. Merging the solid runs (rather than emitting one path per segment) is what gives the
  // line real joins instead of a chain of round caps.
  const solid: string[] = [];
  let run: string[] = [];
  for (const q of xy) {
    if (q.p.partial) {
      if (run.length > 1) solid.push(run.join(''));
      run = [];
      continue;
    }
    run.push(`${run.length === 0 ? 'M' : 'L'}${q.x} ${q.y}`);
  }
  if (run.length > 1) solid.push(run.join(''));

  const dashed: string[] = [];
  for (let i = 1; i < xy.length; i++) {
    const a = xy[i - 1];
    const b = xy[i];
    if (a && b && (a.p.partial || b.p.partial)) dashed.push(`M${a.x} ${a.y}L${b.x} ${b.y}`);
  }

  // The wash stops where the data stops being final. Filling under the dashed tail would give
  // a provisional number the same visual weight as a settled one.
  let settled = -1;
  for (const q of xy) {
    if (q.p.partial) break;
    settled++;
  }
  const first = xy[0];
  const last = xy[settled];
  const area =
    settled >= 1 && first && last
      ? `M${first.x} ${BASE_Y}${xy
          .slice(0, settled + 1)
          .map((q) => `L${q.x} ${q.y}`)
          .join('')}L${last.x} ${BASE_Y}Z`
      : '';

  const tickEvery = Math.max(1, Math.ceil(n / 6));
  const ticks: number[] = [];
  for (let i = 0; i < n; i += tickEvery) ticks.push(i);
  const lastTick = ticks[ticks.length - 1];
  if (n > 0 && lastTick !== n - 1) {
    if (lastTick !== undefined && n - 1 - lastTick < tickEvery / 2) ticks.pop();
    ticks.push(n - 1);
  }

  const band = n > 1 ? PLOT_W / (n - 1) : PLOT_W;
  const hp = hover === null ? undefined : points[hover];
  const hx = hover === null ? 0 : px(hover, n);
  const edge = hx / VB_W < 0.18 ? ' chart-tip-start' : hx / VB_W > 0.82 ? ' chart-tip-end' : '';

  return (
    <div className="chart-wrap">
      {/* aria-hidden: the table below is the accessible copy, and announcing both would read
          every value twice. Nothing here is reachable only by hovering. */}
      <svg
        className="chart-svg"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden
        onPointerLeave={() => setHover(null)}
      >
        <g className="chart-axis-text">
          {Y_TICKS.map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={VB_W - PAD_R} y1={py(t / 100)} y2={py(t / 100)} className="chart-grid-line" />
              <text x={PAD_L - 8} y={py(t / 100)} textAnchor="end" dominantBaseline="middle">
                {t}%
              </text>
            </g>
          ))}
          {hasData
            ? ticks.map((i) => (
                <text
                  key={i}
                  x={px(i, n)}
                  y={BASE_Y + 18}
                  textAnchor={i === n - 1 && n > 1 ? 'end' : i === 0 && n > 1 ? 'start' : 'middle'}
                >
                  {points[i]?.label}
                </text>
              ))
            : null}
        </g>

        {hasData ? (
          <>
            {area ? <path d={area} className="chart-area" /> : null}
            {hover === null ? null : (
              <line x1={hx} x2={hx} y1={PAD_T} y2={BASE_Y} className="chart-crosshair" />
            )}
            {solid.map((d) => (
              <path key={d} d={d} className="chart-line" />
            ))}
            {dashed.map((d) => (
              <path key={d} d={d} className="chart-line chart-line-partial" />
            ))}
            {n <= MAX_DOTS
              ? xy.map((q, i) => (
                  <circle
                    key={i}
                    cx={q.x}
                    cy={q.y}
                    r={hover === i ? 5.5 : 4}
                    className={q.p.partial ? 'chart-dot chart-dot-partial' : 'chart-dot'}
                  />
                ))
              : hover === null
                ? null
                : (() => {
                    const q = xy[hover];
                    return q ? (
                      <circle
                        cx={q.x}
                        cy={q.y}
                        r={5.5}
                        className={q.p.partial ? 'chart-dot chart-dot-partial' : 'chart-dot'}
                      />
                    ) : null;
                  })()}
            {/* Hit targets are a full-height band per bucket, so the reader aims at a time,
                never at a 4px dot. */}
            {xy.map((q, i) => (
              <rect
                key={i}
                x={Math.max(PAD_L, q.x - band / 2)}
                y={PAD_T}
                width={Math.min(band, VB_W - PAD_R - Math.max(PAD_L, q.x - band / 2))}
                height={PLOT_H}
                fill="transparent"
                onPointerEnter={() => setHover(i)}
              />
            ))}
          </>
        ) : null}
      </svg>

      {hasData ? null : <div className="chart-empty">No data in this range.</div>}

      {hp ? (
        <div className={`chart-tip${edge}`} style={{ left: `${(hx / VB_W) * 100}%` }}>
          <div className="chart-tip-value">
            {pct(hp.value)}
            {hp.partial ? <span className="chart-tip-flag"> partial</span> : null}
          </div>
          <div className="chart-tip-meta">{hp.title}</div>
          <div className="chart-tip-meta">
            {hp.completed.toLocaleString()} of {hp.entrants.toLocaleString()} finished
          </div>
        </div>
      ) : null}

      <div className="chart-legend">
        <span className="chart-key">
          <svg width="18" height="10" aria-hidden>
            <line x1="1" x2="17" y1="5" y2="5" className="chart-line" />
            <circle cx="9" cy="5" r="3.5" className="chart-dot" />
          </svg>
          Completion rate
        </span>
        <span className="chart-key">
          <svg width="18" height="10" aria-hidden>
            <line x1="1" x2="17" y1="5" y2="5" className="chart-line chart-line-partial" />
            <circle cx="9" cy="5" r="3.5" className="chart-dot chart-dot-partial" />
          </svg>
          Still filling
        </span>
        <span className="chart-note">
          Dashed buckets have not finished — those players have not had time to reach the last step yet, so the
          rate reads low. It is not a drop.
        </span>
      </div>

      <table className="sr-only">
        <caption>Completion rate per bucket</caption>
        <thead>
          <tr>
            <th>Bucket</th>
            <th>Started</th>
            <th>Completed</th>
            <th>Completion rate</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.title}>
              <td>{p.title}</td>
              <td>{p.entrants.toLocaleString()}</td>
              <td>{p.completed.toLocaleString()}</td>
              <td>{pct(p.value)}</td>
              <td>{p.partial ? 'still filling' : 'final'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The completion bar in the step table. HTML rather than SVG so the text keeps its real size
 * at any column width — an SVG stretched to fill a cell would distort the digits.
 *
 * The number is drawn twice, the second copy clipped to the fill, so it stays legible whether
 * it lands on the fill or on the track.
 */
export function MeterCell({ value }: { value: number }) {
  const p = Math.min(1, Math.max(0, value)) * 100;
  const text = `${p.toFixed(1)}%`;
  return (
    <div className="meter" role="img" aria-label={text}>
      <div className="meter-fill" style={{ width: `${p}%` }} />
      <span className="meter-num">{text}</span>
      <span className="meter-num meter-num-on" style={{ clipPath: `inset(0 ${100 - p}% 0 0)` }} aria-hidden>
        {text}
      </span>
    </div>
  );
}
