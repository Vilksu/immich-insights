import { useEffect, useMemo, useRef, useState } from 'react';
import { FloatingTooltip, placeTooltip } from './tooltip';
import { smoothPath } from './smooth-path';
import { displayDeviceName, useLocale } from './i18n';
import { formatNumber } from './number-format';

type Metric = 'assets' | 'photos' | 'videos' | 'geo' | 'people' | 'favorites';
export type AssetFilter = {
  kind: 'asset' | 'device' | 'manufacturer' | 'distribution' | 'date' | 'anniversary' | 'week' | 'week_hour' | 'month' | 'weekday' | 'hour' | 'year' | 'orientation' | 'dimensions';
  asset_id?: string;
  metric?: Metric;
  orientation?: 'portrait' | 'landscape' | 'unknown';
  frame_width?: number;
  frame_height?: number;
  name?: string;
  source?: 'device' | 'manufacturer';
  category?: string;
  raw?: boolean;
  field?: 'iso' | 'focal' | 'aperture' | 'exposure' | 'video' | 'altitude';
  favorite_only?: boolean;
  geo_only?: boolean;
  people_only?: boolean;
  lower?: number;
  upper?: number;
  upper_inclusive?: boolean;
  date?: string;
  start?: string;
  end?: string;
  year?: number;
  scope_year?: number;
  scope_start?: string;
  scope_end?: string;
  month?: number;
  weekday?: number;
  hour?: number;
};
type Explore = (filter: AssetFilter) => void;
export type Day = { date: string; assets: number; photos: number; videos: number; geo: number; people: number; favorites: number };
export type Year = { year: number; label?: string | null; assets: number; photos: number; videos: number; geo: number; people: number; favorites: number; cumulative_assets: number; cumulative_photos: number; cumulative_videos: number; cumulative_geo: number; cumulative_people: number; cumulative_favorites: number; average_asset_bytes: number | null; average_photo_bytes: number | null; average_video_bytes: number | null; average_geo_bytes: number | null; average_people_bytes: number | null; average_favorites_bytes: number | null };
const labels = { assets: "Total", photos: "Photos", videos: "Videos", geo: "With location", people: "With person", favorites: "Favorites" };
const colors = { assets: 'var(--series-0)', photos: 'var(--series-1)', videos: 'var(--series-2)', geo: 'var(--series-3)', people: 'var(--series-4)', favorites: 'var(--series-5)' };
export const qualitativeColor = (index: number, _theme: 'light' | 'dark', pale = false) => pale ? `color-mix(in srgb, var(--series-${index % 10}) 28%, var(--app-surface))` : `var(--series-${index % 10})`;
export const sequentialColor = (intensity: number) => `color-mix(in srgb, var(--app-accent) ${Math.round(18 + Math.max(0, Math.min(1, intensity)) * 82)}%, var(--app-chart-empty))`;
const deviceColor = qualitativeColor;
const fmt = (n: number) => formatNumber(n, { maximumFractionDigits: 2 });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dayMs = 86400000;

export function ComparisonChart({ years, sizes = false, onExplore }: { years: Year[]; sizes?: boolean; onExplore?: Explore }) {
  const { t, language } = useLocale();
  const [selected, setSelected] = useState<Metric[]>(['assets', 'photos', 'videos', 'geo', 'people', 'favorites']);
  const [hover, setHover] = useState<number | null>(null);
  const [scale, setScale] = useState<'linear' | "logarithmic scale">('linear');
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const rowLabel = (row: Year) => row.label && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.label)
    ? new Intl.DateTimeFormat(language, { month: 'short', timeZone: 'UTC' }).format(new Date(`${row.label}-01T00:00:00Z`))
    : row.label ?? String(row.year);
  const value = (y: Year, m: Metric) => sizes ? y[`average_${m === 'assets' ? 'asset' : m === 'photos' ? 'photo' : m === 'videos' ? 'video' : m}_bytes`] : y[`cumulative_${m}`];
  const max = Math.max(1, ...years.flatMap(y => selected.map(m => value(y, m) ?? 0)));
  const x = (i: number) => years.length < 2 ? 400 : 65 + i * 670 / (years.length - 1);
  const y = (n: number) => 220 - (scale === "logarithmic scale" ? Math.log1p(n) / Math.log1p(max) : n / max) * 180;
  return <div>
    <div className="series-toggles">{(Object.keys(colors) as Metric[]).map(m => <label key={m} style={{ color: colors[m] }}><input type="checkbox" checked={selected.includes(m)} onChange={() => setSelected(old => old.includes(m) ? old.filter(a => a !== m) : [...old, m])} />{t(labels[m])}</label>)}<label className="scale-select">{t("Scale")}<select value={scale} onChange={event => setScale(event.target.value as 'linear' | "logarithmic scale")}><option value="linear">{t("Linear")}</option><option value="logarithmic scale">{t("Logarithmic")}</option></select></label></div>
    {hover !== null && years[hover] && <FloatingTooltip x={pointer.x} y={pointer.y} className="chart-tooltip-list"><b>{rowLabel(years[hover])}</b>{selected.map(m => { const n = value(years[hover], m); return <span key={m}><i style={{ background: colors[m] }} />{t(labels[m])}: {n === null ? '—' : fmt(n / (sizes ? 1e6 : 1))}{sizes ? ' MB' : ` · ${fmt(n === null ? 0 : n / Math.max(1, years[hover].cumulative_assets) * 100)} %`}</span>; })}</FloatingTooltip>}
    <div className="comparison-scroll"><svg className="comparison-svg" viewBox="0 0 780 265" role="img" aria-label={t(sizes ? "Average MB per file by capture year" : "Cumulative media by capture year")}>
      {[0, .5, 1].map(f => { const n = scale === "logarithmic scale" ? Math.expm1(Math.log1p(max) * f) : max * f; return <g key={f}><line x1="65" x2="735" y1={y(n)} y2={y(n)} stroke="var(--app-border)" /><text x="58" y={y(n) + 4} textAnchor="end" fontSize="11">{fmt(n / (sizes ? 1e6 : 1))}</text></g>; })}
      {selected.map(m => <g key={m}>
        <path d={smoothPath(years.map((row, i) => { const n = value(row, m); return n === null ? null : [x(i), y(n)] as const; }))} fill="none" stroke={colors[m]} strokeWidth="2.5" />
        {years.map((row, i) => { const n = value(row, m); return n === null ? null : <circle key={row.year} cx={x(i)} cy={y(n)} r={hover === i ? 6 : 4} fill={colors[m]} stroke="var(--app-surface)" strokeWidth="2" tabIndex={0} onFocus={() => setHover(i)} onMouseEnter={() => setHover(i)}><title>{rowLabel(row)} · {t(labels[m])}: {fmt(n / (sizes ? 1e6 : 1))}{sizes ? ` ${t("MB per file")}` : ''}</title></circle>; })}
      </g>)}
      {years.map((row, i) => (i === 0 || i === years.length - 1 || i % Math.max(1, Math.ceil(years.length / 8)) === 0) && <text key={row.year} x={x(i)} y="247" textAnchor="middle" fontSize="12">{rowLabel(row)}</text>)}
      {years.map((row, i) => <rect key={`hit-${row.year}`} x={x(i) - (years.length < 2 ? 40 : Math.min(24, 330 / (years.length - 1)))} y="35" width={years.length < 2 ? 80 : Math.min(48, 660 / (years.length - 1))} height="190" fill="transparent" tabIndex={0} role={onExplore ? 'button' : undefined} aria-label={t("{year}: view values", { year: rowLabel(row) })} onMouseEnter={event => { setHover(i); setPointer({ x: event.clientX, y: event.clientY }); }} onMouseMove={event => setPointer({ x: event.clientX, y: event.clientY })} onMouseLeave={() => setHover(null)} onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setHover(i); setPointer({ x: rect.left, y: rect.top }); }} onBlur={() => setHover(null)} onClick={() => onExplore?.({ kind: 'year', year: row.year })} onKeyDown={event => { if (event.key === 'Enter' && onExplore) onExplore({ kind: 'year', year: row.year }); }} />)}
    </svg></div>
  </div>;
}

function heatColor(count: number, max: number, scale: 'linear' | "logarithmic scale" | 'presence') {
  const intensity = max > 0 ? scale === "logarithmic scale" ? Math.log1p(count) / Math.log1p(max) : count / max : 0;
  return count === 0 ? 'var(--app-chart-empty)' : scale === 'presence' ? 'var(--app-accent)' : sequentialColor(intensity);
}
function heatLegendBackground(max: number, scale: 'linear' | "logarithmic scale" | 'presence') {
  if (scale === 'presence') return 'linear-gradient(90deg,var(--app-chart-empty) 0 14%,var(--app-accent) 14% 100%)';
  if (max <= 1) return 'linear-gradient(90deg,var(--app-chart-empty) 0 45%,var(--app-accent) 45% 100%)';
  return `linear-gradient(90deg,${Array.from({ length: 21 }, (_, index) => {
    const position = index / 20;
    const intensity = scale === "logarithmic scale" ? Math.log1p(max * position) / Math.log1p(max) : position;
    const color = index === 0 ? 'var(--app-chart-empty)' : sequentialColor(intensity);
    return `${color} ${index * 5}%`;
  }).join(',')})`;
}
function dominanceLegend(mode: Dominance) {
  if (mode === 'orientation') return { background: 'linear-gradient(90deg,var(--app-chart-empty) 0 12%,var(--series-0) 12% 40%,var(--series-5) 40% 60%,var(--series-1) 60% 100%)', text: "Empty · portrait · tie · landscape" };
  if (mode === 'media') return { background: 'linear-gradient(90deg,var(--app-chart-empty) 0 12%,var(--series-0) 12% 40%,var(--series-5) 40% 60%,var(--series-2) 60% 100%)', text: "Empty · photo · tie · video" };
  return { background: 'linear-gradient(90deg,var(--app-chart-empty) 0 12%,var(--series-0) 12% 40%,var(--series-5) 40% 60%,var(--series-1) 60% 100%)', text: "Empty · mobile device · tie · camera" };
}
function Tile({ count, max, text, scale, color: chosenColor, onClick }: { count: number; max: number; text: string; scale: 'linear' | "logarithmic scale" | 'presence'; color?: string; onClick?: () => void }) {
  const color = chosenColor ?? heatColor(count, max, scale);
  const props = { className: 'tiny-tile', style: { backgroundColor: color }, 'data-empty': count === 0 ? 'true' : undefined, 'data-tooltip': `${text}: ${fmt(count)}`, 'aria-label': `${text}: ${fmt(count)}` };
  return onClick ? <button type="button" {...props} onClick={onClick} /> : <span tabIndex={0} {...props} />;
}

export type HeatSlice = { date: string; hour: number; device: string; manufacturer: string; raw_manufacturer: string; category: string; orientation: string; media: string; assets: number; photos: number; videos: number; geo: number; people: number; favorites: number };
type HeatGroup = 'all' | 'device' | 'manufacturer' | 'raw_manufacturer';
type Dominance = 'none' | 'device' | 'orientation' | 'media';
type HeatSettings = { metric: Metric; scale: 'linear' | "logarithmic scale" | 'presence'; group: HeatGroup; name: string; dominance: Dominance };
type HeatBucket = { count: number; left: number; right: number };
const emptyHeatBucket = (): HeatBucket => ({ count: 0, left: 0, right: 0 });
function heatWinner(bucket: HeatBucket, mode: Dominance): { color: string; label: string; filter: Partial<AssetFilter> } {
  if (mode === 'none' || bucket.left + bucket.right === 0) return { color: 'var(--app-chart-empty)', label: "Unassigned", filter: {} };
  if (bucket.left === bucket.right) return { color: 'var(--series-5)', label: "Tie", filter: {} };
  const left = bucket.left > bucket.right;
  if (mode === 'device') return left ? { color: 'var(--series-0)', label: "Mobile device", filter: { category: "Mobile device" } } : { color: 'var(--series-1)', label: "Camera", filter: { category: "Camera" } };
  if (mode === 'orientation') return left ? { color: 'var(--series-0)', label: "Portrait", filter: { orientation: 'portrait' } } : { color: 'var(--series-1)', label: "Landscape", filter: { orientation: 'landscape' } };
  return left ? { color: 'var(--series-0)', label: "Photo", filter: { metric: 'photos' } } : { color: 'var(--series-2)', label: "Video", filter: { metric: 'videos' } };
}
function heatTotals(slices: HeatSlice[], keyOf: (row: HeatSlice) => string, settings: HeatSettings): Map<string, HeatBucket> {
  const result = new Map<string, HeatBucket>();
  for (const row of slices) {
    const key = keyOf(row);
    const bucket = result.get(key) ?? emptyHeatBucket();
    bucket.count += row[settings.metric];
    if (settings.dominance === 'device') { bucket.left += row.category === "Mobile device" ? row.assets : 0; bucket.right += row.category === "Camera" ? row.assets : 0; }
    if (settings.dominance === 'orientation') { bucket.left += row.orientation === 'portrait' ? row.assets : 0; bucket.right += row.orientation === 'landscape' ? row.assets : 0; }
    if (settings.dominance === 'media') { bucket.left += row.photos; bucket.right += row.videos; }
    result.set(key, bucket);
  }
  return result;
}
function HeatControls({ slices, settings, setSettings, allowPresence = false }: { slices: HeatSlice[]; settings: HeatSettings; setSettings: (value: HeatSettings) => void; allowPresence?: boolean }) {
  const { t } = useLocale();
  const options = useMemo(() => {
    if (settings.group === 'all') return [];
    const group = settings.group;
    return [...new Set(slices.map(row => row[group]))].sort((a, b) => a.localeCompare(b, 'de'));
  }, [slices, settings.group]);
  return <div className="heat-controls"><div className="series-toggles">{(Object.keys(labels) as Metric[]).map(metric => <button type="button" key={metric} className={settings.metric === metric ? 'primary' : 'secondary'} onClick={() => setSettings({ ...settings, metric })}>{t(labels[metric])}</button>)}</div><div className="heat-facets"><label>{t("Selection")}<select value={settings.group} onChange={event => setSettings({ ...settings, group: event.target.value as HeatGroup, name: '' })}><option value="all">{t("All devices")}</option><option value="device">{t("Device")}</option><option value="manufacturer">{t("Manufacturer · grouped")}</option><option value="raw_manufacturer">{t("Manufacturer · individual")}</option></select></label>{settings.group !== 'all' && <label>{t(settings.group === "device" ? "Device" : "Manufacturer")}<select value={settings.name} onChange={event => setSettings({ ...settings, name: event.target.value })}><option value="">{t("All")}</option>{options.map(name => <option key={name} value={name}>{displayDeviceName(name, t)}</option>)}</select></label>}<label>{t("Color mode")}<select value={settings.dominance} onChange={event => setSettings({ ...settings, dominance: event.target.value as Dominance })}><option value="none">{t("Count")}</option><option value="device">{t("Mobile device ↔ camera")}</option><option value="orientation">{t("Portrait ↔ landscape")}</option><option value="media">{t("Photo ↔ video")}</option></select></label>{settings.dominance === 'none' && <label>{t("Scale")}<select value={settings.scale} onChange={event => setSettings({ ...settings, scale: event.target.value as HeatSettings['scale'] })}><option value="linear">{t("Linear")}</option><option value="logarithmic scale">{t("Logarithmic")}</option>{allowPresence && <option value="presence">{t("Activity only")}</option>}</select></label>}</div></div>;
}
function selectedHeatSlices(slices: HeatSlice[], settings: HeatSettings): HeatSlice[] {
  if (settings.group === 'all' || !settings.name) return slices;
  const group = settings.group;
  return slices.filter(row => row[group] === settings.name);
}
function heatQuery(settings: HeatSettings, bucket: HeatBucket): Partial<AssetFilter> {
  const source: AssetFilter['source'] = settings.group === 'device' ? 'device' : settings.group === 'all' ? undefined : 'manufacturer';
  const selected: Partial<AssetFilter> = settings.name ? { source, name: settings.name, raw: settings.group === 'raw_manufacturer' } : {};
  return { metric: settings.dominance === 'none' ? settings.metric : 'assets', ...selected, ...(settings.dominance === 'none' ? {} : heatWinner(bucket, settings.dominance).filter) };
}
function AnniversaryMatrix({ months, values, settings, max, onExplore }: { months: string[]; values: Map<string, HeatBucket>; settings: HeatSettings; max: number; onExplore?: Explore }) {
  const { t } = useLocale();
  return <div className="anniversary-matrix">
    <div className="anniversary-months"><span />{months.map((month, index) => <strong key={index}>{month}</strong>)}</div>
    {Array.from({ length: 31 }, (_, index) => <div className="anniversary-row" key={index}>
      <strong>{index + 1}</strong>{months.map((_, monthIndex) => {
        const date = new Date(Date.UTC(2024, monthIndex, index + 1));
        if (date.getUTCMonth() !== monthIndex) return <span key={monthIndex} />;
        const key = iso(date).slice(5);
        const bucket = values.get(key) ?? emptyHeatBucket();
        const winner = heatWinner(bucket, settings.dominance);
        const detail = settings.dominance === 'none' ? t(labels[settings.metric]) : t(winner.label) + ` (${fmt(bucket.left)} : ${fmt(bucket.right)})`;
        return <Tile key={monthIndex} count={bucket.count} max={max} scale={settings.scale} color={settings.dominance === 'none' ? undefined : winner.color} text={`${String(index + 1).padStart(2, '0')}.${String(monthIndex + 1).padStart(2, '0')}. · ${t("all capture years")} · ${detail}`} onClick={onExplore ? () => onExplore({ kind: 'anniversary', date: key, ...heatQuery(settings, bucket) }) : undefined} />;
      })}
    </div>)}
  </div>;
}
export function CalendarHeatmap({ days, slices, year, anniversary = false, onExplore }: { days: Day[]; slices: HeatSlice[]; year?: number; anniversary?: boolean; onExplore?: Explore }) {
  const { t, language } = useLocale();
  const [settings, setSettings] = useState<HeatSettings>({ metric: 'assets', scale: 'linear', group: 'all', name: '', dominance: 'none' });
  const tooltip = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => selectedHeatSlices(slices, settings), [slices, settings.group, settings.name]);
  const { values, weekly, max, weekMax, years } = useMemo(() => {
    const values = heatTotals(filtered, row => anniversary ? row.date.slice(5) : row.date, settings);
    const weekly = !anniversary && !year ? heatTotals(filtered, row => {
      const taken = new Date(`${row.date}T00:00:00Z`);
      const monday = new Date(taken.getTime() - ((taken.getUTCDay() + 6) % 7) * dayMs);
      return `${row.date.slice(0, 4)}:${iso(monday)}`;
    }, settings) : new Map<string, HeatBucket>();
    const peak = (map: Map<string, HeatBucket>) => [...map.values()].reduce((best, row) => Math.max(best, row.count), 0);
    return { values, weekly, max: peak(values), weekMax: peak(weekly), years: [...new Set(days.map(row => Number(row.date.slice(0, 4))))].sort((a, b) => a - b) };
  }, [filtered, days, settings.metric, settings.dominance, anniversary, year]);
  const showTooltip = (target: EventTarget, x?: number, y?: number) => {
    const tile = target instanceof Element ? target.closest<HTMLElement>('.tiny-tile') : null;
    const tip = tooltip.current;
    if (!tip || !tile?.dataset.tooltip) { if (tip) tip.hidden = true; return; }
    tip.textContent = tile.dataset.tooltip;
    tip.hidden = false;
    const rect = tile.getBoundingClientRect();
    placeTooltip(tip, x ?? rect.left, y ?? rect.bottom);
  };
  const calendarYear = anniversary ? 2024 : year;
  const months = Array.from({ length: 12 }, (_, index) => new Intl.DateTimeFormat(language, { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, index, 1))));
  const weekdays = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(language, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index))));
  const displayDate = (value: string) => value.length === 10 ? `${value.slice(8)}.${value.slice(5, 7)}.${value.slice(0, 4)}` : `${value.slice(3, 5)}.${value.slice(0, 2)}.`;
  const weekRows = years.length ? Array.from({ length: years.at(-1)! - years[0] + 1 }, (_, i) => years[0] + i) : [];
  const cell = (d: Date) => values.get(anniversary ? iso(d).slice(5) : iso(d)) ?? emptyHeatBucket();
  const calendar = calendarYear ? Array.from({ length: (Date.UTC(calendarYear + 1, 0, 1) - Date.UTC(calendarYear, 0, 1)) / dayMs }, (_, i) => new Date(Date.UTC(calendarYear, 0, 1) + i * dayMs)) : [];
  const offset = calendarYear ? (new Date(Date.UTC(calendarYear, 0, 1)).getUTCDay() + 6) % 7 : 0;
  return <section className="panel" onPointerMove={event => showTooltip(event.target, event.clientX, event.clientY)} onPointerLeave={() => { if (tooltip.current) tooltip.current.hidden = true; }} onFocusCapture={event => showTooltip(event.target)} onBlurCapture={() => { if (tooltip.current) tooltip.current.hidden = true; }}>
    <p className="eyebrow">{t(anniversary ? "Anniversaries" : year ? "Year overview" : "Library over time")}</p>
    <h3>{anniversary ? t("On which day of the year do you capture media?") : year ? t("Capture calendar {year}", { year }) : t("Your entire library by week")}</h3>
    <HeatControls slices={slices} settings={settings} setSettings={setSettings} allowPresence />
    <div className="calendar-scroll">{anniversary ? <AnniversaryMatrix months={months} values={values} settings={settings} max={max} onExplore={onExplore} /> : calendarYear ? <>
      <div className="month-labels">{months.map((month, index) => <span key={index}>{month}</span>)}</div>
      <div className="daily-layout"><div className="day-labels">{weekdays.map((day, index) => <span key={index}>{day}</span>)}</div><div className="daily-grid">
        {Array.from({ length: offset }, (_, i) => <span key={i} />)}
        {calendar.map(d => { const bucket = cell(d); const winner = heatWinner(bucket, settings.dominance); return <Tile key={iso(d)} count={bucket.count} max={max} scale={settings.scale} color={settings.dominance === 'none' ? undefined : winner.color} text={`${anniversary ? displayDate(iso(d).slice(5)) + ` · ${t("all capture years")}` : displayDate(iso(d))} · ${settings.dominance === 'none' ? t(labels[settings.metric]) : `${t(winner.label)} (${fmt(bucket.left)} : ${fmt(bucket.right)})`}`} onClick={onExplore ? () => onExplore({ kind: anniversary ? 'anniversary' : 'date', date: anniversary ? iso(d).slice(5) : iso(d), ...heatQuery(settings, bucket) }) : undefined} />; })}
      </div></div>
    </> : <div className="weekly-matrix">{weekRows.map(yr => {
      // Calendar-year rows: boundary weeks are clipped to that year (53/54 when needed).
      const jan = new Date(Date.UTC(yr, 0, 1));
      const first = new Date(jan.getTime() - ((jan.getUTCDay() + 6) % 7) * dayMs);
      const weeks = Math.ceil((Date.UTC(yr + 1, 0, 1) - first.getTime()) / (7 * dayMs));
      return <div className="week-row" key={yr}><b>{yr}</b>{Array.from({ length: weeks }, (_, w) => {
        const start = new Date(first.getTime() + w * 7 * dayMs);
        const end = new Date(start.getTime() + 6 * dayMs);
        const bucket = weekly.get(`${yr}:${iso(start)}`) ?? emptyHeatBucket();
        const winner = heatWinner(bucket, settings.dominance);
        const from = start < jan ? iso(jan) : iso(start);
        const to = end.getUTCFullYear() > yr ? `${yr}-12-31` : iso(end);
        return <Tile key={w} count={bucket.count} max={weekMax} scale={settings.scale} color={settings.dominance === 'none' ? undefined : winner.color} text={`${displayDate(from)} ${t("to")} ${displayDate(to)} · ${settings.dominance === 'none' ? `${t(labels[settings.metric])}: ${fmt(bucket.count)}` : `${t(winner.label)} (${fmt(bucket.left)} : ${fmt(bucket.right)})`}${settings.name ? ` · ${settings.name}` : ''}`} onClick={onExplore ? () => onExplore({ kind: 'week', start: from, end: to, ...heatQuery(settings, bucket) }) : undefined} />;
      })}</div>;
    })}</div>}</div>
    <div className="heat-legend"><span>0</span><i style={{ background: settings.dominance !== 'none' ? dominanceLegend(settings.dominance).background : heatLegendBackground(anniversary || year ? max : weekMax, settings.scale) }} /><span>{settings.dominance !== 'none' ? t(dominanceLegend(settings.dominance).text) : settings.scale === 'presence' ? t("Accent color = at least one capture") : t("{max} · {scale} · strongest color = maximum", { max: fmt(anniversary || year ? max : weekMax), scale: t(settings.scale === "logarithmic scale" ? "logarithmic" : "linear") })}</span></div>
    {(anniversary || year) && <p className="muted tiny">{t(anniversary ? "Values summed over all capture years; February 29 remains a separate day." : "Monday to Sunday; exactly one cell per day.")}</p>}
    <div ref={tooltip} className="heat-tooltip" role="tooltip" hidden />
  </section>;
}

export type WeekHour = { weekday: number; hour: number; assets: number; photos: number; videos: number; geo: number; people: number; favorites: number };
export function WeekHourHeatmap({ slices, onExplore }: { slices: HeatSlice[]; onExplore?: Explore }) {
  const { t, language } = useLocale();
  const [settings, setSettings] = useState<HeatSettings>({ metric: 'assets', scale: 'linear', group: 'all', name: '', dominance: 'none' });
  const tooltip = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => selectedHeatSlices(slices, settings), [slices, settings.group, settings.name]);
  const bySlot = useMemo(() => heatTotals(filtered, row => String(row.hour * 7 + (new Date(`${row.date}T00:00:00Z`).getUTCDay() + 6) % 7), settings), [filtered, settings.metric, settings.dominance]);
  const max = [...bySlot.values()].reduce((best, row) => Math.max(best, row.count), 0);
  const weekdays = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(language, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index))));
  const shortWeekdays = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(language, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index))));
  const showTooltip = (target: EventTarget, x?: number, y?: number) => {
    const tile = target instanceof Element ? target.closest<HTMLElement>('.tiny-tile') : null;
    const tip = tooltip.current;
    if (!tip || !tile?.dataset.tooltip) { if (tip) tip.hidden = true; return; }
    tip.textContent = tile.dataset.tooltip;
    tip.hidden = false;
    const rect = tile.getBoundingClientRect();
    placeTooltip(tip, x ?? rect.left, y ?? rect.bottom);
  };
  return <section className="panel" onPointerMove={event => showTooltip(event.target, event.clientX, event.clientY)} onPointerLeave={() => { if (tooltip.current) tooltip.current.hidden = true; }} onFocusCapture={event => showTooltip(event.target)} onBlurCapture={() => { if (tooltip.current) tooltip.current.hidden = true; }}>
    <p className="eyebrow">{t("Rhythm")}</p><h3>{t("Hours of a typical week")}</h3>
    <HeatControls slices={slices} settings={settings} setSettings={setSettings} allowPresence />
    <div className="week-hour-scroll"><div className="week-hour-chart"><div /><div className="week-hour-header">{weekdays.map((day, index) => <b key={day}><span className="weekday-full">{day}</span><span className="weekday-short">{shortWeekdays[index]}</span></b>)}</div>{Array.from({ length: 24 }, (_, hour) => <div className="week-hour-row" key={hour}><span>{String(hour).padStart(2, '0')}:00</span><div>{weekdays.map((day, weekday) => { const bucket = bySlot.get(String(hour * 7 + weekday)) ?? emptyHeatBucket(); const winner = heatWinner(bucket, settings.dominance); return <Tile key={day} count={bucket.count} max={max} scale={settings.scale} color={settings.dominance === 'none' ? undefined : winner.color} text={`${day} ${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00 · ${settings.dominance === 'none' ? t(labels[settings.metric]) : `${t(winner.label)} (${fmt(bucket.left)} : ${fmt(bucket.right)})`}`} onClick={onExplore ? () => onExplore({ kind: 'week_hour', weekday, hour, ...heatQuery(settings, bucket) }) : undefined} />; })}</div></div>)}</div></div>
    <div className="heat-legend"><span>0</span><i style={{ background: settings.dominance !== 'none' ? dominanceLegend(settings.dominance).background : heatLegendBackground(max, settings.scale) }} /><span>{settings.dominance !== 'none' ? t(dominanceLegend(settings.dominance).text) : settings.scale === 'presence' ? t("Accent color = at least one capture") : t("{max} · {scale} · strongest color = maximum", { max: fmt(max), scale: t(settings.scale === "logarithmic scale" ? "logarithmic" : "linear") })}</span></div>
    <p className="muted tiny">{t("All capture years in the selected period combined; each cell counts media captured in that weekday-hour.")}</p>
    <div ref={tooltip} className="heat-tooltip" role="tooltip" hidden />
  </section>;
}

type Device = { name: string; manufacturer: string; manufacturer_variants: string[]; category: string; count: number; photos: number; videos: number; geo: number; people: number; favorites: number };
export function DeviceChart({ devices, rawManufacturers = [], onExplore, theme }: { devices: Device[]; rawManufacturers?: Device[]; onExplore?: Explore; theme: 'light' | 'dark' }) {
  const { t } = useLocale();
  const [view, setView] = useState<'donut' | 'area'>('donut');
  const [metric, setMetric] = useState<Metric>('assets');
  const [group, setGroup] = useState<'device' | 'manufacturer'>('device');
  const [category, setCategory] = useState<'all' | "Mobile device" | "Camera" | "Other">('all');
  const [mergeMakers, setMergeMakers] = useState(true);
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoverPoint, setHoverPoint] = useState({ x: 0, y: 0 });
  const matching = devices.filter(d => category === 'all' || d.category === category);
  const byMaker = new Map<string, Device>();
  if (group === 'manufacturer') for (const d of matching) {
    const row = byMaker.get(d.manufacturer) ?? { name: d.manufacturer, manufacturer: d.manufacturer, manufacturer_variants: [], category: d.category, count: 0, photos: 0, videos: 0, geo: 0, people: 0, favorites: 0 };
    row.count += d.count; row.photos += d.photos; row.videos += d.videos; row.geo += d.geo; row.people += d.people; row.favorites += d.favorites;
    row.manufacturer_variants = [...new Set([...row.manufacturer_variants, ...(d.manufacturer_variants ?? [])])].sort();
    byMaker.set(d.manufacturer, row);
  }
  const makerRows = mergeMakers ? [...byMaker.values()] : rawManufacturers.filter(d => category === 'all' || d.category === category);
  const ranked = (group === 'device' ? matching : makerRows).map(d => ({ ...d, assets: d.count })).filter(d => d[metric] > 0).sort((a, b) => b[metric] - a[metric]);
  const known = ranked.filter(d => d.name !== "Unknown manufacturer" && d.name !== "Unknown device").slice(0, 3);
  const total = ranked.reduce((sum, d) => sum + d[metric], 0);
  const active = ranked.find(d => d.name === hovered);
  const openDevice = (d: Device) => onExplore?.({ kind: group === 'device' ? 'device' : 'manufacturer', name: d.name, category, metric, raw: group === 'manufacturer' && !mergeMakers });
  const activeModels = group === 'manufacturer' && active ? matching.filter(d => d.manufacturer === active.name).sort((a, b) => b.count - a.count).slice(0, 4).map(d => d.name) : [];
  let offset = 0;
  return <div>
    <div className="device-view-switch segmented"><button type="button" className={view === 'donut' ? 'selected' : ''} onClick={() => setView('donut')}>{t("Donut chart")}</button><button type="button" className={view === 'area' ? 'selected' : ''} onClick={() => { setView('area'); setGroup('manufacturer'); setMergeMakers(true); setHovered(null); }}>{t("Area comparison")}</button></div>
    <div className="device-controls">{view === 'donut' && <div className="segmented"><button className={group === 'device' ? 'selected' : ''} onClick={() => { setGroup('device'); setHovered(null); }}>{t("Device")}</button><button className={group === 'manufacturer' ? 'selected' : ''} onClick={() => { setGroup('manufacturer'); setHovered(null); }}>{t("Manufacturer")}</button></div>}<label>{t("Category")}<select value={category} onChange={event => { setCategory(event.target.value as typeof category); setHovered(null); }}><option value="all">{t("All devices")}</option><option value="Mobile device">{t("Mobile device (phone/tablet/iPod)")}</option><option value="Camera">{t("Camera")}</option><option value="Other">{t("Other / unknown")}</option></select></label>{view === 'donut' && group === 'manufacturer' && <button type="button" className="secondary" onClick={() => { setMergeMakers(value => !value); setHovered(null); }}>{t(mergeMakers ? "Separate names" : "Merge names")}</button>}</div>
    <div className="series-toggles">{(Object.keys(labels) as Metric[]).map(m => <button key={m} className={metric === m ? 'primary' : 'secondary'} onClick={() => { setMetric(m); setHovered(null); }}>{t(labels[m])}</button>)}</div>
    {total === 0 ? <p className="muted">{t("No captures for this filter.")}</p> : <>
      <div className="podium">{[1, 0, 2].map(i => known[i] && <button type="button" key={i} className={`place place-${i + 1}`} onClick={() => openDevice(known[i])}><b>{t("Place")} {i + 1}</b><span>{displayDeviceName(known[i].name, t)}</span><small>{fmt(known[i][metric])} {t("Captures")}</small></button>)}</div>
      {view === 'donut' ? <div className="donut-layout"><svg viewBox="0 0 220 220" className="donut" role="img" aria-label={t("Captures by device: {metric}", { metric: t(labels[metric]) })}>{ranked.map((d, i) => {
        const fraction = d[metric] / total;
        const start = offset; offset += fraction;
        return <circle key={d.name} cx="110" cy="110" r="75" fill="none" stroke={deviceColor(i, theme)} strokeWidth={hovered === d.name ? 39 : 32} pathLength="1" strokeDasharray={`${fraction} ${1 - fraction}`} strokeDashoffset={-start} transform="rotate(-90 110 110)" tabIndex={0} role={onExplore ? 'button' : undefined} aria-label={`${displayDeviceName(d.name, t)}: ${fmt(d[metric])} ${t(labels[metric])}, ${fmt(fraction * 100)} ${t("percent")}`} onClick={() => openDevice(d)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDevice(d); } }} onMouseEnter={event => { setHovered(d.name); setHoverPoint({ x: event.clientX, y: event.clientY }); }} onMouseMove={event => setHoverPoint({ x: event.clientX, y: event.clientY })} onMouseLeave={() => setHovered(null)} onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setHovered(d.name); setHoverPoint({ x: rect.left, y: rect.top }); }} onBlur={() => setHovered(null)} />;
      })}<text x="110" y="114" textAnchor="middle">{fmt(total)}</text></svg><div className="donut-legend">{ranked.map((d, i) => <button type="button" key={d.name} onClick={() => openDevice(d)} onMouseEnter={event => { setHovered(d.name); setHoverPoint({ x: event.clientX, y: event.clientY }); }} onMouseMove={event => setHoverPoint({ x: event.clientX, y: event.clientY })} onMouseLeave={() => setHovered(null)} onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setHovered(d.name); setHoverPoint({ x: rect.left, y: rect.top }); }} onBlur={() => setHovered(null)} className={hovered === d.name ? 'highlighted' : ''}><i style={{ background: deviceColor(i, theme) }} /><span>{displayDeviceName(d.name, t)}</span><b>{fmt(d[metric])}</b></button>)}</div></div> : <CameraTreemap devices={devices} onExplore={onExplore} theme={theme} metricOverride={metric} categoryOverride={category} showControls={false} />}
      {view === 'donut' && active && <FloatingTooltip x={hoverPoint.x} y={hoverPoint.y} className="chart-tooltip-list"><b>{displayDeviceName(active.name, t)}</b><span>{fmt(active[metric])} {t(labels[metric])} · {fmt(active[metric] / total * 100)} %</span>{activeModels.length > 0 && <small>{t("Models")}: {activeModels.map(name => displayDeviceName(name, t)).join(', ')}</small>}{group === 'manufacturer' && active.manufacturer_variants.length > 1 && <small>{t("EXIF names")}: {active.manufacturer_variants.join(', ')}</small>}</FloatingTooltip>}
      {view === 'donut' && group === 'manufacturer' && mergeMakers && <details className="manufacturer-aliases"><summary>{t("Which EXIF manufacturer names were merged?")}</summary><div>{ranked.map(d => <p key={d.name}><b>{displayDeviceName(d.name, t)}</b><span>{d.manufacturer_variants.join(' · ')}</span></p>)}</div></details>}
    </>}
  </div>;
}

type TreeBox = { x: number; y: number; width: number; height: number };
function splitTreemap<T extends { size: number }>(items: T[], box: TreeBox): { item: T; box: TreeBox }[] {
  if (!items.length || box.width <= 0 || box.height <= 0) return [];
  if (items.length === 1) return [{ item: items[0], box }];
  const total = items.reduce((sum, item) => sum + item.size, 0);
  let leftSize = 0, cut = 0;
  while (cut < items.length - 1 && (cut === 0 || leftSize < total / 2)) leftSize += items[cut++].size;
  const fraction = leftSize / total;
  const vertical = box.width >= box.height;
  const first = vertical ? { ...box, width: box.width * fraction } : { ...box, height: box.height * fraction };
  const second = vertical ? { x: box.x + first.width, y: box.y, width: box.width - first.width, height: box.height }
    : { x: box.x, y: box.y + first.height, width: box.width, height: box.height - first.height };
  return [...splitTreemap(items.slice(0, cut), first), ...splitTreemap(items.slice(cut), second)];
}

export function CameraTreemap({ devices, onExplore, theme, metricOverride, categoryOverride, showControls = true }: { devices: Device[]; onExplore?: Explore; theme: 'light' | 'dark'; metricOverride?: Metric; categoryOverride?: string; showControls?: boolean }) {
  const { t } = useLocale();
  const [localMetric, setMetric] = useState<Metric>('assets');
  const [localCategory, setCategory] = useState('all');
  const metric = metricOverride ?? localMetric;
  const category = categoryOverride ?? localCategory;
  const [hovered, setHovered] = useState<{ title: string; size: number; x: number; y: number } | null>(null);
  const sizeOf = (device: Device) => metric === 'assets' ? device.count : device[metric];
  const groups = useMemo(() => {
    const makers = new Map<string, { size: number; devices: Device[] }>();
    for (const device of devices) {
      if ((category !== 'all' && category !== device.category) || sizeOf(device) <= 0) continue;
      const maker = device.manufacturer || "Unknown manufacturer";
      const group = makers.get(maker) ?? { size: 0, devices: [] };
      group.size += sizeOf(device);
      group.devices.push(device);
      makers.set(maker, group);
    }
    return [...makers].map(([name, value]) => ({ name, ...value })).sort((a, b) => b.size - a.size);
  }, [devices, category, metric]);
  const total = groups.reduce((sum, group) => sum + group.size, 0);
  const boxes = splitTreemap(groups, { x: 0, y: 0, width: 900, height: 450 });
  const show = (event: React.PointerEvent<SVGElement>, title: string, size: number) => setHovered({ title, size, x: event.clientX, y: event.clientY });
  return <div className="camera-treemap">{showControls && <div className="streamgraph-options"><span>{t("Area = number of {metric}", { metric: t(labels[metric]) })}</span><label>{t("Metric")}<select value={metric} onChange={event => setMetric(event.target.value as Metric)}>{(Object.keys(labels) as Metric[]).map(value => <option key={value} value={value}>{t(labels[value])}</option>)}</select></label><label>{t("Device type")}<select value={category} onChange={event => setCategory(event.target.value)}><option value="all">{t("All")}</option><option value="Camera">{t("Cameras")}</option><option value="Mobile device">{t("Mobile devices")}</option><option value="Other">{t("Other")}</option></select></label></div>}
    {total === 0 ? <p className="muted">{t("No matching devices available.")}</p> : <div className="treemap-wrap"><svg viewBox="0 0 900 450" role="img" aria-label={t("Treemap of manufacturers and devices by {metric}", { metric: t(labels[metric]) })} onPointerLeave={() => setHovered(null)}>{boxes.map(({ item: maker, box }, makerIndex) => {
      const labelHeight = box.height >= 35 && box.width >= 75 ? 23 : 0;
      const inner = { x: box.x + 2, y: box.y + labelHeight, width: Math.max(0, box.width - 4), height: Math.max(0, box.height - labelHeight - 2) };
      const devicesBySize = maker.devices.map(device => ({ device, size: sizeOf(device) })).sort((a, b) => b.size - a.size);
      return <g key={maker.name}><rect x={box.x + 1} y={box.y + 1} width={Math.max(0, box.width - 2)} height={Math.max(0, box.height - 2)} rx="4" fill={deviceColor(makerIndex, theme, true)} style={{ '--area-color': deviceColor(makerIndex, theme, true) } as React.CSSProperties} stroke={theme === 'dark' ? '#17271d' : '#fff'} strokeWidth="2" role={onExplore ? 'button' : undefined} tabIndex={0} onPointerMove={event => show(event, displayDeviceName(maker.name, t), maker.size)} onFocus={() => setHovered({ title: displayDeviceName(maker.name, t), size: maker.size, x: 30, y: 30 })} onClick={() => onExplore?.({ kind: 'manufacturer', name: maker.name, metric, category: category === 'all' ? undefined : category })} />{labelHeight > 0 && <text x={box.x + 8} y={box.y + 17} fontSize="12" fontWeight="700" pointerEvents="none">{displayDeviceName(maker.name, t)} · {fmt(maker.size)}</text>}
        {splitTreemap(devicesBySize, inner).map(({ item, box: child }, index) => <g key={item.device.name}><rect x={child.x + 1} y={child.y + 1} width={Math.max(0, child.width - 2)} height={Math.max(0, child.height - 2)} rx="3" fill={deviceColor(makerIndex + index, theme)} style={{ '--area-color': deviceColor(makerIndex + index, theme) } as React.CSSProperties} stroke={theme === 'dark' ? '#17271d' : '#fff'} strokeWidth="1" role={onExplore ? 'button' : undefined} tabIndex={0} aria-label={`${displayDeviceName(maker.name, t)} · ${displayDeviceName(item.device.name, t)}: ${fmt(item.size)} ${t(labels[metric])}`} onPointerMove={event => show(event, `${displayDeviceName(maker.name, t)} · ${displayDeviceName(item.device.name, t)}`, item.size)} onFocus={() => setHovered({ title: `${displayDeviceName(maker.name, t)} · ${displayDeviceName(item.device.name, t)}`, size: item.size, x: 30, y: 30 })} onClick={() => onExplore?.({ kind: 'device', name: item.device.name, metric, category: category === 'all' ? undefined : category })} onKeyDown={event => { if (event.key === 'Enter') onExplore?.({ kind: 'device', name: item.device.name, metric }); }} />{child.width > 92 && child.height > 32 && <text x={child.x + 7} y={child.y + 18} fontSize="11" fill="#fff" pointerEvents="none">{displayDeviceName(item.device.name, t).slice(0, Math.max(8, Math.floor(child.width / 8)))}</text>}</g>)}</g>;
    })}</svg>{hovered && <FloatingTooltip x={hovered.x} y={hovered.y}>{hovered.title}: {fmt(hovered.size)} {t(labels[metric])}</FloatingTooltip>}</div>}
    <p className="muted tiny">{t("Each large area is a manufacturer; inner areas are devices. Click an area to view its assets.")}</p>
  </div>;
}

export type FramePoint = { width: number; height: number; count: number; segments: { category: string; photos: number; geo: number; people: number; favorites: number }[] };
export function FrameChart({ frames, covered, photoCount, onExplore }: { frames: FramePoint[]; covered: number; photoCount: number; onExplore?: Explore }) {
  const { t } = useLocale();
  const [hovered, setHovered] = useState<string | null>(null);
  const [metric, setMetric] = useState<'photos' | 'favorites' | 'geo' | 'people'>('photos');
  const [category, setCategory] = useState('all');
  const [logScale, setLogScale] = useState(false);
  const [orientationColors, setOrientationColors] = useState(false);
  const [minCount, setMinCount] = useState(photoCount < 200 ? 1 : 5);
  const selectedCount = (frame: FramePoint) => frame.segments.filter(segment => category === 'all' || segment.category === category).reduce((sum, segment) => sum + segment[metric], 0);
  const visibleFrames = useMemo(() => frames.filter(frame => frame.segments.filter(segment => category === 'all' || segment.category === category).reduce((sum, segment) => sum + segment[metric], 0) >= minCount), [frames, category, metric, minCount]);
  const { visiblePhotos, maxCount } = useMemo(() => {
    const counts = visibleFrames.map(frame => frame.segments.filter(segment => category === 'all' || segment.category === category).reduce((sum, segment) => sum + segment[metric], 0));
    return { visiblePhotos: counts.reduce((sum, count) => sum + count, 0), maxCount: counts.reduce((max, count) => Math.max(max, count), 1) };
  }, [visibleFrames, category, metric]);
  // A rare panorama or malformed EXIF size must not shrink every common frame.
  // Keep each aspect ratio exact; only cap the display size of unusually large frames.
  const referenceDimension = useMemo(() => {
    const sortedDimensions = [...visibleFrames].sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
    const weight = (frame: FramePoint) => frame.segments.filter(segment => category === 'all' || segment.category === category).reduce((sum, segment) => sum + segment[metric], 0);
    const threshold = visibleFrames.reduce((sum, frame) => sum + weight(frame), 0) * .99;
    let coveredDimensions = 0;
    return sortedDimensions.reduce((reference, frame) => {
      if (coveredDimensions >= threshold) return reference;
      coveredDimensions += weight(frame);
      return Math.max(reference, frame.width, frame.height);
    }, 1);
  }, [visibleFrames, category, metric]);
  const sorted = useMemo(() => [...visibleFrames].sort((a, b) => a.count - b.count), [visibleFrames]);
  const tone = (intensity: number, orientation: 'portrait' | 'landscape' | 'square' = 'square') => {
    if (orientationColors) return `color-mix(in srgb, var(--series-${orientation === 'portrait' ? 0 : orientation === 'landscape' ? 1 : 2}) ${Math.round(20 + intensity * 75)}%, var(--app-chart-empty))`;
    return sequentialColor(intensity);
  };
  const shade = (frame: FramePoint) => {
    const count = selectedCount(frame);
    if (!count) return 'var(--app-chart-empty)';
    const intensity = logScale ? Math.log1p(count) / Math.log1p(maxCount) : count / maxCount;
    return tone(intensity, frame.height > frame.width ? 'portrait' : frame.width > frame.height ? 'landscape' : 'square');
  };
  const gradient = (orientation: 'portrait' | 'landscape' | 'square' = 'square') => `linear-gradient(90deg,${Array.from({ length: 11 }, (_, index) => `${tone(index / 10, orientation)} ${index * 10}%`).join(',')})`;
  const open = (frame: FramePoint) => onExplore?.({ kind: 'dimensions', metric, category, frame_width: frame.width, frame_height: frame.height });
  const active = visibleFrames.find(frame => `${frame.width}x${frame.height}` === hovered);
  const frameNodes = useMemo(() => sorted.map(frame => {
    const scale = 320 / Math.max(referenceDimension, frame.width, frame.height);
    const width = frame.width * scale, height = frame.height * scale;
    const key = `${frame.width}x${frame.height}`;
    const count = selectedCount(frame);
    return <rect key={key} x={250 - width / 2} y={190 - height / 2} width={width} height={height} fill="none" stroke={shade(frame)} strokeWidth="2" pointerEvents="stroke" role={onExplore ? 'button' : undefined} tabIndex={0} aria-label={t("{width} × {height} pixels: {count} photos in the selection", { width: frame.width, height: frame.height, count: fmt(count) })} onPointerMove={() => setHovered(current => current === key ? current : key)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(key)} onBlur={() => setHovered(null)} onClick={() => open(frame)} onKeyDown={event => { if (event.key === 'Enter') open(frame); }}><title>{t("{width} × {height} pixels · {count} in the selection", { width: frame.width, height: frame.height, count: fmt(count) })}</title></rect>;
  }), [sorted, referenceDimension, metric, category, logScale, maxCount, orientationColors, onExplore, t]);
  const legendNodes = useMemo(() => visibleFrames.map(frame => {
    const key = `${frame.width}x${frame.height}`;
    return <button key={key} type="button" onClick={() => open(frame)} onPointerMove={() => setHovered(current => current === key ? current : key)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(key)} onBlur={() => setHovered(null)}><i style={{ background: shade(frame) }} /><span>{frame.width} × {frame.height}</span><b>{fmt(selectedCount(frame))}</b></button>;
  }), [visibleFrames, metric, category, logScale, maxCount, orientationColors, onExplore]);
  if (!frames.length) return <p className="muted">{t("No image dimensions available.")}</p>;
  return <div><div className="frame-controls"><div className="series-toggles">{([['photos', "Photos"], ['favorites', "Favorites"], ['geo', "With location"], ['people', "With people"]] as const).map(([key, name]) => <button key={key} type="button" className={metric === key ? 'primary' : 'secondary'} onClick={() => { setMetric(key); setHovered(null); }}>{t(name)}</button>)}</div><label>{t("Device type")}<select value={category} onChange={event => { setCategory(event.target.value); setHovered(null); }}><option value="all">{t("All devices")}</option><option value="Camera">{t("Camera")}</option><option value="Mobile device">{t("Mobile device")}</option><option value="Other">{t("Other")}</option></select></label><label>{t("Minimum per format")}<input type="number" min="1" max="1000000" step="1" value={minCount} onChange={event => { setMinCount(Math.max(1, Math.min(1000000, Math.floor(Number(event.target.value) || 1)))); setHovered(null); }} /></label><label>{t("Scale")}<select value={logScale ? "logarithmic scale" : 'linear'} onChange={event => setLogScale(event.target.value === "logarithmic scale")}><option value="linear">{t("Linear")}</option><option value="logarithmic scale">{t("Logarithmic")}</option></select></label><button type="button" className={`frame-orientation-toggle ${orientationColors ? 'selected' : ''}`} onClick={() => setOrientationColors(value => !value)} title={t("Color landscape and portrait separately")} aria-label={t("Color landscape and portrait separately")} aria-pressed={orientationColors}><span className="frame-icon-landscape" /><span className="frame-icon-portrait" /></button></div><div className="frame-layout"><div><svg viewBox="0 0 500 380" className="frame-svg" role="img" aria-label={t("Centered image format frames colored by frequency")}>
    <line x1="250" y1="20" x2="250" y2="355" stroke="var(--app-border)" strokeDasharray="3 4" />
    <line x1="50" y1="190" x2="450" y2="190" stroke="var(--app-border)" strokeDasharray="3 4" />
    {frameNodes}
  </svg><div className="frame-color-legend">{orientationColors ? <>{(['landscape', 'portrait', 'square'] as const).map(value => <span key={value}>{t(value === "landscape" ? "Landscape" : value === "portrait" ? "Portrait format" : "Square")}<i style={{ background: gradient(value) }} /></span>)}</> : <span>0<i style={{ background: gradient() }} />{fmt(maxCount)}</span>}</div>{visibleFrames.length === 0 && <p className="muted tiny">{t("No image format reaches this minimum.")}</p>}<p className="muted tiny">{t("{visible} of {total} image formats shown · {matches} matching photos. Set the minimum to 1 to show every format matching the filter.", { visible: fmt(visibleFrames.length), total: fmt(frames.length), matches: fmt(visiblePhotos) })} {t("{covered} of {photos} photos have stored dimensions.", { covered: fmt(covered), photos: fmt(photoCount) })} {t("Very large formats are fitted for display only; their aspect ratio stays unchanged.")} {t(logScale ? "Logarithmic color scale." : "Linear color scale.")}</p></div>
    <div className="frame-legend"><div className="frame-legend-head"><h4>{active ? `${active.width} × ${active.height} Pixel` : t("Most common image dimensions")}</h4><p>{active ? t("{selected} captures in the selection · {total} photos overall", { selected: fmt(selectedCount(active)), total: fmt(active.count) }) : t("Hover or select a frame; click to view matching photos.")}</p></div><div className="frame-legend-list" tabIndex={0} aria-label={t("All image formats")}>{legendNodes}</div></div>
  </div></div>;
}

export type NumericDistribution = { points: { label: string; value: number; count: number; lower: number | null; upper: number | null; upper_inclusive: boolean }[]; minimum: number | null; maximum: number | null; median: number | null; mean: number | null; mode: number | null; mode_count: number; p99: number | null; sample_count: number };
type DistributionKind = 'iso' | 'focal' | 'exposure' | 'video';
const distributionName = { iso: "ISO value", focal: "Focal length", exposure: "Exposure time", video: "Video length" };
function distributionValue(value: number, kind: DistributionKind, exposureDisplay: 'fraction' | 'seconds' = 'fraction') {
  if (kind === 'iso') return `ISO ${fmt(value)}`;
  if (kind === 'focal') return `${formatNumber(value, { maximumFractionDigits: 8 })} mm`;
  if (kind === 'video') return value >= 60 ? `${Math.floor(value / 60)}:${String(Math.round(value % 60)).padStart(2, '0')} Min. (${fmt(value)} s)` : `${fmt(value)} s`;
  if (exposureDisplay === 'seconds') return `${formatNumber(value, { maximumSignificantDigits: 4 })} s`;
  return value < 1 ? `1/${fmt(1 / value)} s` : `${fmt(value)} s`;
}

export function DistributionChart({ distribution, kind, onExplore }: { distribution: NumericDistribution; kind: DistributionKind; onExplore?: Explore }) {
  const { t } = useLocale();
  const [hover, setHover] = useState<{ point: number; x: number; y: number } | null>(null);
  const [xScale, setXScale] = useState<'linear' | "logarithmic scale">("logarithmic scale");
  const [yScale, setYScale] = useState<'linear' | "logarithmic scale">("logarithmic scale");
  const [focus, setFocus] = useState(kind === 'exposure' || kind === 'video');
  const [resolution, setResolution] = useState(kind === 'exposure' ? 3 : 0);
  const [draftResolution, setDraftResolution] = useState(kind === 'exposure' ? 3 : 0);
  const [exposureDisplay, setExposureDisplay] = useState<'fraction' | 'seconds'>('fraction');
  const [minFrequency, setMinFrequency] = useState('1');
  const { points, minimum, maximum } = distribution;
  if (!points.length || minimum === null || maximum === null) return <p className="muted">{t("Metadata is missing for this distribution.")}</p>;
  const visible = focus && distribution.p99 !== null && distribution.p99 < maximum ? points.filter(p => p.value <= distribution.p99!) : points;
  const base = visible.length ? visible : points;
  const choices = kind === 'iso' ? [{ label: t("Individual values"), step: 0 }, ...[2, 5, 10, 25, 50, 100].map(step => ({ label: `${step} ISO`, step }))]
    : kind === 'focal' ? [{ label: t("Individual values"), step: 0 }, ...[0.5, 1, 2, 5, 10, 20].map(step => ({ label: `${step} mm`, step }))]
    : kind === 'video' ? [1, 2, 5, 10, 30, 60, 300].map(step => ({ label: `${step} ${t(step === 1 ? "second" : "seconds")}`, step }))
    : [{ label: t("Individual values"), step: 0 }, ...[1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2].map(step => ({ label: `${formatNumber(step, { maximumFractionDigits: 4 })} ${t("exposure stops")}`, step }))];
  const step = choices[resolution].step;
  const bins = new Map<number, { count: number; lower: number; upper: number; visualLower: number; visualUpper: number }>();
  base.forEach((point, index) => {
    const bucket = step === 0 ? index : Math.floor((kind === 'exposure' ? Math.log2(point.value) : point.value) / step + 1e-9);
    const visualLower = step === 0 ? point.value : kind === 'exposure' ? 2 ** (bucket * step) : bucket * step;
    const visualUpper = step === 0 ? point.value : kind === 'exposure' ? 2 ** ((bucket + 1) * step) : (bucket + 1) * step;
    const old = bins.get(bucket);
    bins.set(bucket, old ? { ...old, count: old.count + point.count, lower: Math.min(old.lower, point.value), upper: Math.max(old.upper, point.value) } : { count: point.count, lower: point.value, upper: point.value, visualLower, visualUpper });
  });
  const allBins = [...bins.values()].sort((a, b) => a.lower - b.lower).map(bin => ({ ...bin, value: (bin.visualLower + bin.visualUpper) / 2,
    label: bin.lower === bin.upper ? distributionValue(bin.lower, kind, exposureDisplay) : t("{start} to {end}", { start: distributionValue(bin.lower, kind, exposureDisplay), end: distributionValue(bin.upper, kind, exposureDisplay) }),
    upper_inclusive: true }));
  const threshold = Math.max(1, Math.min(1000000, Math.floor(Number(minFrequency) || 1)));
  const plot = allBins.filter(bin => bin.count >= threshold);
  const hiddenBins = allBins.length - plot.length;
  const hiddenAssets = allBins.reduce((sum, bin) => sum + (bin.count < threshold ? bin.count : 0), 0);
  const openPoint = (point: typeof plot[number]) => onExplore?.({ kind: 'distribution', field: kind, metric: kind === 'video' ? 'videos' : 'photos', lower: point.lower, upper: point.upper, upper_inclusive: point.upper_inclusive });
  const peak = Math.max(1, ...plot.map(p => p.count));
  const transform = (value: number) => xScale === "logarithmic scale" ? kind === 'exposure' ? Math.log(Math.max(value, Number.MIN_VALUE)) : Math.log1p(Math.max(0, value)) : value;
  const scaleBins = plot.length ? plot : allBins;
  const firstX = transform(scaleBins[0].visualLower), lastX = transform(scaleBins.at(-1)!.visualUpper);
  const spacing = lastX === firstX ? 1 : lastX - firstX;
  const x = (value: number) => lastX === firstX ? 430 : 65 + (transform(value) - firstX) / spacing * 720;
  const height = (count: number) => (yScale === "logarithmic scale" ? Math.log1p(count) / Math.log1p(peak) : count / peak) * 170;
  // Equal visual widths keep frequency, rather than bin span, as the only bar-size cue.
  const centers = plot.map(point => x(point.value));
  const closestGap = centers.slice(1).reduce((gap, center, index) => Math.min(gap, center - centers[index]), Infinity);
  const barWidth = plot.length < 2 ? 28 : Math.max(1.5, Math.min(34, closestGap * .78));
  const bounds = (p: typeof plot[number]) => {
    const center = x(p.value);
    return { left: center - barWidth / 2, right: center + barWidth / 2 };
  };
  const proposedTicks = plot.length ? [...new Set([0, .5, 1].map(fraction => Math.round((plot.length - 1) * fraction)))] : [];
  const tickIndices = proposedTicks.filter(index => index === 0 || index === plot.length - 1 || (x(plot[index].value) - x(plot[0].value) > 170 && x(plot.at(-1)!.value) - x(plot[index].value) > 170));
  const active = hover && plot[hover.point];
  const modeVisible = distribution.mode !== null && plot.some(bin => distribution.mode! >= bin.lower && distribution.mode! <= bin.upper);
  return <div className="distribution-chart">
    <div className="distribution-controls"><label>{t("X axis")}<select value={xScale} onChange={event => setXScale(event.target.value as 'linear' | "logarithmic scale")}><option value="linear">{t("Linear")}</option><option value="logarithmic scale">{t("Logarithmic")}</option></select></label><label>{t("Y axis")}<select value={yScale} onChange={event => setYScale(event.target.value as 'linear' | "logarithmic scale")}><option value="linear">{t("Linear")}</option><option value="logarithmic scale">{t("Logarithmic")}</option></select></label>{kind === 'exposure' && <label>{t("Labels")}<select value={exposureDisplay} onChange={event => setExposureDisplay(event.target.value as 'fraction' | 'seconds')}><option value="fraction">{t("1/… seconds")}</option><option value="seconds">{t("Decimal seconds")}</option></select></label>}{distribution.p99 !== null && distribution.p99 < maximum && <label className="focus-control"><input type="checkbox" checked={focus} onChange={event => { setFocus(event.target.checked); setHover(null); }} />{t("Typical range (up to 99%)")}</label>}<label className="frequency-control">{t("Minimum captures per bar")}<input type="number" min="1" max="1000000" step="1" value={minFrequency} onChange={event => { setMinFrequency(event.target.value); setHover(null); }} onBlur={() => setMinFrequency(String(threshold))} /></label></div>
    <label className="bin-slider">{t("Resolution")}: {choices[draftResolution].label}<input type="range" min="0" max={choices.length - 1} step="1" value={draftResolution} onChange={event => setDraftResolution(Number(event.target.value))} onPointerUp={() => { setResolution(draftResolution); setHover(null); }} onKeyUp={() => { setResolution(draftResolution); setHover(null); }} onBlur={() => setResolution(draftResolution)} /></label>
    <div className="histogram-plot"><svg className="distribution-svg" viewBox="0 0 860 270" role="img" aria-label={t("Frequency distribution of {name}", { name: t(distributionName[kind]) })} onPointerLeave={() => setHover(null)}>
      {[0, .5, 1].map(fraction => <g key={fraction}><line x1="45" x2="815" y1={210 - fraction * 170} y2={210 - fraction * 170} stroke="var(--app-border)" /><text x="40" y={214 - fraction * 170} textAnchor="end" fontSize="11">{fmt(yScale === "logarithmic scale" ? Math.expm1(Math.log1p(peak) * fraction) : peak * fraction)}</text></g>)}
      {plot.map((p, i) => { const position = bounds(p); return <g key={`${p.label}-${i}`}><rect x={position.left} y={210 - height(p.count)} width={barWidth} height={height(p.count)} fill={p.count === peak ? 'var(--app-accent-hover)' : 'var(--plot-primary)'} rx={Math.min(4, Math.max(1, (position.right - position.left) / 5))} tabIndex={0} role={onExplore ? 'button' : undefined} aria-label={`${p.label}: ${fmt(p.count)} ${t("captures. Click to view assets.")}`} onClick={() => openPoint(p)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPoint(p); } }} onPointerEnter={event => setHover({ point: i, x: event.clientX, y: event.clientY })} onPointerMove={event => setHover({ point: i, x: event.clientX, y: event.clientY })} onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setHover({ point: i, x: rect.left, y: rect.top }); }} onBlur={() => setHover(null)} /><title>{p.label}: {fmt(p.count)} {t("Captures")}</title></g>; })}
      {modeVisible && distribution.mode !== null && <g pointerEvents="none"><line x1={x(distribution.mode)} x2={x(distribution.mode)} y1="33" y2="210" stroke="var(--app-accent-ink)" strokeWidth="2" strokeDasharray="4 4" /><circle cx={x(distribution.mode)} cy="31" r="4" fill="var(--app-accent-ink)" /></g>}
      {tickIndices.map(index => { const p = plot[index]; return <text key={index} x={x(p.value)} y="244" textAnchor={index === 0 ? 'start' : index === plot.length - 1 ? 'end' : 'middle'} fontSize="10">{distributionValue(p.lower, kind, exposureDisplay)}</text>; })}{!plot.length && <text x="430" y="135" textAnchor="middle" fontSize="16">{t("No bar reaches the minimum frequency.")}</text>}
    </svg>{active && <FloatingTooltip x={hover!.x} y={hover!.y} className="chart-tooltip-list"><b>{active.label}</b><span>{fmt(active.count)} {t("Captures")} · {fmt(active.count / distribution.sample_count * 100)} %</span><small>{t("Click to view matching assets")}</small></FloatingTooltip>}</div>
    <div className="distribution-summary"><span>{t("Median")} <b>{distribution.median === null ? '—' : distributionValue(distribution.median, kind, exposureDisplay)}</b></span><span>{t("Mean")} <b>{distribution.mean === null ? '—' : distributionValue(distribution.mean, kind, exposureDisplay)}</b></span><span>{t("Most frequent exact value")} <b>{distribution.mode === null ? '—' : distributionValue(distribution.mode, kind, exposureDisplay)}</b><small>{fmt(distribution.mode_count)} {t("Captures")}</small></span></div>
    <div className="distribution-extrema"><span>{t("Smallest")} {t(distributionName[kind])}: <b>{distributionValue(minimum, kind, exposureDisplay)}</b></span><span>{t("Largest")} {t(distributionName[kind])}: <b>{distributionValue(maximum, kind, exposureDisplay)}</b></span></div>
    <p className="muted tiny">{t("{count} captures with a value · The darker bar marks the most frequent displayed range; the accent line marks the most frequent exact value.", { count: fmt(distribution.sample_count) })}{hiddenBins > 0 ? ` ${t("{bins} rare ranges with {assets} captures hidden.", { bins: fmt(hiddenBins), assets: fmt(hiddenAssets) })}` : ''}{!modeVisible && distribution.mode !== null ? ` ${t("The most frequent exact value lies outside the visible ranges.")}` : ''} {t("Median, mean, and most frequent exact value still include all values.")}</p>
  </div>;
}

export function CameraStreamgraph({ slices, mode, onExplore, theme }: { slices: HeatSlice[]; mode: 'cumulative' | 'yearly'; onExplore?: Explore; theme: 'light' | 'dark' }) {
  const { t } = useLocale();
  const [metric, setMetric] = useState<Metric>('assets');
  const [group, setGroup] = useState<'device' | 'manufacturer'>('device');
  const [category, setCategory] = useState('all');
  const [order, setOrder] = useState<'contribution' | 'newest'>('contribution');
  const [hovered, setHovered] = useState<number | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const { names, years, firstSeen } = useMemo(() => {
    const matching = slices.filter(row => (category === 'all' || row.category === category) && row[metric] > 0);
    const key = (row: HeatSlice) => group === 'device' ? row.device : row.manufacturer;
    const totals = new Map<string, number>();
    const firstSeen = new Map<string, number>();
    for (const row of matching) {
      const name = key(row), year = Number(row.date.slice(0, 4));
      totals.set(name, (totals.get(name) ?? 0) + row[metric]);
      firstSeen.set(name, Math.min(firstSeen.get(name) ?? year, year));
    }
    const names = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de')).slice(0, 5).map(([name]) => name);
    if (!matching.length) return { names, years: [] as { year: number; yearly: number[]; cumulative: number[] }[], firstSeen };
    const first = matching.reduce((best, row) => Math.min(best, Number(row.date.slice(0, 4))), Infinity);
    const last = matching.reduce((best, row) => Math.max(best, Number(row.date.slice(0, 4))), -Infinity);
    const years = Array.from({ length: last - first + 1 }, (_, index) => ({ year: first + index, yearly: Array<number>(names.length + 1).fill(0), cumulative: Array<number>(names.length + 1).fill(0) }));
    const indices = new Map(names.map((name, index) => [name, index]));
    for (const row of matching) years[Number(row.date.slice(0, 4)) - first].yearly[indices.get(key(row)) ?? names.length] += row[metric];
    const running = Array<number>(names.length + 1).fill(0);
    for (const year of years) { year.yearly.forEach((value, index) => { running[index] += value; }); year.cumulative = [...running]; }
    return { names, years, firstSeen };
  }, [slices, group, category, metric]);
  const values = (row: typeof years[number]) => mode === 'cumulative' ? row.cumulative : row.yearly;
  const max = Math.max(1, ...years.map(row => values(row).reduce((sum, count) => sum + count, 0)));
  const x = (index: number) => years.length === 1 ? 440 : 50 + index / (years.length - 1) * 780;
  const colors = Array.from({ length: 6 }, (_, index) => qualitativeColor(index, theme));
  const layerNames = [...names, t("Remainder")];
  const bounds = years.map(row => {
    const counts = values(row), total = counts.reduce((sum, value) => sum + value, 0);
    const ranking = names.map((_, index) => index).sort((a, b) => order === 'newest'
      ? (firstSeen.get(names[b]) ?? 0) - (firstSeen.get(names[a]) ?? 0) || counts[b] - counts[a]
      : counts[b] - counts[a] || names[a].localeCompare(names[b], 'de'));
    ranking.push(names.length);
    const positions = Array.from({ length: layerNames.length }, () => ({ top: 180, bottom: 180 }));
    let above = 0;
    for (const index of ranking) {
      positions[index] = { top: 180 - total / max * 145 + above / max * 290,
        bottom: 180 - total / max * 145 + (above + counts[index]) / max * 290 };
      above += counts[index];
    }
    return positions;
  });
  const ribbons = layerNames.flatMap((name, layer) => years.slice(0, -1).map((_, index) => {
    const left = bounds[index][layer], right = bounds[index + 1][layer];
    const middle = (x(index) + x(index + 1)) / 2;
    return { name, layer, key: `${name}-${index}`, path: `M${x(index)},${left.top} C${middle},${left.top} ${middle},${right.top} ${x(index + 1)},${right.top} L${x(index + 1)},${right.bottom} C${middle},${right.bottom} ${middle},${left.bottom} ${x(index)},${left.bottom} Z` };
  }));
  const active = hovered === null ? null : years[hovered];
  return <div className="streamgraph"><div className="streamgraph-options"><span>{t(mode === "cumulative" ? "Cumulative captures" : "New captures in year")} · {t("Top 5 + other")}</span><label>{t("Group")}<select value={group} onChange={event => setGroup(event.target.value as typeof group)}><option value="device">{t("Devices")}</option><option value="manufacturer">{t("Manufacturer")}</option></select></label><label>{t("Device type")}<select value={category} onChange={event => setCategory(event.target.value)}><option value="all">{t("All")}</option><option value="Camera">{t("Cameras")}</option><option value="Mobile device">{t("Mobile devices")}</option><option value="Other">{t("Other")}</option></select></label><label>{t("Top order")}<select value={order} onChange={event => setOrder(event.target.value as typeof order)}><option value="contribution">{t("Largest contribution")}</option><option value="newest">{t("Newest devices")}</option></select></label></div>
    <div className="series-toggles">{(Object.keys(labels) as Metric[]).map(value => <button key={value} type="button" className={metric === value ? 'primary' : 'secondary'} onClick={() => setMetric(value)}>{t(labels[value])}</button>)}</div>
    {!years.length ? <p className="muted">{t("No matching captures available.")}</p> : <><div className="streamgraph-plot"><svg viewBox="0 0 880 380" role="img" aria-label={t("Streamgraph of the five most frequent devices or manufacturers")} onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); const position = (event.clientX - rect.left) / rect.width; setHovered(Math.max(0, Math.min(years.length - 1, Math.round((position * 880 - 50) / 780 * Math.max(1, years.length - 1))))); setPointer({ x: event.clientX, y: event.clientY }); }} onPointerLeave={() => setHovered(null)}>
      <line x1="50" x2="830" y1="180" y2="180" stroke="var(--app-border)" />
      {years.length === 1 ? layerNames.map((name, layer) => <rect key={name} x="390" y={bounds[0][layer].top} width="100" height={Math.max(0, bounds[0][layer].bottom - bounds[0][layer].top)} fill={colors[layer]} />) : ribbons.map(ribbon => <path key={ribbon.key} d={ribbon.path} fill={colors[ribbon.layer]} fillOpacity=".93" stroke="#fff" strokeWidth=".5" />)}
      {hovered !== null && <line x1={x(hovered)} x2={x(hovered)} y1="34" y2="326" stroke="var(--app-accent-ink)" strokeDasharray="3 4" pointerEvents="none" />}
      {years.map((row, index) => (index === 0 || index === years.length - 1 || index % Math.max(1, Math.ceil(years.length / 10)) === 0) && <text key={row.year} x={x(index)} y="350" textAnchor={index === 0 && years.length > 1 ? 'start' : index === years.length - 1 && years.length > 1 ? 'end' : 'middle'} fontSize="11">{row.year}</text>)}
    </svg>{active && <FloatingTooltip x={pointer.x} y={pointer.y} className="chart-tooltip-list"><b>{t(mode === "cumulative" ? "Through {year}" : "In {year}", { year: active.year })} · {t(labels[metric])}</b>{layerNames.map((name, index) => <span key={name}><i style={{ background: colors[index] }} />{displayDeviceName(name, t)}: {fmt(values(active)[index])}</span>)}</FloatingTooltip>}</div>
    <div className="streamgraph-legend">{layerNames.map((name, index) => <button type="button" key={name} disabled={index === names.length || !onExplore} onClick={() => onExplore?.({ kind: group, name, metric, category: category === 'all' ? undefined : category })}><i style={{ background: colors[index] }} />{displayDeviceName(name, t)}</button>)}</div><p className="muted tiny">{t("The top five depend on the selected metric and device type. Vertical order is recalculated each year, so ribbons cross when rankings change. “Other” groups all remaining devices.")}</p></>}
  </div>;
}

export function GrowthChart({ years, onExplore }: { years: Year[]; onExplore?: Explore }) {
  const { t } = useLocale();
  const [selected, setSelected] = useState<Metric[]>(['assets', 'photos', 'videos', 'geo', 'people', 'favorites']);
  const [hover, setHover] = useState<number | null>(null);
  const [yearScale, setYearScale] = useState<'linear' | "logarithmic scale">("logarithmic scale");
  const rateScale = "logarithmic scale";
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  if (!years.length) return <p className="muted">{t("No capture years available yet.")}</p>;
  const series = selected;
  const x = (i: number) => years.length < 2 ? 390 : 60 + i * 670 / (years.length - 1);
  const maxCount = Math.max(1, ...years.flatMap(row => series.map(metric => row[metric])));
  const rates = (metric: Metric, i: number) => i === 0 || years[i - 1].year !== years[i].year - 1 || years[i - 1][metric] === 0 ? null : (years[i][metric] - years[i - 1][metric]) / years[i - 1][metric] * 100;
  const rateValues = years.flatMap((_, i) => series.map(metric => rates(metric, i))).filter((value): value is number => value !== null);
  const maxRate = Math.max(1, ...rateValues.map(Math.abs));
  const yearly = (value: number) => 206 - (yearScale === "logarithmic scale" ? Math.log1p(value) / Math.log1p(maxCount) : value / maxCount) * 160;
  const relative = (value: number) => 126 - (rateScale === "logarithmic scale" ? Math.log1p(Math.abs(value)) / Math.log1p(maxRate) * Math.sign(value) : value / maxRate) * 77;
  const chart = (rate: boolean) => <div className="comparison-scroll"><svg className="comparison-svg" viewBox="0 0 780 250" role="img" aria-label={t(rate ? "Percentage change in captures year over year" : "Captures by capture year")}>
    {[0, .5, 1].map(f => { const value = rate ? (rateScale === "logarithmic scale" ? Math.sign(f * 2 - 1) * Math.expm1(Math.abs(f * 2 - 1) * Math.log1p(maxRate)) : (f * 2 - 1) * maxRate) : (yearScale === "logarithmic scale" ? Math.expm1(f * Math.log1p(maxCount)) : f * maxCount); const position = rate ? relative(value) : yearly(value); return <g key={f}><line x1="60" x2="730" y1={position} y2={position} stroke="var(--app-border)" /><text x="53" y={position + 4} textAnchor="end" fontSize="10">{fmt(value)}</text></g>; })}
    {series.map(metric => <g key={metric}><path d={smoothPath(years.map((row, i) => { const value = rate ? rates(metric, i) : row[metric]; return value === null ? null : [x(i), rate ? relative(value) : yearly(value)] as const; }))} fill="none" stroke={colors[metric]} strokeWidth="2.8" />{years.map((row, i) => { const value = rate ? rates(metric, i) : row[metric]; return value === null ? null : <circle key={row.year} cx={x(i)} cy={rate ? relative(value) : yearly(value)} r={hover === i ? 6 : 3.5} fill={colors[metric]} stroke="var(--app-surface)" strokeWidth="2" />; })}</g>)}
    {years.map((row, i) => <g key={row.year}>{(i === 0 || i === years.length - 1 || i % Math.max(1, Math.ceil(years.length / 8)) === 0) && <text x={x(i)} y="238" textAnchor="middle" fontSize="11">{row.year}</text>}<rect x={x(i) - Math.min(24, years.length < 2 ? 24 : 330 / (years.length - 1))} y="38" width={Math.min(48, years.length < 2 ? 48 : 660 / (years.length - 1))} height="174" fill="transparent" role={onExplore ? 'button' : undefined} tabIndex={0} aria-label={t("{year}: view captures", { year: row.year })} onMouseEnter={event => { setHover(i); setPointer({ x: event.clientX, y: event.clientY }); }} onMouseMove={event => setPointer({ x: event.clientX, y: event.clientY })} onMouseLeave={() => setHover(null)} onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setHover(i); setPointer({ x: rect.left, y: rect.top }); }} onBlur={() => setHover(null)} onClick={() => onExplore?.({ kind: 'year', year: row.year })} onKeyDown={event => { if (event.key === 'Enter' && onExplore) onExplore({ kind: 'year', year: row.year }); }} /></g>)}
  </svg></div>;
  return <div className="growth-chart"><div className="series-toggles">{(Object.keys(colors) as Metric[]).map(metric => <label key={metric} style={{ color: colors[metric] }}><input type="checkbox" checked={selected.includes(metric)} onChange={() => setSelected(old => old.includes(metric) ? old.filter(item => item !== metric) : [...old, metric])} />{t(labels[metric])}</label>)}</div>{hover !== null && <FloatingTooltip x={pointer.x} y={pointer.y} className="chart-tooltip-list"><b>{t("Capture year {year}", { year: years[hover].year })}</b>{series.map(metric => { const rate = rates(metric, hover); return <span key={metric}><i style={{ background: colors[metric] }} />{t(labels[metric])}: {fmt(years[hover][metric])} · {rate === null ? t("no previous-year value") : `${rate >= 0 ? '+' : ''}${fmt(rate)} %`}</span>; })}</FloatingTooltip>}<div className="growth-heading"><h4>{t("Captures by year of capture")}</h4><label className="scale-select">{t("Scale")}<select value={yearScale} onChange={event => setYearScale(event.target.value as 'linear' | "logarithmic scale")}><option value="linear">{t("Linear")}</option><option value="logarithmic scale">{t("Logarithmic")}</option></select></label></div>{chart(false)}<p className="muted tiny">{t("Captures are grouped by capture date, not import date. Hover also shows year-over-year change; the current year is incomplete.")}</p></div>;
}
