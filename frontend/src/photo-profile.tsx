import { useMemo, useState } from 'react';
import type { AssetFilter } from './charts';
import { smoothPath } from './smooth-path';
import { FloatingTooltip } from './tooltip';
import { useLocale } from './i18n';
import { formatNumber } from './number-format';

export type Moment = { count: number; mean: number | null; std: number | null };
export type ParameterSlice = { axis: 'hour' | 'month' | 'year'; bucket: number; segment: 'all' | 'favorites' | 'geo' | 'people' | 'camera' | 'mobile'; iso: Moment; focal: Moment; aperture: Moment };
export type PhotoProfile = {
  photo_days: number; photos: number; favorite_photos: number;
  photos_per_photo_day: number | null; average_streak_days: number | null; average_pause_days: number | null;
  average_cycle_days: number | null; photos_per_streak_day: number | null; maximum_photos_per_streak_day: number | null;
  streak_vs_normal_ratio: number | null; streak_pause_correlation: number | null; long_streak_day_percent: number | null;
  streak_distribution: { label: string; count: number }[]; pause_distribution: { label: string; count: number }[];
  streak_pause_buckets: { label: string; count: number; average_pause_days: number }[];
  indices: Record<IndexKey, number | null>;
};
export type AnnualPhotoProfile = { year: number; profile: PhotoProfile };

type IndexKey = 'focus' | 'volatility' | 'habit' | 'regularity' | 'momentum' | 'burnout' | 'stability';
type ParameterKey = 'iso' | 'focal' | 'aperture';
const indexDetails: Record<IndexKey, { label: string; formula: string; color: string }> = {
  focus: { label: "Focus index", formula: "Share of all photos captured on the most active rounded-up 10% of photo days.", color: 'var(--series-0)' },
  volatility: { label: "Volatility index", formula: "Variation in photos per photo day: 100 × coefficient of variation / (1 + coefficient of variation).", color: 'var(--series-1)' },
  habit: { label: "Habit strength index", formula: "Share of photo days belonging to a streak of at least three days.", color: 'var(--series-2)' },
  regularity: { label: "Rhythm regularity index", formula: "100 / (1 + coefficient of variation of intervals between photo days). At least three photo days required.", color: 'var(--series-3)' },
  momentum: { label: "Momentum index", formula: "Average photos on first streak days / (average first days + average later streak days) × 100. A score of 50 means equal intensity.", color: 'var(--series-4)' },
  burnout: { label: "Burnout index", formula: "Average break after ≥3-day streaks / (that break + overall average break) × 100. A score of 50 means equally long breaks.", color: 'var(--series-5)' },
  stability: { label: "Stability index", formula: "Average streak length / (average streak length + average break) × 100.", color: 'var(--series-6)' },
};
const indexKeys = Object.keys(indexDetails) as IndexKey[];
const metricDetails: Record<ParameterKey, { label: string; unit: string }> = {
  iso: { label: 'ISO', unit: 'ISO' }, focal: { label: "Focal length", unit: 'mm' },
  aperture: { label: "Aperture", unit: 'f/' },
};
const segmentDetails: Record<ParameterSlice['segment'], string> = {
  all: "All photos", favorites: "Favorites", geo: "With location", people: "With person", camera: "Camera", mobile: "Mobile device",
};
const fmt = (value: number | null, digits = 1) => value === null ? '—' : formatNumber(value, { maximumFractionDigits: digits });

export function ParameterChart({ slices, axis, onExplore }: { slices: ParameterSlice[]; axis: ParameterSlice['axis']; onExplore?: (filter: AssetFilter) => void }) {
  const { t, language } = useLocale();
  const [metric, setMetric] = useState<ParameterKey>('iso');
  const [segment, setSegment] = useState<ParameterSlice['segment']>('all');
  const [logScale, setLogScale] = useState(true);
  const [showStd, setShowStd] = useState(axis === 'year');
  const [hover, setHover] = useState<{ bucket: number; moment: Moment; x: number; y: number } | null>(null);
  const filtered = slices.filter(slice => slice.axis === axis && slice.segment === segment);
  const buckets = axis === 'hour' ? Array.from({ length: 24 }, (_, i) => i) : axis === 'month' ? Array.from({ length: 12 }, (_, i) => i + 1) : [...new Set(slices.filter(slice => slice.axis === 'year').map(slice => slice.bucket))].sort((a, b) => a - b);
  const byBucket = new Map(filtered.map(slice => [slice.bucket, slice[metric]]));
  const values = buckets.map(bucket => ({ bucket, moment: byBucket.get(bucket) }));
  const upper = Math.max(1, ...values.map(item => {
    const point = item.moment;
    return point?.mean === null || point?.mean === undefined ? 0 : point.mean + (showStd ? point.std ?? 0 : 0);
  }));
  const scaleValue = (value: number) => logScale ? Math.log10(1 + value) : value;
  const y = (value: number) => 220 - scaleValue(Math.max(0, value)) / scaleValue(upper) * 170;
  const x = (index: number) => 62 + index / Math.max(1, buckets.length - 1) * 696;
  const path = smoothPath(values.map((item, index) => item.moment?.mean === null || item.moment?.mean === undefined ? null : [x(index), y(item.moment.mean)] as const));
  const valid = values.map((item, index) => ({ item, index })).filter(({ item }) => item.moment?.mean !== null && item.moment?.mean !== undefined);
  const lineCommands = (points: [number, number][]) => points.slice(1).map((point, index) => {
    const previous = points[index], before = points[Math.max(0, index - 1)], after = points[Math.min(points.length - 1, index + 2)];
    return `C ${previous[0] + (point[0] - before[0]) / 6} ${previous[1] + (point[1] - before[1]) / 6} ${point[0] - (after[0] - previous[0]) / 6} ${point[1] - (after[1] - previous[1]) / 6} ${point[0]} ${point[1]}`;
  }).join(' ');
  const upperBand = valid.map(({ item, index }): [number, number] => [x(index), y(item.moment!.mean! + (item.moment!.std ?? 0))]);
  const lowerBand = valid.map(({ item, index }): [number, number] => [x(index), y(Math.max(0, item.moment!.mean! - (item.moment!.std ?? 0)))]).reverse();
  const band = upperBand.length > 1 ? `M ${upperBand[0].join(' ')} ${lineCommands(upperBand)} L ${lowerBand[0].join(' ')} ${lineCommands(lowerBand)} Z` : '';
  const label = (bucket: number) => axis === 'hour' ? t("{hour}:00", { hour: bucket }) : axis === 'month' ? new Date(2024, bucket - 1, 1).toLocaleString(language, { month: 'short' }) : String(bucket);
  const detail = metricDetails[metric];
  const drill = (bucket: number) => {
    if (!onExplore) return;
    const kind = axis === 'hour' ? 'hour' : axis === 'month' ? 'month' : 'year';
    onExplore({ kind, [kind]: bucket, metric: 'photos', field: metric,
      favorite_only: segment === 'favorites', geo_only: segment === 'geo', people_only: segment === 'people',
      category: segment === 'camera' ? "Camera" : segment === 'mobile' ? "Mobile device" : undefined });
  };
  return <div className="parameter-chart">
    <div className="parameter-controls"><label>{t("Value")}<select value={metric} onChange={event => { const next = event.target.value as ParameterKey; setMetric(next); setLogScale(next === 'iso'); }}>{Object.entries(metricDetails).map(([key, item]) => <option key={key} value={key}>{t(item.label)}</option>)}</select></label><label>{t("Photos")}<select value={segment} onChange={event => setSegment(event.target.value as ParameterSlice['segment'])}>{Object.entries(segmentDetails).map(([key, name]) => <option key={key} value={key}>{t(name)}</option>)}</select></label><label>{t("Y axis")}<select value={logScale ? "logarithmic scale" : 'linear'} onChange={event => setLogScale(event.target.value === "logarithmic scale")}><option value="linear">{t("Linear")}</option><option value="logarithmic scale">{t("Logarithmic")}</option></select></label><label className="parameter-std"><input type="checkbox" checked={showStd} onChange={event => setShowStd(event.target.checked)} />{t("Standard deviation")}</label></div>
    {values.some(item => item.moment?.mean !== null && item.moment?.mean !== undefined) ? <div className="comparison-scroll"><svg viewBox="0 0 820 270" role="img" aria-label={t("{value} by {axis}", { value: t(detail.label), axis: t(axis === "hour" ? "hour of day" : axis === "month" ? "Month" : "Capture year") })}>
      {[0, .5, 1].map(fraction => <g key={fraction}><line x1="62" x2="758" y1={y(upper * fraction)} y2={y(upper * fraction)} stroke="var(--app-border)" /><text x="55" y={y(upper * fraction) + 4} textAnchor="end" fontSize="10">{fmt(upper * fraction, 0)}</text></g>)}
      {showStd && <path d={band} fill="#9aa8a0" fillOpacity=".28" stroke="none" />}
      <path d={path} fill="none" stroke="var(--plot-primary)" strokeWidth="3.5" strokeLinejoin="round" />
      {values.map((item, index) => item.moment?.mean === null || item.moment?.mean === undefined ? null : <circle key={item.bucket} cx={x(index)} cy={y(item.moment.mean)} r={hover?.bucket === item.bucket ? 9 : 6} fill="var(--plot-primary)" stroke="var(--app-surface)" strokeWidth="2" className={onExplore ? 'parameter-point clickable' : 'parameter-point'} role={onExplore ? 'button' : undefined} tabIndex={onExplore ? 0 : undefined} aria-label={t("{bucket}: view {count} matching photos", { bucket: label(item.bucket), count: fmt(item.moment.count, 0) })} onPointerEnter={event => setHover({ bucket: item.bucket, moment: item.moment!, x: event.clientX, y: event.clientY })} onPointerMove={event => setHover({ bucket: item.bucket, moment: item.moment!, x: event.clientX, y: event.clientY })} onPointerLeave={() => setHover(null)} onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setHover({ bucket: item.bucket, moment: item.moment!, x: rect.left, y: rect.top }); }} onBlur={() => setHover(null)} onClick={() => drill(item.bucket)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); drill(item.bucket); } }}><title>{label(item.bucket)} · Ø {fmt(item.moment.mean)} {detail.unit} · σ {fmt(item.moment.std)} · {fmt(item.moment.count, 0)} {t("Photos")}</title></circle>)}
      {values.map((item, index) => item.moment?.mean === null || item.moment?.mean === undefined ? null : <rect key={`hit-${item.bucket}`} x={x(index) - (buckets.length < 2 ? 40 : 348 / Math.max(1, buckets.length - 1))} y="36" width={buckets.length < 2 ? 80 : 696 / Math.max(1, buckets.length - 1)} height="190" fill="transparent" role={onExplore ? 'button' : undefined} tabIndex={0} aria-label={`${label(item.bucket)}: Ø ${fmt(item.moment.mean)} ${detail.unit}; ${fmt(item.moment.count, 0)} ${t("Photos")}`} onPointerEnter={event => setHover({ bucket: item.bucket, moment: item.moment!, x: event.clientX, y: event.clientY })} onPointerMove={event => setHover({ bucket: item.bucket, moment: item.moment!, x: event.clientX, y: event.clientY })} onPointerLeave={() => setHover(null)} onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setHover({ bucket: item.bucket, moment: item.moment!, x: rect.left, y: rect.top }); }} onBlur={() => setHover(null)} onClick={() => drill(item.bucket)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); drill(item.bucket); } }} />)}
      {buckets.map((bucket, index) => index % Math.max(1, Math.ceil(buckets.length / 12)) === 0 || index === buckets.length - 1 ? <text key={bucket} x={x(index)} y="246" textAnchor="middle" fontSize="10">{label(bucket)}</text> : null)}
      <text x="8" y="18" fontSize="10">{detail.unit}</text>
    </svg></div> : <p className="muted">{t("No dated photos with EXIF data are available for this value and filter.")}</p>}{hover && <FloatingTooltip x={hover.x} y={hover.y} className="chart-tooltip-list"><b>{label(hover.bucket)} · {t(detail.label)}</b><span>Ø {fmt(hover.moment.mean)} {detail.unit}</span><span>σ {fmt(hover.moment.std)} · {fmt(hover.moment.count, 0)} {t("Photos")}</span><small>{t("Click to view matching assets")}</small></FloatingTooltip>}
    <p className="muted tiny">{t("Line = arithmetic mean of photos with this EXIF value; gray band = ±1 population standard deviation. Missing values and undated photos are excluded.")} {onExplore ? t("Click a year to view matching photos from that period.") : ''}</p>
  </div>;
}

function Distribution({ title, points, unit }: { title: string; points: { label: string; count: number }[]; unit: string }) {
  const { t } = useLocale();
  const grouped = useMemo(() => {
    const limits = unit === "Streak days" ? [2, 3, 4, 5, 7, 13] : [1, 2, 6, 13, 29, 89];
    const labels = unit === "Streak days" ? ['2', '3', '4', '5', '6–7', '8–13', '14+'] : ['1', '2', '3–6', '7–13', '14–29', '30–89', '90+'];
    const bins = labels.map(label => ({ label, count: 0 }));
    for (const point of points) {
      const value = Number(point.label);
      const bin = limits.findIndex(limit => value <= limit);
      bins[bin < 0 ? bins.length - 1 : bin].count += point.count;
    }
    return bins.filter(point => point.count > 0);
  }, [points, unit]);
  const max = Math.max(1, ...grouped.map(item => item.count));
  return <div className="rhythm-distribution"><h4>{t(title)}</h4>{grouped.length ? grouped.map(item => <div className="rhythm-bar" key={item.label}><span>{item.label}</span><i><b style={{ width: `${item.count / max * 100}%` }} /></i><strong>{fmt(item.count, 0)}</strong></div>) : <p className="muted tiny">{t(unit === "Streak days" ? "No completed multi-day streaks yet." : "No completed breaks yet.")}</p>}<small>{t(unit)} · {t("Number of phases")}</small></div>;
}

function IndexEvolution({ annual }: { annual: AnnualPhotoProfile[] }) {
  const { t } = useLocale();
  const [selected, setSelected] = useState<IndexKey[]>(['focus', 'habit', 'regularity', 'stability']);
  const [hovered, setHovered] = useState<number | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  if (annual.length < 2) return <p className="muted">{t("The annual comparison appears once at least two capture years are available.")}</p>;
  const x = (index: number) => 52 + index / Math.max(1, annual.length - 1) * 700;
  const y = (value: number) => 225 - value / 100 * 180;
  const labelEvery = Math.max(1, Math.ceil(annual.length / 12));
  const active = hovered === null ? null : annual[hovered];
  const hitWidth = annual.length === 1 ? 80 : Math.min(80, 700 / (annual.length - 1));
  return <><div className="index-toggles">{indexKeys.map(key => <button type="button" key={key} aria-pressed={selected.includes(key)} className={selected.includes(key) ? 'selected' : ''} onClick={() => setSelected(current => current.includes(key) ? current.length > 1 ? current.filter(value => value !== key) : current : indexKeys.filter(value => current.includes(value) || value === key))}><i style={{ background: indexDetails[key].color }} />{t(indexDetails[key].label)}</button>)}</div><div className="comparison-scroll"><svg viewBox="0 0 800 270" role="img" aria-label={t("Annual trend of selected photo profile indices")}>
    <rect x="52" y="45" width="700" height="180" rx="12" fill="var(--app-track)" opacity=".55" />
    <rect x="52" y="135" width="700" height="90" rx="12" fill="var(--app-accent-soft)" opacity=".55" />
    {[0, 25, 50, 75, 100].map(value => <g key={value}><line x1="52" x2="752" y1={y(value)} y2={y(value)} stroke="var(--app-border)" /><text x="45" y={y(value) + 4} textAnchor="end" fontSize="11">{value}</text></g>)}
    {selected.map(key => {
      const path = smoothPath(annual.map((row, index) => { const value = row.profile.indices[key]; return value === null || value === undefined ? null : [x(index), y(value)] as const; }));
      return <g key={key}><path d={path} fill="none" stroke={indexDetails[key].color} strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />{annual.map((row, index) => row.profile.indices[key] === null ? null : <circle key={row.year} cx={x(index)} cy={y(row.profile.indices[key])} r={hovered === index ? 6 : 4} fill={indexDetails[key].color} stroke="var(--app-surface)" strokeWidth="2" />)}</g>;
    })}
    {hovered !== null && <line x1={x(hovered)} x2={x(hovered)} y1="45" y2="225" stroke="var(--app-muted-ink)" strokeDasharray="4 3" pointerEvents="none" />}
    {annual.map((row, index) => index % labelEvery === 0 || index === annual.length - 1 ? <text key={row.year} x={x(index)} y="250" textAnchor="middle" fontSize="11">{row.year}</text> : null)}
    {annual.map((row, index) => <rect key={`hit-${row.year}`} x={x(index) - hitWidth / 2} y="45" width={hitWidth} height="180" fill="transparent" tabIndex={0} aria-label={t("Capture year {year}", { year: row.year })} onPointerMove={event => { setHovered(index); setPointer({ x: event.clientX, y: event.clientY }); }} onPointerLeave={() => setHovered(null)} onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setHovered(index); setPointer({ x: rect.left, y: rect.top }); }} onBlur={() => setHovered(null)} />)}
  </svg></div>{active && <FloatingTooltip x={pointer.x} y={pointer.y} className="chart-tooltip-list"><b>{t("Capture year {year}", { year: active.year })}</b>{selected.map(key => <span key={key}><i style={{ background: indexDetails[key].color }} />{t(indexDetails[key].label)}: {active.profile.indices[key] === null ? '—' : fmt(active.profile.indices[key])}</span>)}</FloatingTooltip>}<p className="muted tiny">{t("Calculated separately for each calendar year. Streaks and breaks are split at year boundaries.")}</p></>;
}

export function PhotoProfilePage({ profile, annual }: { profile: PhotoProfile; annual: AnnualPhotoProfile[] }) {
  const { t } = useLocale();
  const kpis = [
    ['Avg. photos per photo day', profile.photos_per_photo_day, 'Photos'],
    ['Avg. streak length', profile.average_streak_days, 'Days'],
    ['Avg. break between photo days', profile.average_pause_days, 'Days'],
    ['Avg. activity cycle', profile.average_cycle_days, 'Days'],
    ['Avg. photos/day in streaks', profile.photos_per_streak_day, 'Photos'],
    ['Maximum on a streak day', profile.maximum_photos_per_streak_day, 'Photos'],
    ['Streak vs. normal photo day', profile.streak_vs_normal_ratio, '×'],
    ['Photo days in ≥3-day streaks', profile.long_streak_day_percent, '%'],
  ] as const;
  const relations = profile.streak_pause_buckets;
  const maxPause = Math.max(1, ...relations.map(item => item.average_pause_days));
  return <div className="photo-profile-page">
    <section className="panel"><p className="eyebrow">{t("Photo days & rhythm")}</p><h3>{t("Your activity in numbers")}</h3><div className="rhythm-kpis">{kpis.map(([label, value, unit]) => <div key={label}><span>{t(label)}</span><strong>{fmt(value, unit === '×' ? 2 : 1)} <small>{value === null ? '' : t(unit)}</small></strong></div>)}</div><p className="muted tiny">{t("A photo day has at least one photo. A streak contains at least two consecutive photo days; a break counts only complete photo-free days between activity phases. A cycle includes an activity phase, even a single day, followed by its break.")}</p></section>
    <section className="panel"><p className="eyebrow">{t("Distributions")}</p><h3>{t("How long do streaks and breaks last?")}</h3><div className="rhythm-chart-grid"><Distribution title="Streak lengths" points={profile.streak_distribution} unit="Streak days" /><Distribution title="Breaks" points={profile.pause_distribution} unit="Break days" /></div></section>
    <section className="panel"><p className="eyebrow">{t("After a streak")}</p><h3>{t("Intensity and following break")}</h3><p className="muted">{t("Do more photos per streak day lead to a longer break?")}</p><div className="rhythm-chart-grid"><div>{relations.length ? relations.map(item => <div className="rhythm-bar" key={item.label}><span>{item.label}</span><i><b style={{ width: `${item.average_pause_days / maxPause * 100}%` }} /></i><strong>{fmt(item.average_pause_days)} d</strong></div>) : <p className="muted tiny">{t("Completed streaks with a following break are needed for comparison.")}</p>}<small>{t("Photos/day in a streak → avg. break days; streaks of at least two days")}</small></div><div className="rhythm-correlation"><strong>{fmt(profile.streak_pause_correlation, 2)}</strong><span>{t("Pearson correlation")}</span><small>{t("−1: more intense streaks, shorter breaks · 0: no linear relation · +1: longer breaks. Requires at least three evaluable streak-break pairs.")}</small></div></div></section>
    <section className="panel"><p className="eyebrow">{t("Seven indices")}</p><h3>{t("How do you photograph?")}</h3><div className="index-grid">{indexKeys.map(key => <div className="index-card" key={key}><span><i style={{ background: indexDetails[key].color }} />{t(indexDetails[key].label)}</span><strong>{fmt(profile.indices[key])}{profile.indices[key] === null ? '' : ' %'}</strong><div className="index-track"><i style={{ width: `${profile.indices[key] ?? 0}%` }} /></div><small>{t(indexDetails[key].formula)}</small></div>)}</div><p className="muted tiny">{t("Indices describe patterns, not photographic quality. When there are too few photo days or breaks, “—” appears instead of an invented value.")}</p></section>
    <section className="panel"><p className="eyebrow">{t("Over the years")}</p><h3>{t("How does your photo profile change?")}</h3><IndexEvolution annual={annual} /></section>
    <section className="panel"><p className="eyebrow">{t("Regularity")}</p><h3>{t("Streaks ↔ breaks ↔ stability")}</h3><div className="rhythm-triad"><div><span>{t("Avg. streak")}</span><strong>{fmt(profile.average_streak_days)} {t("Days")}</strong></div><div><span>{t("Avg. break")}</span><strong>{fmt(profile.average_pause_days)} {t("Days")}</strong></div><div><span>{t("Stability index")}</span><strong>{fmt(profile.indices.stability)} %</strong></div></div><p className="muted tiny">{t("Stability compares average multi-day streak length with average break length. A high value does not automatically mean more or better photos.")}</p></section>
  </div>;
}
