import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { CalendarHeatmap, CameraStreamgraph, ComparisonChart, DeviceChart, DistributionChart, FrameChart, GrowthChart, WeekHourHeatmap, Day, HeatSlice, NumericDistribution, WeekHour, AssetFilter } from './charts';
import { ExposureTriangle, ExposurePoint } from './exposure';
import { MediaTimeline, TimelineEvent } from './timeline';
import { FocalFieldOfView, ResolutionDevelopment } from './new-charts';
import { DeviceRules } from './device-rules';
import { AnnualPhotoProfile, ParameterChart, ParameterSlice, PhotoProfile, PhotoProfilePage } from './photo-profile';
import { displayDeviceName, LocaleProvider, languageOptions, useLocale, type Language } from './i18n';
import { smoothPath } from './smooth-path';
import { FloatingTooltip } from './tooltip';
import { describeAssetSelection } from './asset-description';
import { formatNumber } from './number-format';

type User = { id: number; email: string; name: string; is_admin: boolean; profile_icon: string; immich_url: string | null; has_api_key: boolean; has_immich_avatar: boolean };
type Member = { id: number; email: string; name: string; is_admin: boolean; joined: boolean };
type Auth = { user: User; csrf_token: string };
type Permission = { permission: string; purpose: string; optional: boolean };
type Point = { label: string; count: number };
type YearPoint = { year: number; label?: string | null; photos: number; videos: number; assets: number; geo: number; people: number; favorites: number; cumulative_photos: number; cumulative_videos: number; cumulative_assets: number; cumulative_geo: number; cumulative_people: number; cumulative_favorites: number; average_asset_bytes: number | null; average_photo_bytes: number | null; average_video_bytes: number | null; average_geo_bytes: number | null; average_people_bytes: number | null; average_favorites_bytes: number | null; resolution_count: number; average_megapixels: number | null; minimum_megapixels: number | null; maximum_megapixels: number | null };
type WeekPoint = { year: number; week_start: string; photos: number; videos: number; geo: number; favorites: number };
type SyncStatus = { running: boolean; revision: string | null; completed_at: string | null; error: string | null; progress: { phase: string; percent: number; processed: number; total: number } | null };
type ScorePoint = { key: 'time' | 'iso' | 'frequency' | 'orientation' | 'device' | 'media'; value: number | null; eligible_count: number; excluded_count: number; population_count: number };
type AnnualScorePoint = { year: number; photo_count: number; video_count: number; scores: Partial<Record<ScorePoint['key'], number | null>> };
type LibraryStats = {
  timeline: TimelineEvent[];
  parameter_slices: ParameterSlice[]; photo_profile: PhotoProfile; annual_photo_profiles: AnnualPhotoProfile[];
  months: YearPoint[]; hours_of_week: WeekHour[];
  days: Day[]; favorite_count: number; album_count: number | null; unalbumed_asset_count: number | null; unalbumed_photo_count: number | null; unalbumed_video_count: number | null; live_photo_video_count: number;
  asset_count: number; photo_count: number; video_count: number; other_count: number;
  total_bytes: number | null; photo_bytes: number | null; video_bytes: number | null;
  average_asset_bytes: number | null; average_photo_bytes: number | null; average_video_bytes: number | null;
  missing_size_count: number; bit_count: number | null; sand_cubic_meters: number | null;
  print_area_square_meters: number; print_tennis_courts: number;
  print_stack_meters: number; print_weight_kg: number;
  devices: { name: string; manufacturer: string; manufacturer_variants: string[]; category: string; count: number; photos: number; videos: number; geo: number; people: number; favorites: number }[]; average_megapixels: number | null; resolution_count: number;
  most_used_iso: number | null; most_used_focal_length_mm: number | null;
  video_duration_seconds: number; average_video_duration_seconds: number | null; duration_missing_count: number; exposure_seconds: number; exposure_missing_count: number; person_count: number; detected_people_count: number;
  photos_with_people_count: number; people_per_photo_with_people: number | null; people_per_photo: number | null;
  geotagged_count: number; country_count: number; first_date: string | null; last_date: string | null;
  first_asset_id: string | null; last_asset_id: string | null; busiest_day_asset_id: string | null;
  altitude_photo_count: number; direction_photo_count: number; altitude_distribution: NumericDistribution;
  portrait: { assets: number; photos: number; videos: number }; landscape: { assets: number; photos: number; videos: number }; orientation_unknown: { assets: number; photos: number; videos: number };
  raw_manufacturers: { name: string; manufacturer: string; manufacturer_variants: string[]; category: string; count: number; photos: number; videos: number; geo: number; people: number; favorites: number }[];
  continent_count: number; continents: string[]; top_country: string | null; top_country_asset_count: number; busiest_day: string | null; busiest_day_count: number;
  longest_pause_start: string | null; longest_pause_end: string | null; longest_pause_days: number;
  longest_day_streak: number; longest_day_streak_start: string | null; longest_day_streak_end: string | null;
  longest_week_streak: number; longest_week_streak_start: string | null; longest_week_streak_end: string | null;
  timespan_days: number | null; undated_count: number; by_month: Point[]; by_weekday: Point[];
  scores: ScorePoint[];
  annual_scores: AnnualScorePoint[];
  photo_days_year: number | null; photo_days_count: number; photo_days_total_days: number; photo_days_percent: number | null;
  heatmap_slices: HeatSlice[];
  exposure_points: ExposurePoint[];
  frame_formats: { width: number; height: number; count: number; segments: { category: string; photos: number; geo: number; people: number; favorites: number }[] }[]; frame_format_covered_count: number;
  by_hour: Point[]; iso_distribution: NumericDistribution; focal_distribution: NumericDistribution; exposure_distribution: NumericDistribution; video_duration_distribution: NumericDistribution; years: YearPoint[]; weeks: WeekPoint[]; latest_photo_id: string | null;
};
type Tab = 'library' | 'year' | 'range' | 'photo_profile' | 'download' | 'profile';
type ExportInfo = { size_bytes: number; asset_count: number; summary_count: number; revision: string };
type ReportInfo = { revision: string; sizes: Record<'pdf' | 'csv' | 'jpg', number> };
type AssetItem = { id: string; filename: string; type: string; taken_at: string | null; device: string; iso: number | null; focal_mm: number | null; exposure_seconds: number | null; duration_seconds: number | null; size_bytes: number | null };
type AssetResult = { description: string; total: number; items: AssetItem[]; models: { name: string; count: number }[]; manufacturer_variants: { name: string; count: number }[]; offset: number; limit: number };

const API = import.meta.env.VITE_API_URL || '/api';
const PRINT_ESTIMATE_EUR = 0.07; // Public online starting price; illustrative, excludes shipping.
const icons: Record<string, string> = { camera: '📷', mountain: '🏔️', sun: '☀️', flower: '🌼', star: '⭐', heart: '❤️', leaf: '🍃', film: '🎞️' };
const number = (value: number) => formatNumber(value);
const decimal = (value: number, digits = 1) => formatNumber(value, { maximumFractionDigits: digits });
const bytes = (value: number | null, digits = 2) => value === null ? '—' : `${decimal(value / 1e9, digits)} GB`;
const megabytes = (value: number | null) => value === null ? '—' : `${decimal(value / 1e6, 2)} MB`;
const downloadSize = (value: number) => `${formatNumber(value / (value >= 1e6 ? 1e6 : 1e3), { maximumSignificantDigits: 1 })} ${value >= 1e6 ? 'MB' : 'KB'}`;
const durationLabel = (seconds: number, t: (source: string) => string) => `${number(Math.floor(seconds / 3600))} ${t("h")} ${Math.floor((seconds % 3600) / 60)} ${t("min")} ${Math.floor(seconds % 60)} ${t("s")}`;
const shutterLabel = (seconds: number | null) => seconds === null ? '—' : seconds < 1 ? `1/${decimal(1 / seconds, 2)} s` : `${decimal(seconds, 3)} s`;
const counted = (value: number, singular: string, plural: string) => `${number(value)} ${value === 1 ? singular : plural}`;
let csrfToken = '';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase()) && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(`${API}${path}`, { ...options, headers, credentials: 'include' });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail;
    throw new Error(typeof detail === 'string' ? detail : "Request failed.");
  }
  return response.status === 204 ? undefined as T : response.json();
}

type WhenMetric = 'assets' | 'photos' | 'videos' | 'geo' | 'people' | 'favorites';
const whenMetrics: [WhenMetric, string][] = [['assets', "Total"], ['photos', "Photos"], ['videos', 'Videos'], ['geo', "With location"], ['people', "With people"], ['favorites', "Favorites"]];
function CountBars({ points, labels, kind, metric, onExplore }: { points: Point[]; labels?: string[]; kind: 'month' | 'weekday'; metric: WhenMetric; onExplore?: (filter: AssetFilter) => void }) {
  const max = Math.max(1, ...points.map(item => item.count));
  return <div className="bar-list">{points.map((item, index) => <button type="button" className="bar-row chart-clickable" key={item.label} onClick={() => onExplore?.(kind === 'month' ? { kind, month: index + 1, metric } : { kind, weekday: index, metric })}>
    <span>{labels?.[index] ?? item.label}</span><span className="bar-track"><span className={item.count > 0 && item.count === max ? 'peak-bar' : ''} style={{ width: `${item.count / max * 100}%` }} /></span><b>{number(item.count)}</b>
  </button>)}</div>;
}

function WhenCharts({ slices, onExplore }: { slices: HeatSlice[]; onExplore?: (filter: AssetFilter) => void }) {
  const { t, language } = useLocale();
  const [metric, setMetric] = useState<WhenMetric>('assets');
  const totals = useMemo(() => {
    const blank = () => Object.fromEntries(whenMetrics.map(([key]) => [key, 0])) as Record<WhenMetric, number>;
    const month = Array.from({ length: 12 }, blank), weekday = Array.from({ length: 7 }, blank), hour = Array.from({ length: 24 }, blank);
    for (const row of slices) {
      const monthIndex = Number(row.date.slice(5, 7)) - 1;
      const weekdayIndex = (new Date(`${row.date}T00:00:00Z`).getUTCDay() + 6) % 7;
      if (monthIndex < 0 || monthIndex > 11 || Number.isNaN(weekdayIndex) || row.hour < 0 || row.hour > 23) continue;
      for (const [key] of whenMetrics) { month[monthIndex][key] += row[key]; weekday[weekdayIndex][key] += row[key]; hour[row.hour][key] += row[key]; }
    }
    return { month, weekday, hour };
  }, [slices]);
  const months = Array.from({ length: 12 }, (_, index) => new Intl.DateTimeFormat(language, { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, index, 1))));
  const weekdays = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(language, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, index + 1))));
  const points = (values: Record<WhenMetric, number>[]) => values.map((value, index) => ({ label: String(index), count: value[metric] }));
  const hourCounts = totals.hour.map(value => value[metric]);
  const hourMax = hourCounts.reduce((max, count) => Math.max(max, count), 1);
  return <section className="panel full-panel when-panel"><p className="eyebrow">{t("When?")}</p><h3>{t("When do you capture your media?")}</h3><div className="series-toggles">{whenMetrics.map(([key, label]) => <button type="button" key={key} className={metric === key ? 'primary' : 'secondary'} aria-pressed={metric === key} onClick={() => setMetric(key)}>{t(label)}</button>)}</div><div className="when-grid"><div><h4>{t("By month")}</h4><CountBars points={points(totals.month)} labels={months} kind="month" metric={metric} onExplore={onExplore} /></div><div><h4>{t("By weekday")}</h4><CountBars points={points(totals.weekday)} labels={weekdays} kind="weekday" metric={metric} onExplore={onExplore} /></div><div className="when-hours"><h4>{t("By hour")}</h4><div className="hour-bars">{hourCounts.map((count, hour) => <button type="button" key={hour} className="chart-clickable" aria-label={t("{hour} · {count} captures", { hour: `${String(hour).padStart(2, '0')}:00`, count: number(count) })} onClick={() => onExplore?.({ kind: 'hour', hour, metric })}><b className="hour-value">{number(count)}</b><span className={count > 0 && count === hourMax ? 'peak-bar' : ''} style={{ height: `${Math.max(2, count / hourMax * 100)}%` }} /><small>{String(hour).padStart(2, '0')}</small></button>)}</div></div></div></section>;
}

function AssetBrowser({ filter, revision, onBack }: { filter: AssetFilter; revision: string; onBack: () => void }) {
  const { t, language } = useLocale();
  const [result, setResult] = useState<AssetResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [browseError, setBrowseError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setBrowseError(''); setResult(null);
    request<AssetResult>('/me/assets/query', { method: 'POST', body: JSON.stringify({ ...filter, offset: 0, limit: 36 }), signal: controller.signal })
      .then(setResult).catch(err => { if (err.name !== 'AbortError') setBrowseError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filter, revision]);
  const loadMore = async () => {
    if (!result || moreLoading) return;
    setMoreLoading(true); setBrowseError('');
    try {
      const next = await request<AssetResult>('/me/assets/query', { method: 'POST', body: JSON.stringify({ ...filter, offset: result.items.length, limit: 36 }) });
      setResult(old => old ? { ...old, items: [...old.items, ...next.items], total: next.total } : next);
    } catch (err) { setBrowseError((err as Error).message); } finally { setMoreLoading(false); }
  };
  return <section className="asset-browser">
    <button className="secondary" onClick={onBack}>← {t("Back to statistics")}</button>
    <p className="eyebrow">{t("Assets in stored snapshot")}</p>
    <h2>{t("Matching media")}</h2>
    {result && <>
      <p className="asset-description">{describeAssetSelection(filter, t, language)}</p>
      <p className="muted">{t("{count} matching captures · {shown} shown", { count: number(result.total), shown: number(result.items.length) })}</p>
      {result.manufacturer_variants?.length > 0 && <details className="asset-models">
        <summary>{t("Original EXIF manufacturer names")} ({number(result.manufacturer_variants.length)})</summary>
        <div>{result.manufacturer_variants.map(entry => <span key={entry.name}>{entry.name} <b>{number(entry.count)}</b></span>)}</div>
      </details>}
      {result.models.length > 0 && <details className="asset-models" open>
        <summary>{t("Included models")} ({number(result.models.length)})</summary>
        <div>{result.models.map(model => <span key={model.name}>{displayDeviceName(model.name, t)} <b>{number(model.count)}</b></span>)}</div>
      </details>}
    </>}
    {loading && <p className="muted">{t("Searching matching assets in the local cache…")}</p>}
    {browseError && <p className="error">{t(browseError)}</p>}
    {result?.total === 0 && <p className="muted">{t("No assets are stored for this filter.")}</p>}
    <div className="asset-cards">{result?.items.map(item => <article className="asset-card" key={item.id}>
      <div className="asset-thumb">
        <img loading="lazy" src={`${API}/me/assets/${encodeURIComponent(item.id)}/thumbnail`} alt={item.filename} onError={event => { event.currentTarget.hidden = true; }} />
        <span>{item.type === 'VIDEO' ? t("Videos") : t("Photos")}</span>
      </div>
      <div className="asset-card-body">
        <b title={item.filename}>{item.filename}</b>
        <small>{item.taken_at ? new Date(item.taken_at).toLocaleString(language) : t("Capture date unknown")} · {displayDeviceName(item.device, t)}</small>
        {item.iso !== null && <small>ISO {number(item.iso)}{item.focal_mm !== null ? ` · ${decimal(item.focal_mm)} mm` : ''}</small>}
        {item.duration_seconds !== null && <small>{t("Video length")}: {durationLabel(item.duration_seconds, t)}</small>}
        <small>{item.size_bytes === null ? t("Original size unknown") : `${t("File size")}: ${megabytes(item.size_bytes)}`}</small>
      </div>
    </article>)}</div>
    {result && result.items.length < result.total && <button className="secondary load-more" onClick={loadMore} disabled={moreLoading}>{moreLoading ? t("Loading…") : t("Load 36 more")}</button>}
    <p className="muted tiny">{t("Thumbnails are loaded from Immich on demand. The selection and counts come from your stored profile snapshot.")}</p>
  </section>;
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  const { t } = useLocale();
  return <div className="metric"><span>{t(label)}</span><strong>{value}</strong>{note && <small>{t(note)}</small>}</div>;
}

function NumberFormatControl() {
  const { t, numberFormat, setNumberFormat } = useLocale();
  return <div className="number-format-control">
    <label>{t("Number format")}
      <select value={numberFormat} onChange={event => setNumberFormat(event.target.value as typeof numberFormat)}>
        <option value="auto">{t("Automatic for language")}</option>
        <option value="en-US">1,000.00</option>
        <option value="de-DE">1.000,00</option>
      </select>
    </label>
    <small>{t("Thousands and decimal separators")} · {t("Preview")}: {formatNumber(1000, { minimumFractionDigits: 2 })}</small>
    <small>{t("This changes separators in statistics and charts, not the stored values.")}</small>
  </div>;
}

function ProjectNotes() {
  const { t } = useLocale();
  return <section className="panel project-notes">
    <p className="eyebrow">{t("Notes")}</p>
    <h2>{t("About this project & what is next")}</h2>
    <p className="project-notes-intro">{t("Immich Insights began with a simple idea: make full use of the control you have over your own photos and videos. It turns library data into new perspectives on your memories, especially for a personal year-in-review.")}</p>
    <div className="project-notes-grid">
      <div><h3>{t("Understanding metadata")}</h3><p>{t("EXIF is not always consistent: manufacturers and devices store some details differently or omit them. Immich exposes selected, processed EXIF fields through its asset API, but not a general raw EXIF dump.")}</p><p>{t("An optional raw-metadata import or additional Immich API fields could eventually show flash usage, camera directions as a compass rose, and GPS altitudes as a hypsometric curve. Some original metadata also includes a 35 mm-equivalent focal length or camera details needed to derive one. Where available, it could make focal lengths and actual angles of view more comparable across cameras. We do not guess when reliable data is unavailable.")}</p></div>
      <div><h3>{t("Planned ideas")}</h3><p>{t("Filterable maps could highlight special captures such as your southernmost photo. Small Immich thumbnails could later reveal your personal color palette without permanently copying original files.")}</p><p>{t("A simple photo-book integration is another idea: a page or two could enrich your year-in-review with selected statistics.")}</p><p>{t("We are currently improving performance and working on more useful, better-looking downloads. The project will keep evolving; ideas and bug reports are welcome.")}</p></div>
      <div><h3>{t("Run it safely")}</h3><p>{t("This instance contains private library and location data. Prefer running it only on your home network; do not expose it directly to the internet. If remote access is necessary, use at least HTTPS and strong access controls.")}</p></div>
      <div><h3>{t("Tips for meaningful statistics")}</h3><p>{t("Accurate capture dates matter most: incorrect timestamps distort years, streaks, and maps. Keep screenshots separate from memory photos where possible. In large libraries, favorites often help more than hasty deletion.")}</p></div>
      <div><h3>{t("Made with AI, shaped by people")}</h3><p>{t("AI tools helped build parts of Immich Insights. The concept, product decisions, verification, and ongoing care still require substantial human work. It is not meant to replace Immich as a full-featured media viewer; it shows what your library data can reveal from another perspective.")}</p></div>
    </div>
    <div className="project-notes-actions"><a href="https://buymeacoffee.com/drnmwn4yhjr" target="_blank" rel="noopener noreferrer">{t("Support on Buy Me a Coffee")}</a><a href="https://github.com/laurinml/Immich-Insights/issues" target="_blank" rel="noopener noreferrer">{t("Open an issue or share feedback")}</a></div>
    <p className="muted tiny">{t("Found a bug or have an idea? Open a GitHub issue. If you would also like to support further development, a coffee is appreciated but never required.")}</p>
  </section>;
}

function ThemeToggle({ theme, onToggle, onLogin = false }: { theme: 'light' | 'dark'; onToggle: () => void; onLogin?: boolean }) {
  const { t } = useLocale();
  return <button type="button" className={`theme-toggle${onLogin ? ' auth-theme-toggle' : ''}`} onClick={onToggle} aria-label={t(theme === "dark" ? "Enable light mode" : "Enable dark mode")} aria-pressed={theme === 'dark'}><span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>{t(theme === "dark" ? "Light" : "Dark")}</button>;
}

const scoreDetails: Record<ScorePoint['key'], { title: string; radar: string; low: string; high: string; rule: string }> = {
  time: { title: "Time of day", radar: "Time of day", low: "Daylight", high: "Night", rule: "08:00–18:00: 0 · 06:00–08:00 & 18:00–22:00: 0.5 · 22:00–06:00: 1" },
  iso: { title: "ISO / light", radar: "ISO / light", low: "Bright light", high: "Low light", rule: "Up to ISO 400: 0 · 800–1600: 0.5 · ISO 3200+: 1; linear in between." },
  frequency: { title: "Capture frequency", radar: "Frequency", low: "Single shot", high: "Burst mode", rule: "Time since the previous photo: up to 5 s = 1 · 10 min or more = 0; linear in between." },
  orientation: { title: "Orientation", radar: "Format", low: "Landscape", high: "Portrait", rule: "Landscape: 0 · square: 0.5 · portrait: 1." },
  device: { title: "Capture device", radar: "Device", low: "Camera", high: "Mobile device", rule: "Camera: 0 · phone/tablet/iPod: 1 · other excluded." },
  media: { title: "Media mix", radar: "Media mix", low: "Photo", high: "Video", rule: "Photos: 0 · videos: 1. The score is the video share of all photos and videos." },
};

function ScorePanel({ scores }: { scores: ScorePoint[] }) {
  const { t } = useLocale();
  const ordered = (['time', 'iso', 'frequency', 'orientation', 'device', 'media'] as const).map(key => scores.find(score => score.key === key) ?? { key, value: null, eligible_count: 0, excluded_count: 0, population_count: 0 });
  const badges = [
    { key: "media", side: 'high', icon: '🎬', title: "Film architect", text: "You like telling stories in moving images." },
    { key: "media", side: 'low', icon: '📷', title: "Moment keeper", text: "One moment can carry your stories." },
    { key: 'time', side: 'high', icon: '🌙', title: "Night chronicler", text: "Your subjects begin where daylight ends." },
    { key: 'time', side: 'low', icon: '☀️', title: "Light collector", text: "You make use of daylight clarity." },
    { key: 'iso', side: 'high', icon: '✨', title: "Low-light seeker", text: "Challenging light does not stop you." },
    { key: 'frequency', side: 'high', icon: '⚡', title: "Moment hunter", text: "You capture fast action in bursts." },
    { key: 'orientation', side: 'high', icon: '↕️', title: "Portrait storyteller", text: "You often frame scenes vertically." },
    { key: 'orientation', side: 'low', icon: '↔️', title: "Wide-frame thinker", text: "You give your subjects room across the frame." },
    { key: "device", side: 'high', icon: '📱', title: "Pocket reporter", text: "Your camera is always with you." },
    { key: "device", side: 'low', icon: '📸', title: "Camera artist", text: "You often reach for a dedicated camera." },
  ].flatMap(badge => { const score = ordered.find(item => item.key === badge.key); return score?.value !== null && score?.value !== undefined && (badge.side === 'high' ? score.value >= 65 : score.value <= 35) ? [{ ...badge, strength: Math.abs(score.value - 50) }] : []; }).sort((a, b) => b.strength - a.strength).slice(0, 3);
  const point = (index: number, value: number) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / ordered.length;
    return { x: 200 + Math.cos(angle) * value * 1.13, y: 200 + Math.sin(angle) * value * 1.13 };
  };
  const points = (level: number) => ordered.map((_, index) => { const p = point(index, level); return `${p.x},${p.y}`; }).join(' ');
  const complete = ordered.every(score => score.value !== null);
  return <section className="panel score-panel"><p className="eyebrow">{t("Your tendencies")}</p><h3>{t("Between two poles")}</h3><p className="muted">{t("The marker shows your tendency. The exact method is listed under “Calculation”. This is not a rating.")}</p>
    <div className="profile-badges">{badges.length ? badges.map(badge => <div className="profile-badge" key={badge.title}><span aria-hidden="true">{badge.icon}</span><div><strong>{t(badge.title)}</strong><small>{t(badge.text)}</small></div></div>) : <p className="muted tiny">{t("Your photo personality appears once enough matching metadata is available.")}</p>}</div>
    <div className="score-layout"><svg viewBox="0 0 400 400" role="img" aria-label={t("Labeled radar chart of six tendencies")}>
      {[25, 50, 75, 100].map(level => <polygon key={level} points={points(level)} fill="none" stroke="var(--app-border)" strokeWidth="1" />)}
      {ordered.map((score, index) => { const end = point(index, 100); const label = point(index, 153); return <g key={score.key}><line x1="200" y1="200" x2={end.x} y2={end.y} stroke="var(--app-border)" /><text x={label.x} y={label.y} textAnchor={label.x > 218 ? 'end' : label.x < 182 ? 'start' : 'middle'} dominantBaseline="middle" fontSize="11" fill="var(--app-chart-ink)">{t(scoreDetails[score.key].radar)}</text></g>; })}
      {complete && <polygon points={ordered.map((score, index) => { const p = point(index, score.value!); return `${p.x},${p.y}`; }).join(' ')} fill="var(--app-accent)" fillOpacity=".22" stroke="var(--app-accent)" strokeWidth="2.5" />}
      {ordered.map((score, index) => { if (score.value === null) return null; const p = point(index, score.value); return <circle key={score.key} cx={p.x} cy={p.y} r="5" fill="var(--app-accent)"><title>{t(scoreDetails[score.key].title)}: {decimal(score.value, 1)} %</title></circle>; })}
    </svg><div className="score-cards">{ordered.map(score => { const detail = scoreDetails[score.key]; const low = t(detail.low), high = t(detail.high); const tendency = score.value === null ? t("Undetermined") : score.value < 45 ? t("Leaning toward {pole}", { pole: low }) : score.value > 55 ? t("Leaning toward {pole}", { pole: high }) : t("Evenly balanced"); const explanation = `${low} ↔ ${high}: ${score.value === null ? t("undetermined") : t("{percent}% toward {pole}", { percent: decimal(score.value, 1), pole: high })} · ${t(detail.rule)}`; return <div className="score-card" key={score.key}><div className="score-card-title"><b>{t(detail.title)}</b></div><div className="duel-track"><i className="duel-center" /><i className="duel-fill" style={{ left: `${Math.min(50, score.value ?? 50)}%`, width: `${Math.abs((score.value ?? 50) - 50)}%` }} /><i className="duel-marker" style={{ left: `${score.value ?? 50}%` }} title={explanation} /></div><div className="duel-reading"><strong className="duel-result">{tendency}</strong><span title={explanation}>{score.value === null ? "—" : `${decimal(score.value, 1)} %`} <small>{t("Tendency score")}</small></span></div><small>{t("{eligible} of {total} {kind} eligible", { eligible: number(score.eligible_count), total: number(score.population_count), kind: t(score.key === "media" ? "Media" : "Photos") })}{score.excluded_count ? t(" · {count} excluded", { count: number(score.excluded_count) }) : ''}</small><details><summary>{t("Calculation")}</summary><p>{t(detail.rule)}</p></details></div>; })}</div></div>
    {!complete && <p className="muted tiny">{t("Connections in the radar chart are missing when individual tendencies cannot be determined.")}</p>}
  </section>;
}

const scoreKeys: ScorePoint['key'][] = ['time', 'iso', 'frequency', 'orientation', 'device', 'media'];
function AnnualScoreChart({ years }: { years: AnnualScorePoint[] }) {
  const { t } = useLocale();
  const [selected, setSelected] = useState<ScorePoint['key'][]>(['time']);
  const [hovered, setHovered] = useState<number | null>(null);
  const [hoverPoint, setHoverPoint] = useState({ x: 0, y: 0 });
  const chart = useMemo(() => {
    const first = years[0]?.year ?? 0;
    const last = years.at(-1)?.year ?? first;
    const x = (year: number) => first === last ? 500 : 80 + (year - first) / (last - first) * 860;
    const y = (value: number) => 262 - value / 100 * 212;
    const paths = Object.fromEntries(scoreKeys.map(key => [key, smoothPath(years.flatMap((row, index) => {
      const value = row.scores[key];
      if (value === null || value === undefined) return [null];
      const point = [x(row.year), y(value)] as const;
      return index > 0 && years[index - 1].year !== row.year - 1 ? [null, point] : [point];
    }))])) as Record<ScorePoint['key'], string>;
    const ticks = [];
    if (years.length) {
      const step = Math.max(1, Math.ceil((last - first + 1) / 9));
      for (let year = first; year <= last; year += step) ticks.push({ year, x: x(year) });
      if (ticks.at(-1)?.year !== last) ticks.push({ year: last, x: x(last) });
    }
    return { x, y, paths, ticks };
  }, [years]);
  if (!years.length) return <p className="muted">{t("No dated photos or videos are available for an annual trend.")}</p>;
  const active = hovered === null ? null : years[hovered];
  const hitWidth = years.length === 1 ? 80 : Math.min(80, 860 / Math.max(1, years.at(-1)!.year - years[0].year + 1));
  const color = (key: ScorePoint['key']) => selected.length === 1 ? 'var(--app-accent)' : `var(--series-${scoreKeys.indexOf(key)})`;
  const tendency = (key: ScorePoint['key'], value: number | null | undefined) => value === null || value === undefined ? t("Undetermined") : value < 45 ? t("Leaning toward {pole}", { pole: t(scoreDetails[key].low) }) : value > 55 ? t("Leaning toward {pole}", { pole: t(scoreDetails[key].high) }) : t("Evenly balanced");
  return <><p className="muted tiny">{t("Choose one or more tendencies. Each point represents a capture year; gaps indicate years without matching captures.")}</p>
    <div className="annual-score-toggles">{scoreKeys.map(key => <button type="button" key={key} aria-pressed={selected.includes(key)} className={selected.includes(key) ? 'selected' : ''} onClick={() => { setSelected(current => current.includes(key) ? current.length > 1 ? current.filter(item => item !== key) : current : scoreKeys.filter(item => current.includes(item) || item === key)); setHovered(null); }}><i style={{ background: color(key) }} />{t(scoreDetails[key].title)}</button>)}</div>
    <div className="annual-score-plot"><svg viewBox="0 0 1000 305" role="img" aria-label={t("Annual trend of selected tendencies")}>
      <rect x="80" y="50" width="860" height="95" rx="12" fill="var(--app-track)" opacity=".55" />
      <rect x="80" y="167" width="860" height="95" rx="12" fill="var(--app-accent-soft)" opacity=".75" />
      {[0, 50, 100].map(value => <line key={value} x1="80" x2="940" y1={chart.y(value)} y2={chart.y(value)} stroke="var(--app-border)" strokeDasharray={value === 50 ? '4 5' : undefined} />)}
      {selected.length === 1 && <><text x="90" y="68" textAnchor="start" fontSize="12" fill="var(--app-muted-ink)">{t(scoreDetails[selected[0]].high)}</text><text x="90" y="253" textAnchor="start" fontSize="12" fill="var(--app-muted-ink)">{t(scoreDetails[selected[0]].low)}</text></>}<text x="90" y="160" textAnchor="start" fontSize="12" fill="var(--app-muted-ink)">{t("Evenly balanced")}</text>
      {chart.ticks.map(tick => <g key={tick.year}><line x1={tick.x} x2={tick.x} y1="50" y2="262" stroke="var(--app-border)" opacity=".45" /><text x={tick.x} y="292" textAnchor="middle" fontSize="12" fill="var(--app-muted-ink)">{tick.year}</text></g>)}
      {selected.map(key => <g key={key}><path d={chart.paths[key]} fill="none" stroke={color(key)} strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round" />{years.map(row => { const value = row.scores[key]; return value === null || value === undefined ? null : <circle key={row.year} cx={chart.x(row.year)} cy={chart.y(value)} r={hovered !== null && years[hovered].year === row.year ? 6 : 4} fill={color(key)} stroke="var(--app-surface)" strokeWidth="2" />; })}</g>)}
      {hovered !== null && <line x1={chart.x(years[hovered].year)} x2={chart.x(years[hovered].year)} y1="50" y2="262" stroke="var(--app-accent-ink)" strokeDasharray="4 3" pointerEvents="none" />}
      {years.map((row, index) => <rect key={row.year} x={chart.x(row.year) - hitWidth / 2} y="50" width={hitWidth} height="212" fill="transparent" tabIndex={0} aria-label={t("Capture year {year}", { year: row.year })} onPointerMove={event => { setHovered(index); setHoverPoint({ x: event.clientX, y: event.clientY }); }} onPointerLeave={() => setHovered(null)} onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setHovered(index); setHoverPoint({ x: rect.left, y: rect.top }); }} onBlur={() => setHovered(null)} />)}
    </svg>{active && <FloatingTooltip x={hoverPoint.x} y={hoverPoint.y} className="chart-tooltip-list"><b>{t("Capture year {year}", { year: active.year })}</b><small>{number(active.photo_count)} {t("Photos")} · {number(active.video_count)} {t("Videos")}</small>{selected.map(key => <span key={key}><i style={{ background: color(key) }} />{t(scoreDetails[key].title)}: {tendency(key, active.scores[key])} · {active.scores[key] === null || active.scores[key] === undefined ? '—' : `${decimal(active.scores[key]!, 1)} %`}</span>)}</FloatingTooltip>}</div>
    <p className="muted tiny">{t("The middle means balanced. Each metric’s second pole is at the top and first pole at the bottom. Capture frequency only compares photos within the same year.")}</p>
  </>;
}

function StoryAsset({ label, date, count, id, onExplore }: { label: string; date: string | null; count?: number; id: string | null; onExplore?: (filter: AssetFilter) => void }) {
  const { t, language } = useLocale();
  const dateLabel = date ? new Date(date.length === 10 ? `${date}T00:00:00Z` : date).toLocaleDateString(language, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: date.length === 10 ? 'UTC' : undefined }) : '—';
  return <button type="button" className="story-asset" disabled={!date || !onExplore} onClick={() => date && onExplore?.({ kind: 'date', date: date.slice(0, 10) })}>
    {id && <img src={`${API}/me/assets/${encodeURIComponent(id)}/thumbnail`} alt={label} loading="lazy" onError={event => { event.currentTarget.hidden = true; }} />}
    <span><small>{t(label)}</small><strong>{dateLabel}</strong>{count !== undefined && <em>{number(count)} {t("Assets")}</em>}</span>
  </button>;
}

function OrientationData({ data, onExplore }: { data: LibraryStats; onExplore?: (filter: AssetFilter) => void }) {
  const { t } = useLocale();
  const [type, setType] = useState<'assets' | 'photos' | 'videos'>('assets');
  return <div className="orientation-data"><h4>{t("Portrait and landscape")}</h4><div className="series-toggles">{(['assets', 'photos', 'videos'] as const).map(key => <button key={key} className={type === key ? 'primary' : 'secondary'} onClick={() => setType(key)}>{key === 'assets' ? 'Assets' : t(key === "photos" ? "Photos" : "Videos")}</button>)}</div><div className="storage-grid orientation-links">{([['portrait', "Portrait", data.portrait[type]], ['landscape', "Landscape", data.landscape[type]], ['unknown', "Unknown / square", data.orientation_unknown[type]]] as const).map(([orientation, label, count]) => <button key={orientation} type="button" className="orientation-link" disabled={!onExplore} onClick={() => onExplore?.({ kind: 'orientation', orientation, metric: type })}><span>{t(label)}</span><strong>{number(count)}</strong><small>{decimal(count / Math.max(1, data.portrait[type] + data.landscape[type] + data.orientation_unknown[type]) * 100)} % {t("of")} {type === 'assets' ? 'Assets' : t(type === "photos" ? "Photos" : "Videos")}</small></button>)}</div></div>;
}

function StatsView({ data, scope, selectedYear, rangeStart, rangeEnd, section, setSection, onExplore, onManageDevices, theme }: { data: LibraryStats; scope: Tab; selectedYear: number; rangeStart?: string; rangeEnd?: string; section: 'overview' | 'evolution'; setSection: (section: 'overview' | 'evolution') => void; onExplore?: (filter: AssetFilter) => void; onManageDevices?: () => void; theme: 'light' | 'dark' }) {
  const { t, language } = useLocale();
  const dateLabel = (value: string | null) => value ? new Date(value.length === 10 ? `${value}T00:00:00Z` : value).toLocaleDateString(language, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: value.length === 10 ? 'UTC' : undefined }) : '—';
  const [distributionKind, setDistributionKind] = useState<'iso' | 'focal' | 'exposure' | 'video'>('iso');
  const [focalDevice, setFocalDevice] = useState('');
  const [deviceFocalDistribution, setDeviceFocalDistribution] = useState<NumericDistribution | null>(null);
  const [focalLoading, setFocalLoading] = useState(false);
  const [focalError, setFocalError] = useState('');
  const [parameterAxis, setParameterAxis] = useState<'hour' | 'month'>('hour');
  useEffect(() => {
    if (!focalDevice) { setDeviceFocalDistribution(null); setFocalLoading(false); setFocalError(''); return; }
    let active = true;
    const params = new URLSearchParams({ device: focalDevice });
    if (scope === 'year') params.set('year', String(selectedYear));
    if (scope === 'range' && rangeStart && rangeEnd) { params.set('start', rangeStart); params.set('end', rangeEnd); }
    setDeviceFocalDistribution(null); setFocalError(''); setFocalLoading(true);
    request<NumericDistribution>(`/me/focal-distribution?${params}`).then(result => { if (active) setDeviceFocalDistribution(result); }).catch(error => { if (active) { setDeviceFocalDistribution(null); setFocalError((error as Error).message); } }).finally(() => { if (active) setFocalLoading(false); });
    return () => { active = false; };
  }, [focalDevice, scope, selectedYear, rangeStart, rangeEnd, data]);
  const exploreDistribution = (filter: AssetFilter) => onExplore?.(focalDevice && distributionKind === 'focal' ? { ...filter, source: 'device', name: focalDevice } : filter);
  const years = scope === 'year' ? data.months : data.years;
  const photosLabel = counted(data.photo_count, t("Photo"), t("Photos"));
  const videosLabel = counted(data.video_count, t("Video"), t("Videos"));
  const printComparison = (area: number) => area < 10 ? t("About {count} A4 pages", { count: decimal(area / (0.21 * 0.297), 1) }) : area < 1000 ? t("About {count} parking spaces (2.5 × 5 m)", { count: decimal(area / 12.5, 1) }) : t("About {count} doubles tennis courts", { count: decimal(area / (23.77 * 10.97), 1) });
  return <>
    {<div className="subnav"><button className={section === 'overview' ? 'selected' : ''} onClick={() => setSection('overview')}>{t("Overview")}</button><button className={section === 'evolution' ? 'selected' : ''} onClick={() => setSection('evolution')}>{t("Evolution")}</button></div>}
    {section === 'evolution' ? <div className="evolution">
      <section className="panel"><h3>{t("Cumulative by")} {t(scope === "year" ? "capture month" : "Capture year")}</h3><ComparisonChart years={years} onExplore={scope === 'library' ? onExplore : undefined} /></section>
      <section className="panel"><h3>{t("Average by")} {t(scope === "year" ? "capture month" : "Capture year")} · {t("MB per file")}</h3><ComparisonChart years={years} sizes onExplore={scope === 'library' ? onExplore : undefined} /></section>
      {scope === 'library' && <section className="panel"><p className="eyebrow">{t("Image quality over time")}</p><h3>{t("Photo resolution by capture year")}</h3><ResolutionDevelopment years={data.years} /></section>}
      {scope === 'library' && <section className="panel"><p className="eyebrow">{t("EXIF over time")}</p><h3>{t("Exposure settings by year")}</h3><ParameterChart slices={data.parameter_slices} axis="year" onExplore={onExplore} /></section>}
      {scope === 'library' && <section className="panel"><h3>{t("Captures per year & year-over-year change")}</h3><GrowthChart years={data.years} onExplore={onExplore} /></section>}
      {scope === 'library' && <section className="panel"><p className="eyebrow">{t("Device development")}</p><h3>{t("Which devices shaped your years?")}</h3><CameraStreamgraph slices={data.heatmap_slices} mode="cumulative" onExplore={onExplore} theme={theme} /></section>}
      {scope === 'library' && <section className="panel"><p className="eyebrow">{t("Annual contribution")}</p><h3>{t("Who contributed to the year?")}</h3><CameraStreamgraph slices={data.heatmap_slices} mode="yearly" onExplore={onExplore} theme={theme} /></section>}
      {scope === 'library' && <section className="panel"><p className="eyebrow">{t("Your tendencies")}</p><h3>{t("Between two poles · by year")}</h3><AnnualScoreChart years={data.annual_scores} /></section>}
      {scope === 'year' && <CalendarHeatmap days={data.days} slices={data.heatmap_slices} year={selectedYear} />}
    </div> : <div className="stats-overview">
      <section className="hero-card"><div><p className="eyebrow">{t("Your media")}</p><strong className="hero-number">{number(data.asset_count)}</strong><span>{data.asset_count === 1 ? "asset" : 'Assets'} {t("in total")}</span><div className="hero-pills"><b>{photosLabel}</b><b>{videosLabel}</b>{data.other_count > 0 && <b>{number(data.other_count)} {t("Others")}</b>}</div></div>{data.latest_photo_id && <figure className="latest-photo"><img src={`${API}/me/assets/${data.latest_photo_id}/thumbnail`} alt={t("Newest photo")} onError={event => { event.currentTarget.style.display = 'none'; }} /><figcaption>{t("Newest photo")}</figcaption></figure>}</section>
      <div className="metric-grid top-metrics">
        <Metric label="Favorites" value={number(data.favorite_count)} note="Media marked as favorites" />
        <Metric label="Your albums" value={data.album_count === null ? '—' : number(data.album_count)} note={scope === 'library' ? t("Albums created by you") : t("Albums with at least one asset in this period")} />
        <Metric label="Assets without album" value={data.unalbumed_asset_count === null ? '—' : number(data.unalbumed_asset_count)} note={data.unalbumed_asset_count === null ? t("Album membership unavailable") : t("{photos} photos · {videos} videos", { photos: number(data.unalbumed_photo_count ?? 0), videos: number(data.unalbumed_video_count ?? 0) })} />
      </div>
      <section className="panel full-panel"><p className="eyebrow">{t("Original files")}</p><h3>{t("Storage")}</h3><div className="storage-grid">
        <Metric label="Total storage" value={bytes(data.total_bytes)} note={data.missing_size_count ? t("{count} file sizes missing", { count: number(data.missing_size_count) }) : t("Original files according to Immich")} />
        <Metric label="Photo storage" value={bytes(data.photo_bytes)} note="Original sizes of all photos, when complete" />
        <Metric label="Video storage" value={bytes(data.video_bytes)} note="Original sizes of all videos, when complete" />
        <Metric label="Avg. per asset" value={megabytes(data.average_asset_bytes)} note="Only when all original sizes are known" />
        <Metric label="Avg. per photo" value={megabytes(data.average_photo_bytes)} note="Only when all photo sizes are known" />
        <Metric label="Avg. per video" value={megabytes(data.average_video_bytes)} note="Only when all video sizes are known" />
      </div></section>
      <section className="panel full-panel"><p className="eyebrow">{t("For perspective")}</p><h3>{t("Your library in numbers")}</h3><div className="storage-grid"><Metric label="Total binary digits" value={data.bit_count === null ? '—' : number(data.bit_count)} note="Number of bits in the original files" /><Metric label="1 bit = 1 second" value={data.bit_count === null ? "—" : `${decimal(data.bit_count / (365.2425 * 24 * 3600), 1)} ${t("Years")}`} note="Illustrative time comparison" /><Metric label="As grains of sand" value={data.sand_cubic_meters === null ? '—' : `${decimal(data.sand_cubic_meters, 2)} m³`} note="1 bit = 1 grain (Ø 0.25 mm, 64% packing)" /><Metric label="All photos as 10 × 15 cm prints" value={`${decimal(data.print_area_square_meters, 2)} m²`} note={printComparison(data.print_area_square_meters)} /><Metric label="Height of the print stack" value={`${decimal(data.print_stack_meters, 2)} m`} note="0.2 mm per 10 × 15 cm print" /><Metric label="Weight of all prints" value={`${decimal(data.print_weight_kg, 2)} kg`} note="2 g per 10 × 15 cm print" /><Metric label="Cost of all photo prints" value={`${formatNumber(data.photo_count * PRINT_ESTIMATE_EUR, { style: "currency", currency: "EUR" })}`} note="Estimate at 7 cents per 10 × 15 cm print, excluding shipping" /><Metric label="Value of your memories" value="∞" note="Priceless" /></div></section>
      <div className="single-col">
        <section className="panel"><p className="eyebrow">{t("Captures")}</p><h3>{t("Technique & time")}</h3><div className="fact-list technique-facts"><Metric label="Average photo resolution" value={data.average_megapixels === null ? '—' : `${decimal(data.average_megapixels, 1)} MP`} note={t("{count} with known resolution", { count: counted(data.resolution_count, t("Photo"), t("Photos")) })} /><Metric label="Most common ISO" value={data.most_used_iso === null ? '—' : `ISO ${number(data.most_used_iso)}`} note={t("{count} photos with exactly this value", { count: number(data.iso_distribution.mode_count) })} /><Metric label="Most common focal length" value={data.most_used_focal_length_mm === null ? '—' : `${decimal(data.most_used_focal_length_mm)} mm`} note={t("{count} photos with exactly this value", { count: number(data.focal_distribution.mode_count) })} /><Metric label="Most common shutter speed" value={shutterLabel(data.exposure_distribution.mode)} note={t("{count} photos with exactly this value", { count: number(data.exposure_distribution.mode_count) })} /><Metric label="Total video duration" value={durationLabel(data.video_duration_seconds, t)} note={t("{count} standalone videos with known duration", { count: number(data.video_duration_distribution.sample_count) })} /><Metric label="Average video length" value={data.average_video_duration_seconds === null ? '—' : durationLabel(data.average_video_duration_seconds, t)} note={t("{count} standalone videos with known duration", { count: number(data.video_duration_distribution.sample_count) })} /><Metric label="Cumulative exposure time" value={durationLabel(data.exposure_seconds, t)} note={t("{count} photos with shutter speed", { count: number(data.exposure_distribution.sample_count) })} /></div></section></div>
      <section className="panel full-panel"><p className="eyebrow">{t("Image formats")}</p><h3>{t("Which image dimensions occur?")}</h3><FrameChart frames={data.frame_formats} covered={data.frame_format_covered_count} photoCount={data.photo_count} onExplore={onExplore} /><OrientationData data={data} onExplore={onExplore} /></section>
      <div className="two-col metadata-cards"><section className="panel"><p className="eyebrow">{t("Metadata")}</p><h3>{t("People")}</h3><div className="fact-list"><Metric label="Photos with people" value={number(data.photos_with_people_count)} note="Photos with at least one detected face" /><Metric label="Categorized people" value={number(data.person_count)} note="Unique person IDs in the snapshot" /><Metric label="Total detected people" value={number(data.detected_people_count)} note="Person associations across all assets" /><Metric label="Avg. people per photo with people" value={data.people_per_photo_with_people === null ? '—' : decimal(data.people_per_photo_with_people, 2)} note="Only photos with detected faces" /><Metric label="Avg. people per photo overall" value={data.people_per_photo === null ? '—' : decimal(data.people_per_photo, 2)} note="Including photos without detected faces" /></div></section>
        <section className="panel"><p className="eyebrow">{t("Metadata")}</p><h3>{t("Places")}</h3><div className="fact-list"><Metric label="Assets with location data" value={number(data.geotagged_count)} note="Assets with latitude and longitude" /><Metric label="Countries with location data" value={number(data.country_count)} note={data.top_country ? t("Most common: {country} ({count} assets)", { country: data.top_country, count: number(data.top_country_asset_count) }) : t("No country information available")} /><Metric label="Continents with location data" value={number(data.continent_count)} note={data.continents.length ? data.continents.map(continent => t(continent)).join(' · ') : t("No continents can be determined")} /></div></section></div>
      <section className="panel time-panel"><p className="eyebrow">{t("Time span")}</p><h3>{t("From the beginning to today")}</h3><div className="story-grid"><StoryAsset label="First capture" date={data.first_date} id={data.first_asset_id} onExplore={onExplore} /><StoryAsset label="Last capture" date={data.last_date} id={data.last_asset_id} onExplore={onExplore} /><StoryAsset label="Busiest day" date={data.busiest_day} count={data.busiest_day_count} id={data.busiest_day_asset_id} onExplore={onExplore} /></div><div className="fact-list time-facts five"><Metric label={data.photo_days_year === null ? "Days with photos" : t("Days with photos {year}", { year: data.photo_days_year })} value={t("{count} days", { count: number(data.photo_days_count) })} note={data.photo_days_percent === null ? undefined : `${t("{percent}% of {count} calendar days", { percent: decimal(data.photo_days_percent), count: number(data.photo_days_total_days) })}${scope === 'library' ? t(" · first to last capture") : ''}`} /><Metric label="Date range" value={data.timespan_days === null ? '—' : t("{count} days", { count: number(data.timespan_days) })} note={data.undated_count ? t("{count} assets without capture date", { count: number(data.undated_count) }) : undefined} /><Metric label="Longest break" value={t("{count} days", { count: number(data.longest_pause_days) })} note={data.longest_pause_start ? t("{start} to {end}", { start: dateLabel(data.longest_pause_start), end: dateLabel(data.longest_pause_end) }) : undefined} /><Metric label="Longest daily streak" value={t("{count} days", { count: number(data.longest_day_streak) })} note={data.longest_day_streak_start ? t("{start} to {end}", { start: dateLabel(data.longest_day_streak_start), end: dateLabel(data.longest_day_streak_end) }) : undefined} /><Metric label="Longest weekly streak" value={t("{count} weeks", { count: number(data.longest_week_streak) })} note={data.longest_week_streak_start ? t("{start} to {end}", { start: dateLabel(data.longest_week_streak_start), end: dateLabel(data.longest_week_streak_end) }) : undefined} /></div></section>
      {scope === 'library' && <MediaTimeline events={data.timeline} apiBase={API} onExplore={onExplore} />}
      <section className="panel"><p className="eyebrow">{t("Cameras & devices")}</p><div className="section-heading"><h3>{t("What was it shot with?")}</h3><button type="button" className="text-button" onClick={onManageDevices}>{t("Correct devices")}</button></div>{data.devices.length ? <DeviceChart devices={data.devices} rawManufacturers={data.raw_manufacturers} onExplore={onExplore} theme={theme} /> : <p>{t("No device information available.")}</p>}</section>
      <section className="panel photo-distributions"><p className="eyebrow">{t("Metadata")}</p><h3>{t("Exposure settings distribution")}</h3><div className="distribution-switch segmented">{([['iso', 'ISO'], ['focal', "Focal length"], ['exposure', "Exposure time"], ['video', "Video length"]] as const).map(([kind, label]) => <button type="button" key={kind} className={distributionKind === kind ? 'selected' : ''} onClick={() => setDistributionKind(kind)}>{t(label)}</button>)}</div>{distributionKind === 'focal' && <label className="focal-device-select">{t("Device")}<select value={focalDevice} onChange={event => setFocalDevice(event.target.value)}><option value="">{t("All devices")}</option>{data.devices.filter(device => device.photos > 0).map(device => <option key={device.name} value={device.name}>{displayDeviceName(device.name, t)} · {number(device.photos)}</option>)}</select></label>}{focalLoading ? <p className="muted">{t("Loading focal lengths from stored EXIF values…")}</p> : focalError && distributionKind === 'focal' ? <p className="error">{t(focalError)}</p> : <DistributionChart key={`${distributionKind}:${focalDevice}`} distribution={distributionKind === 'focal' ? deviceFocalDistribution ?? data.focal_distribution : distributionKind === 'iso' ? data.iso_distribution : distributionKind === 'exposure' ? data.exposure_distribution : data.video_duration_distribution} kind={distributionKind} onExplore={exploreDistribution} />}<p className="muted tiny">{t("Focal lengths are taken unchanged from each photo’s focalLength. Click a bar to see those exact assets. The device filter only reads the stored snapshot.")}</p></section>
      {scope === 'library' && <section className="panel"><p className="eyebrow">{t("Focal length comparison")}</p><h3>{t("Your five most frequent original focal lengths")}</h3><label className="focal-device-select">{t("Device")}<select value={focalDevice} onChange={event => setFocalDevice(event.target.value)}><option value="">{t("All devices")}</option>{data.devices.filter(device => device.photos > 0).map(device => <option key={device.name} value={device.name}>{displayDeviceName(device.name, t)} · {number(device.photos)}</option>)}</select></label>{focalLoading ? <p className="muted">{t("Loading focal lengths from stored EXIF values…")}</p> : focalError ? <p className="error">{t(focalError)}</p> : <FocalFieldOfView distribution={deviceFocalDistribution ?? data.focal_distribution} onExplore={filter => onExplore?.(focalDevice ? { ...filter, source: 'device', name: focalDevice } : filter)} theme={theme} />}</section>}
      <ExposureTriangle points={data.exposure_points} photoCount={data.photo_count} theme={theme} onExplore={onExplore} />
      <CalendarHeatmap days={data.days} slices={data.heatmap_slices} year={scope === 'year' ? selectedYear : undefined} onExplore={onExplore} />
      {scope !== 'year' && <CalendarHeatmap days={data.days} slices={data.heatmap_slices} anniversary onExplore={onExplore} />}
      <WeekHourHeatmap slices={data.heatmap_slices} onExplore={onExplore} />
      <WhenCharts slices={data.heatmap_slices} onExplore={onExplore} />
      <section className="panel full-panel parameter-time-panel"><p className="eyebrow">{t("EXIF by time of day and month")}</p><div className="section-heading"><h3>{t("ISO, focal length & aperture by {axis}", { axis: t(parameterAxis === "hour" ? "Time of day" : "Month") })}</h3><div className="segmented"><button type="button" className={parameterAxis === 'hour' ? 'selected' : ''} onClick={() => setParameterAxis('hour')}>{t("Time of day")}</button><button type="button" className={parameterAxis === 'month' ? 'selected' : ''} onClick={() => setParameterAxis('month')}>{t("Month")}</button></div></div><ParameterChart slices={data.parameter_slices} axis={parameterAxis} onExplore={onExplore} /></section>
      {scope !== 'library' && <ScorePanel scores={data.scores} />}
    </div>}
  </>;
}

function App() {
  const { language, setLanguage, t } = useLocale();
  const [theme, setTheme] = useState<'light' | 'dark'>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [accent, setAccent] = useState<'green' | 'purple' | 'blue' | 'amber'>(() => {
    try { const saved = localStorage.getItem('immich-insights-accent'); return saved === 'purple' || saved === 'blue' || saved === 'amber' ? saved : 'green'; }
    catch { return 'green'; }
  });
  const [palette, setPalette] = useState<'balanced' | 'vivid' | 'calm' | 'aurora' | 'colorblind'>(() => {
    try { const saved = localStorage.getItem('immich-insights-chart-palette'); return saved === 'vivid' || saved === 'calm' || saved === 'aurora' || saved === 'colorblind' ? saved : 'balanced'; }
    catch { return 'balanced'; }
  });
  const [auth, setAuth] = useState<Auth | null>(null);
  const [booting, setBooting] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [tab, setTab] = useState<Tab>('library');
  const [section, setSection] = useState<'overview' | 'evolution'>('overview');
  const [drilldown, setDrilldown] = useState<AssetFilter | null>(null);
  const browseScroll = useRef<number | null>(null);
  const [year, setYear] = useState(new Date().getFullYear());
  const [range, setRange] = useState({ start: '', end: '' });
  const [data, setData] = useState<LibraryStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [exportInfo, setExportInfo] = useState<ExportInfo | null>(null);
  const [reportInfo, setReportInfo] = useState<ReportInfo | null>(null);
  const [exportError, setExportError] = useState('');
  const [exportLoading, setExportLoading] = useState(false);
  const views = useRef(new Map<string, LibraryStats>());
  const exportViews = useRef(new Map<string, ExportInfo>());
  const reportViews = useRef(new Map<string, ReportInfo>());
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [deletingMember, setDeletingMember] = useState<number | null>(null);
  const [deletePhrase, setDeletePhrase] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [connectionState, setConnectionState] = useState<{ ok: boolean; message: string; checkedAt: string } | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [inviteLink, setInviteLink] = useState('');
  const [loginForm, setLoginForm] = useState({ name: '', email: '', password: '' });
  const [profileForm, setProfileForm] = useState({ name: '', profile_icon: 'camera' });
  const profileSaveVersion = useRef(0);
  const [immichForm, setImmichForm] = useState({ immich_url: '', api_key: '' });
  const [passwordForm, setPasswordForm] = useState({ current_password: '', new_password: '' });
  const [inviteForm, setInviteForm] = useState({ name: '', email: '' });
  const inviteToken = new URLSearchParams(window.location.search).get('invite');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
    document.documentElement.dataset.palette = palette;
    try { localStorage.setItem('immich-insights-accent', accent); } catch { /* Local preference is optional. */ }
    try { localStorage.setItem('immich-insights-chart-palette', palette); } catch { /* Local preference is optional. */ }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? accent === 'purple' ? '#18121f' : accent === 'blue' ? '#101a24' : accent === 'amber' ? '#241b13' : '#101c17' : accent === 'purple' ? '#57357d' : accent === 'blue' ? '#1d5286' : accent === 'amber' ? '#88490b' : '#143e2a');
  }, [theme, accent, palette]);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-color-scheme: dark)');
    const followSystem = () => { try { if (!localStorage.getItem('immich-insights-theme')) setTheme(preference.matches ? 'dark' : 'light'); } catch { /* Storage can be unavailable. */ } };
    preference.addEventListener('change', followSystem);
    return () => preference.removeEventListener('change', followSystem);
  }, []);
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem('immich-insights-theme', next); } catch { /* Keep the in-memory choice. */ }
  };

  useEffect(() => {
    if (inviteToken) { setBooting(false); return; }
    request<Auth>('/auth/me').then(result => { csrfToken = result.csrf_token; setAuth(result); }).catch(() => request<{ needs_setup: boolean }>('/auth/setup').then(result => setNeedsSetup(result.needs_setup))).finally(() => setBooting(false));
  }, []);
  useEffect(() => { if (auth) setProfileForm({ name: auth.user.name, profile_icon: auth.user.profile_icon }); }, [auth?.user.id]);
  useEffect(() => { if (auth) setImmichForm(form => ({ ...form, immich_url: auth.user.immich_url ?? '' })); }, [auth?.user.id, auth?.user.immich_url]);
  useEffect(() => {
    if (!auth || !profileForm.name.trim() || (profileForm.name.trim() === auth.user.name && profileForm.profile_icon === auth.user.profile_icon)) return;
    const version = ++profileSaveVersion.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      request<User>('/me/profile', { method: 'PUT', body: JSON.stringify({ name: profileForm.name.trim(), profile_icon: profileForm.profile_icon }), signal: controller.signal })
        .then(user => { if (version === profileSaveVersion.current) setAuth(old => old && { ...old, user }); })
        .catch(err => { if (err.name !== 'AbortError' && version === profileSaveVersion.current) setError((err as Error).message); });
    }, profileForm.profile_icon !== auth.user.profile_icon ? 150 : 600);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [auth?.user.id, auth?.user.name, auth?.user.profile_icon, profileForm.name, profileForm.profile_icon]);
  useEffect(() => { if (auth && tab === 'profile') { request<{ permissions: Permission[] }>('/me/capabilities').then(result => setPermissions(result.permissions)).catch(() => {}); if (auth.user.is_admin) request<Member[]>('/admin/users').then(setMembers).catch(() => {}); } }, [auth?.user.id, tab]);
  useEffect(() => {
    if (!auth?.user.has_api_key) { setSync(null); return; }
    let active = true;
    const poll = () => request<SyncStatus>('/me/sync').then(value => { if (active) setSync(value); }).catch(() => {});
    poll();
    const timer = window.setInterval(poll, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [auth?.user.id, auth?.user.has_api_key, refresh]);
  useEffect(() => {
    if (drilldown) window.scrollTo(0, 0);
    else if (browseScroll.current !== null) {
      window.scrollTo(0, browseScroll.current);
      browseScroll.current = null;
    }
  }, [drilldown]);
  const explore = (filter: AssetFilter) => {
    browseScroll.current = window.scrollY;
    setDrilldown(tab === 'year' ? { ...filter, scope_year: year } : tab === 'range' ? { ...filter, scope_start: range.start, scope_end: range.end } : filter);
  };
  useEffect(() => {
    if (!auth?.user.has_api_key || !sync?.revision) { setExportInfo(null); return; }
    const key = `${auth.user.id}:${sync.revision}`;
    const saved = exportViews.current.get(key);
    if (saved) { setExportInfo(saved); setExportLoading(false); return; }
    const controller = new AbortController();
    setExportInfo(null); setExportLoading(true); setExportError('');
    request<ExportInfo>('/me/export/sqlite/info', { signal: controller.signal }).then(result => { exportViews.current.set(key, result); setExportInfo(result); }).catch(err => { if (err.name !== 'AbortError') setExportError(err.message); }).finally(() => { if (!controller.signal.aborted) setExportLoading(false); });
    return () => controller.abort();
  }, [auth?.user.id, auth?.user.has_api_key, sync?.revision]);
  useEffect(() => {
    if (!auth?.user.has_api_key || !sync?.revision || tab !== 'download') return;
    const key = `${auth.user.id}:${sync.revision}`;
    const saved = reportViews.current.get(key);
    if (saved) { setReportInfo(saved); return; }
    setReportInfo(null);
    request<ReportInfo>('/me/export/reports/info').then(result => {
      reportViews.current.set(key, result); setReportInfo(result);
    }).catch(err => setExportError((err as Error).message));
  }, [tab, auth?.user.id, auth?.user.has_api_key, sync?.revision]);
  const synchronizeNow = async () => {
    setError('');
    try {
      await request('/me/sync', { method: 'POST' });
      setSync(await request<SyncStatus>('/me/sync'));
    } catch (err) { setError((err as Error).message); }
  };
  useEffect(() => {
    if (!auth?.user.has_api_key || !sync?.revision || tab === 'profile' || tab === 'download' || (tab === 'range' && (!range.start || !range.end))) { setData(null); return; }
    const controller = new AbortController();
    const query = tab === 'year' ? `?year=${year}` : tab === 'range' ? `?start=${range.start}&end=${range.end}` : '';
    const cacheKey = `${auth.user.id}:${sync.revision}:${query}`;
    const saved = views.current.get(cacheKey);
    if (saved) { setData(saved); setLoading(false); return; }
    setData(null); setLoading(true); setError('');
    request<LibraryStats>(`/me/library${query}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      if (views.current.size >= 30) views.current.clear();
      views.current.set(cacheKey, result); setData(result);
    }).catch(err => { if (err.name !== 'AbortError') setError(err.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [auth?.user.id, auth?.user.has_api_key, tab, year, range.start, range.end, sync?.revision]);

  const authenticate = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    try {
      const endpoint = inviteToken ? '/auth/accept-invite' : needsSetup ? '/auth/bootstrap' : '/auth/login';
      const body = inviteToken ? { token: inviteToken, password: loginForm.password } : needsSetup ? loginForm : { email: loginForm.email, password: loginForm.password };
      const result = await request<Auth>(endpoint, { method: 'POST', body: JSON.stringify(body) });
      csrfToken = result.csrf_token; setAuth(result); setTab('library');
      if (inviteToken) window.history.replaceState({}, '', window.location.pathname);
    } catch (err) { setError((err as Error).message); }
  };
  const logout = async () => {
    try {
      await request('/auth/logout', { method: 'POST' });
      views.current.clear(); exportViews.current.clear(); reportViews.current.clear(); csrfToken = ''; setAuth(null); setData(null); setSync(null); setExportInfo(null); setReportInfo(null); setDrilldown(null); setNeedsSetup(false); setNotice(''); setError('');
    } catch (err) { setError(`Abmeldung fehlgeschlagen: ${(err as Error).message}`); }
  };
  const saveImmich = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setNotice('');
    try { const user = await request<User>('/me/immich', { method: 'PUT', body: JSON.stringify(immichForm) }); setAuth(old => old && { ...old, user }); setImmichForm({ ...immichForm, api_key: '' }); setEditingKey(false); setConnectionState(null); views.current.clear(); exportViews.current.clear(); reportViews.current.clear(); setSync(null); setData(null); setExportInfo(null); setReportInfo(null); setNotice(t("Immich connection saved. Test it with the button now.")); setRefresh(value => value + 1); } catch (err) { setError((err as Error).message); }
  };
  const checkConnection = async () => {
    setError(''); setNotice(''); setConnectionState(null); setCheckingConnection(true);
    try { const result = await request<{ message: string }>('/me/connection', { method: 'POST' }); setConnectionState({ ok: true, message: result.message, checkedAt: new Date().toLocaleString(language === 'en' ? 'en-GB' : 'de-DE') }); const updated = await request<Auth>('/auth/me'); csrfToken = updated.csrf_token; setAuth(updated); setRefresh(value => value + 1); } catch (err) { setConnectionState({ ok: false, message: (err as Error).message, checkedAt: new Date().toLocaleString(language === 'en' ? 'en-GB' : 'de-DE') }); } finally { setCheckingConnection(false); }
  };
  const changePassword = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setNotice('');
    try { await request('/me/password', { method: 'PUT', body: JSON.stringify(passwordForm) }); setPasswordForm({ current_password: '', new_password: '' }); setNotice(t("Password changed.")); } catch (err) { setError((err as Error).message); }
  };
  const invite = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setNotice('');
    try { const result = await request<{ user: Member; token: string }>('/admin/users', { method: 'POST', body: JSON.stringify(inviteForm) }); setInviteLink(`${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(result.token)}`); setInviteForm({ name: '', email: '' }); setMembers(old => [...old, result.user]); } catch (err) { setError((err as Error).message); }
  };
  const renewInvitation = async (member: Member) => {
    setError(''); setNotice('');
    try { const result = await request<{ token: string }>(`/admin/users/${member.id}/invite`, { method: 'POST' }); setInviteLink(`${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(result.token)}`); setNotice(t("New invitation link created for {name}.", { name: member.name })); } catch (err) { setError((err as Error).message); }
  };
  const removeMember = async (member: Member) => {
    if (deletePhrase !== 'delete' || member.is_admin || member.id === auth?.user.id) return;
    setError('');
    try {
      await request(`/admin/users/${member.id}`, { method: 'DELETE', body: JSON.stringify({ confirmation: deletePhrase }) });
      setMembers(current => current.filter(item => item.id !== member.id));
      setDeletingMember(null); setDeletePhrase('');
      setNotice(t("{name} and the stored account data were deleted.", { name: member.name }));
    } catch (err) { setError((err as Error).message); }
  };

  if (booting) return <main className="auth-shell"><ThemeToggle theme={theme} onToggle={toggleTheme} onLogin /><p>{t("Loading Immich Insights…")}</p></main>;
  if (!auth) return <main className="auth-shell"><ThemeToggle theme={theme} onToggle={toggleTheme} onLogin /><div className="auth-card"><p className="eyebrow">IMMICH INSIGHTS</p><h1>{t(inviteToken ? "Accept invitation." : needsSetup ? "Welcome. Set up your account." : "Welcome back.")}</h1><p className="muted">{t(inviteToken ? "Set your own password. Then you can add your Immich API key." : needsSetup ? "The first account automatically becomes admin and can invite others." : "Sign in to see only your own library.")}</p>{error && <p className="error">{t(error)}</p>}<form onSubmit={authenticate}>{needsSetup && !inviteToken && <label>{t("Name")}<input required value={loginForm.name} onChange={event => setLoginForm({ ...loginForm, name: event.target.value })} /></label>}{!inviteToken && <label>{t("Email")}<input required type="email" value={loginForm.email} onChange={event => setLoginForm({ ...loginForm, email: event.target.value })} /></label>}<label>{t("Password")}<input required minLength={inviteToken || needsSetup ? 12 : undefined} type="password" value={loginForm.password} onChange={event => setLoginForm({ ...loginForm, password: event.target.value })} /></label><button className="primary">{t(inviteToken ? "Activate account" : needsSetup ? "Create admin account" : "Sign in")}</button></form>{(needsSetup || inviteToken) && <p className="muted tiny">{t("Use at least 12 characters for your password.")}</p>}</div></main>;

  const title = tab === 'year' ? `${t("Year highlights")} ${year}` : tab === 'range' ? t("Your date range") : tab === 'photo_profile' ? t("Your photo profile") : tab === 'download' ? t("Download your data") : t("Your library");
  return <main><header className="site-head"><div><p className="eyebrow">IMMICH INSIGHTS</p><h1>{t("Your photo library,")}<br />{t("at a glance.")}</h1></div><div className="account"><ThemeToggle theme={theme} onToggle={toggleTheme} /><button className="avatar-button" onClick={() => setTab('profile')} aria-label={t("Open profile")}><span>{icons[auth.user.profile_icon] ?? '📷'}</span>{auth.user.profile_icon === 'immich' && auth.user.has_immich_avatar && <img src={`${API}/me/avatar`} alt="" onError={event => { event.currentTarget.style.display = 'none'; }} />}</button><div className="account-identity"><strong>{auth.user.name}</strong><small>{auth.user.is_admin ? t("Administrator") : t("Member")}</small></div></div></header>
    <nav>{([['library', "Library"], ['year', "Year highlights"], ['range', "Date range"], ['photo_profile', "Photo profile"], ['download', 'Download'], ['profile', "Profile"]] as const).map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => { setTab(key); setDrilldown(null); browseScroll.current = null; setSection('overview'); setError(''); setNotice(''); }}>{t(label)}</button>)}</nav>
    {error && <p className="error">{t(error)}</p>}{notice && <p className="success">{notice}</p>}
    {tab === 'profile' ? <div className="profile-layout"><section className="panel"><p className="eyebrow">{t("Your account")}</p><h2>{t("Profile")}</h2><div className="profile-fields"><label>{t("Display name")}<input required value={profileForm.name} onChange={event => setProfileForm({ ...profileForm, name: event.target.value })} /></label><p className="field-label">{t("Profile icon")}</p><div className="icon-picker">{Object.entries(icons).map(([key, icon]) => <button type="button" key={key} className={profileForm.profile_icon === key ? 'selected' : ''} onClick={() => setProfileForm({ ...profileForm, profile_icon: key })} aria-label={`Icon ${key}`}>{icon}</button>)}{auth.user.has_immich_avatar && <button type="button" className={`immich-avatar-option ${profileForm.profile_icon === 'immich' ? 'selected' : ''}`} onClick={() => setProfileForm({ ...profileForm, profile_icon: 'immich' })} aria-label={t("Use Immich profile photo")} title={t("Use Immich profile photo")}><img src={`${API}/me/avatar`} alt="" /></button>}</div></div><p className="muted tiny">{t("Name and profile image are saved automatically. The Immich photo requires the optional avatar permission.")}</p><div className="appearance-settings"><h3>{t("Appearance & language")}</h3><label>{t("Accent color")}<div className="accent-options" role="radiogroup" aria-label={t("Accent color")}>{([['green', t("Green")], ['purple', t("Purple")], ['blue', t("Blue")], ['amber', t("Amber")]] as const).map(([value, name]) => <button type="button" key={value} role="radio" className={`accent-choice ${value} ${accent === value ? 'selected' : ''}`} aria-checked={accent === value} onClick={() => setAccent(value)}>{name}</button>)}</div></label><label>{t("Chart palette")}<select value={palette} onChange={event => setPalette(event.target.value as typeof palette)}><option value="balanced">{t("Balanced")}</option><option value="vivid">{t("Vivid")}</option><option value="calm">{t("Calm")}</option><option value="aurora">{t("Aurora")}</option><option value="colorblind">{t("Colorblind-friendly")}</option></select><span className="palette-preview" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <i key={index} style={{ background: `var(--series-${index})` }} />)}</span></label><label>{t("Language")}<select value={language} onChange={event => setLanguage(event.target.value as Language)}>{languageOptions.map(option => <option key={option.code} value={option.code}>{option.label}</option>)}</select></label><NumberFormatControl /></div><button type="button" className="secondary profile-logout" onClick={logout}>{t("Sign out")}</button></section>
      <section className="panel"><p className="eyebrow">{t("Private to you")}</p><h2>{t("Immich connection")}</h2><div className={`connection-summary ${connectionState?.ok ? 'ok' : connectionState ? 'failed' : ''}`} role="status"><strong>{auth.user.has_api_key ? `✓ ${t("API key saved")}` : t("No API key saved")}</strong><small>{auth.user.immich_url || t("No Immich URL saved yet")}</small>{checkingConnection && <span>{t("Checking connection…")}</span>}{connectionState && <><span>{connectionState.ok ? '✓' : '✕'} {t(connectionState.message)}</span><small>{t("Last checked")}: {connectionState.checkedAt}</small></>}</div>{(!auth.user.has_api_key || editingKey) && <form onSubmit={saveImmich}><label>Immich-URL<input required type="url" placeholder="https://photos.example.net" value={immichForm.immich_url} onChange={event => setImmichForm({ ...immichForm, immich_url: event.target.value })} /></label><label>{auth.user.has_api_key ? t("New API key") : 'API-Key'}<input required type="password" autoComplete="off" value={immichForm.api_key} onChange={event => setImmichForm({ ...immichForm, api_key: event.target.value })} /></label><div className="connection-actions"><button className="primary">{t("Save connection")}</button>{auth.user.has_api_key && <button type="button" className="secondary" onClick={() => { setEditingKey(false); setImmichForm(old => ({ ...old, api_key: '' })); }}>{t("Cancel")}</button>}</div></form>}<div className="connection-actions">{auth.user.has_api_key && <><button type="button" className="secondary" disabled={checkingConnection} onClick={checkConnection}>{checkingConnection ? t("Checking…") : t("Test connection")}</button>{!editingKey && <button type="button" className="secondary" onClick={() => setEditingKey(true)}>{t("Replace API key")}</button>}</>}</div><div className="permissions"><h3>{t("Immich API key permissions")}</h3><p className="muted">{t("Grant these permissions when creating the key in Immich. The list is based on the backend API calls.")}</p>{permissions.map(item => <div key={item.permission}><code>{item.permission}</code><span>{t(item.purpose)}</span><small>{t(item.optional ? "optional" : "required")}</small></div>)}</div></section>
      <section className="panel"><p className="eyebrow">{t("Security")}</p><h2>{t("Change password")}</h2><form onSubmit={changePassword}><label>{t("Current password")}<input required type="password" value={passwordForm.current_password} onChange={event => setPasswordForm({ ...passwordForm, current_password: event.target.value })} /></label><label>{t("New password")}<input required minLength={12} type="password" value={passwordForm.new_password} onChange={event => setPasswordForm({ ...passwordForm, new_password: event.target.value })} /></label><button className="secondary">{t("Change password")}</button></form></section>
      {auth.user.is_admin && <section className="panel"><p className="eyebrow">{t("Administration")}</p><h2>{t("Invite a member")}</h2><p className="muted">{t("Invitees set their own password. You cannot see their libraries or API keys.")}</p><form onSubmit={invite}><label>{t("Name")}<input required value={inviteForm.name} onChange={event => setInviteForm({ ...inviteForm, name: event.target.value })} /></label><label>{t("Email")}<input required type="email" value={inviteForm.email} onChange={event => setInviteForm({ ...inviteForm, email: event.target.value })} /></label><button className="primary">{t("Create invitation link")}</button></form>{inviteLink && <div className="invite-link"><label>{t("Share link")}<input readOnly value={inviteLink} onFocus={event => event.currentTarget.select()} /></label><button className="secondary" onClick={() => navigator.clipboard.writeText(inviteLink)}>{t("Copy")}</button><small>{t("This link is shown only now and expires in 7 days.")}</small></div>}<div className="member-list">{members.map(member => <div key={member.id}><span>{member.name}<small>{member.email}</small></span><b>{member.is_admin ? t("Administrator") : t(member.joined ? "Member" : "Invited")}</b><div className="member-actions">{!member.is_admin && !member.joined && <button type="button" className="text-button" onClick={() => renewInvitation(member)}>{t("New link")}</button>}{!member.is_admin && <button type="button" className="text-button danger" onClick={() => { setDeletingMember(member.id); setDeletePhrase(''); }}>{t("Delete")}</button>}</div></div>)}</div>{deletingMember !== null && (() => { const member = members.find(item => item.id === deletingMember); return member ? <div className="delete-confirm" role="group" aria-label={t("Confirm member deletion")}><strong>{member.name} {t("permanently delete?")}</strong><p>{t("Sessions, API key, cache, statistics, and device corrections for this account are deleted from the database. Immich originals are untouched.")}</p><label>{t("To confirm, type")} <code>delete</code> {t("enter")}<input autoFocus value={deletePhrase} onChange={event => setDeletePhrase(event.target.value)} /></label><div className="connection-actions"><button type="button" className="danger-button" disabled={deletePhrase !== 'delete'} onClick={() => removeMember(member)}>{t("Permanently delete member")}</button><button type="button" className="secondary" onClick={() => { setDeletingMember(null); setDeletePhrase(''); }}>{t("Cancel")}</button></div></div> : null; })()}</section>}
      {auth.user.has_api_key && <DeviceRules revision={sync?.revision ?? null} request={request} />}
      <ProjectNotes />
    </div> : <><div className="page-intro"><div><p className="eyebrow">{tab === 'library' ? t("Entire library") : tab === 'year' ? t("A year of memories") : tab === 'download' ? t("Data export") : t("Your selected range")}</p><h2>{title}</h2></div>{tab === 'year' && <label>{t("Year")}<input type="number" min={1900} max={2200} value={year} onChange={event => setYear(Number(event.target.value))} /></label>}{tab === 'range' && <div className="range-inputs"><label>{t("From")}<input type="date" value={range.start} onChange={event => setRange({ ...range, start: event.target.value })} /></label><label>{t("To")}<input type="date" value={range.end} onChange={event => setRange({ ...range, end: event.target.value })} /></label></div>}{tab !== 'download' && <button className={`secondary sync-button ${sync?.running ? 'is-running' : ''}`} onClick={synchronizeNow} disabled={sync?.running || !auth.user.has_api_key} style={sync?.running ? { '--sync-percent': `${sync.progress?.percent ?? 0}%` } as React.CSSProperties : undefined}><span>{sync?.running ? `${sync.progress?.percent ?? 0} % · ${t(sync.progress?.phase ?? "Sync in progress")}` : t("Refresh now")}</span></button>}</div>
      {auth.user.has_api_key && <p className="muted" role="status">{sync?.completed_at ? t("Snapshot: {date}", { date: new Date(sync.completed_at).toLocaleString(language) }) : t("No snapshot saved yet.")} {sync?.running ? t("Immich is syncing in the background. The previous snapshot remains available.") : ''} {sync?.error ? t(sync.error) : ""}</p>}
      {auth.user.has_api_key && (sync?.running || error.includes('older version')) && <p className="sync-warning">{t("A database sync can take a long time for a large library. You can continue using the page; the previous snapshot remains available until the new one is complete.")}</p>}
      {!auth.user.has_api_key ? <section className="empty-state"><h3>{t("Connect your Immich account first.")}</h3><p>{t("Save your Immich URL and personal API key in your profile.")}</p><button className="primary" onClick={() => setTab('profile')}>{t("Go to profile")}</button></section> : tab === 'download' ? <section className="panel download-panel"><p className="eyebrow">{t("Export")}</p><h3>{t("Your stored snapshot")}</h3><p className="muted">{t("The SQLite file contains cached assets, statistics, album IDs, and your device corrections. PDF, CSV, and JPG are compact reports. Passwords, API keys, and original images are excluded from every export.")}</p>{!sync?.revision ? <p>{t("Refresh the library first.")}</p> : <><div className="download-options"><div><b>{t("SQLite database")}</b><span>{exportLoading ? t("Calculating size once…") : exportInfo ? `${downloadSize(exportInfo.size_bytes)} · ${number(exportInfo.asset_count)} ${t("Assets")}` : t("Size unavailable")}</span><a className="secondary download-button" href={`${API}/me/export/sqlite`} download="immich-insights.sqlite">{t("Download SQLite")}</a></div>{(['pdf', 'csv', 'jpg'] as const).map(format => <div key={format}><b>{t("{format} report", { format: format.toUpperCase() })}</b><span>{reportInfo ? downloadSize(reportInfo.sizes[format]) : t("Calculating size…")}</span><a className="secondary download-button" href={`${API}/me/export/report/${format}`} download={`immich-insights-report.${format}`}>{t("Download {format}", { format: format.toUpperCase() })}</a></div>)}</div>{exportError && <p className="error">{t(exportError)}</p>}</>}</section> : tab === 'range' && (!range.start || !range.end) ? <section className="empty-state"><h3>{t("Choose start and end dates.")}</h3><p>{t("Both start and end dates are included.")}</p></section> : !sync?.revision ? <section className="empty-state"><h3>{sync?.running ? t("Initial sync in progress…") : t("Scan the library once")}</h3><p>{t("Use “Refresh now” to start the background sync.")}</p></section> : loading ? <section className="empty-state"><h3>{t("Calculating library statistics…")}</h3><p>{t("This can take a moment for large libraries.")}</p></section> : data ? <><div hidden={!!drilldown}>{tab === 'photo_profile' ? <><ScorePanel scores={data.scores} /><PhotoProfilePage profile={data.photo_profile} annual={data.annual_photo_profiles} /></> : <StatsView key={`${tab}:${year}:${range.start}:${range.end}`} data={data} scope={tab} selectedYear={year} rangeStart={range.start} rangeEnd={range.end} section={section} setSection={setSection} onExplore={explore} onManageDevices={() => { setTab('profile'); window.setTimeout(() => document.getElementById('device-rules')?.scrollIntoView({ behavior: 'smooth' }), 40); }} theme={theme} />}</div>{drilldown && sync?.revision && <AssetBrowser key={JSON.stringify(drilldown)} filter={drilldown} revision={sync.revision} onBack={() => setDrilldown(null)} />}</> : null}
    </>}
    <footer className="version">Immich Insights · Version 0.1.0</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<LocaleProvider><App /></LocaleProvider>);
