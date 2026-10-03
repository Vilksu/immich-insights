import { useEffect, useMemo, useRef, useState } from 'react';
import type { AssetFilter } from './charts';
import { displayDeviceName, useLocale } from './i18n';
import { formatNumber } from './number-format';

export type TimelineEvent = {
  id: string; at: string; category: 'beginning' | 'device' | 'milestone' | 'record' | 'pause';
  title: string; detail: string; asset_id: string | null; day: string | null;
  metric: 'assets' | 'photos' | 'videos';
};

const groups = { beginning: 'First & last', device: 'Devices', milestone: 'Milestones', record: 'Records', pause: 'Breaks' } as const;
const colors: Record<TimelineEvent['category'], string> = { beginning: 'var(--series-0)', device: 'var(--series-1)', milestone: 'var(--series-3)', record: 'var(--series-5)', pause: 'var(--series-2)' };
const dayMs = 86_400_000;
const stamp = (value: string) => Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
function wrapLabel(value: string, max = 95): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of value.split(/\s+/)) {
    if (line && `${line} ${word}`.length > max) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function timelineTicks(start: number, end: number, language: string, target = 8) {
  const days = (end - start) / dayMs;
  const unit = days > 1200 ? 'year' : days > 120 ? 'month' : 'day';
  const step = unit === 'year' ? Math.max(1, Math.ceil(days / 365.25 / target)) : unit === 'month' ? Math.max(1, Math.ceil(days / 30 / target)) : Math.max(1, Math.ceil(days / target));
  const cursor = new Date(start);
  if (unit === 'year') { cursor.setUTCMonth(0, 1); cursor.setUTCHours(0, 0, 0, 0); }
  else if (unit === 'month') { cursor.setUTCDate(1); cursor.setUTCHours(0, 0, 0, 0); }
  else cursor.setUTCHours(0, 0, 0, 0);
  if (cursor.getTime() < start) {
    if (unit === 'year') cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
    else if (unit === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const ticks: { at: number; label: string }[] = [];
  while (cursor.getTime() <= end && ticks.length < 20) {
    ticks.push({ at: cursor.getTime(), label: unit === "year" ? String(cursor.getUTCFullYear()) : cursor.toLocaleDateString(language, unit === "month" ? { month: 'short', year: 'numeric', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' }) });
    if (unit === 'year') cursor.setUTCFullYear(cursor.getUTCFullYear() + step);
    else if (unit === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + step);
    else cursor.setUTCDate(cursor.getUTCDate() + step);
  }
  return ticks;
}

export function MediaTimeline({ events, apiBase, onExplore }: { events: TimelineEvent[]; apiBase: string; onExplore?: (filter: AssetFilter) => void }) {
  const { t, language } = useLocale();
  const dateLabel = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString(language, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  const integerLabel = (value: string) => formatNumber(Number(value.replace(/\./g, '')));
  const eventTitle = (title: string) => {
    // Retain legacy patterns for snapshots created before English became canonical.
    const first = title.match(/^(?:First photo with |Erstes Foto mit )(.+)$/);
    if (first && !['First photo with a person', 'Erstes Foto mit Standort', 'Erstes Foto mit Person'].includes(title)) return t("First photo with {device}", { device: displayDeviceName(first[1], t) });
    const last = title.match(/^(?:Last photo with |Letztes Foto mit )(.+)$/);
    if (last) return t("Last photo with {device}", { device: displayDeviceName(last[1], t) });
    const milestone = title.match(/^([\d.]+)(?:th |\. )(asset|photo|geotagged photo|detected face|Asset|Foto|Foto mit Standort|erkanntes Gesicht)$/);
    if (milestone) return t("{count}th {kind}", { count: integerLabel(milestone[1]), kind: t(milestone[2] === 'photo' ? 'Photo' : milestone[2]) });
    return t(title);
  };
  const eventDetail = (detail: string) => {
    const file = detail.match(/^([\d.]+) MB · (?:largest known original file of this media type|größte bekannte Originaldatei dieser Medienart)\.$/);
    if (file) return t("{size} MB · largest known original file of this media type.", { size: file[1] });
    const video = detail.match(/^([\d.]+) (?:seconds · standalone video with known duration; Live Photo companion videos excluded|Sekunden · eigenständiges Video mit bekannter Laufzeit; Live-Photo-Begleitvideos ausgeschlossen)\.$/);
    if (video) return t("{seconds} seconds · standalone video with known duration; Live Photo companion videos excluded.", { seconds: video[1] });
    const extreme = detail.match(/^(.+) · (?:only photo with this extreme value|einziges Foto mit diesem Extremwert)\.$/);
    if (extreme) return t("{value} · only photo with this extreme value.", { value: extreme[1] });
    const busy = detail.match(/^([\d.]+) (Assets|Photos|Fotos|Videos) (?:on this capture day|an diesem Aufnahmetag)\.$/);
    if (busy) return t("{count} {kind} on this capture day.", { count: integerLabel(busy[1]), kind: t(busy[2]) });
    const pauseStart = detail.match(/^(?:Followed by |Danach folgen )(\d+) (?:calendar days without a dated capture|Kalendertage ohne datierte Aufnahme)\.$/);
    if (pauseStart) return t("Followed by {days} calendar days without a dated capture.", { days: pauseStart[1] });
    const pauseEnd = detail.match(/^(?:First capture after |Erste Aufnahme nach )(\d+) (?:calendar days without a dated capture|Kalendertagen ohne datierte Aufnahme)\.$/);
    if (pauseEnd) return t("First capture after {days} calendar days without a dated capture.", { days: pauseEnd[1] });
    const streakStart = detail.match(/^(?:Captures were made on |An )(\d+) (?:consecutive days|aufeinanderfolgenden Tagen entstanden Aufnahmen)\.$/);
    if (streakStart) return t("Captures were made on {days} consecutive days.", { days: streakStart[1] });
    const streakEnd = detail.match(/^(?:Last day of a |Letzter Tag einer Folge von )(\d+)(?:-day capture streak| Aufnahmetagen)\.$/);
    if (streakEnd) return t("Last day of a {days}-day capture streak.", { days: streakEnd[1] });
    return t(detail);
  };
  const [group, setGroup] = useState<'all' | TimelineEvent['category']>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [width, setWidth] = useState(800);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; range: [number, number]; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, number>());
  const pinch = useRef<{ distance: number; anchor: number; range: [number, number] } | null>(null);
  const suppressClick = useRef(false);
  const ordered = useMemo(() => [...events].sort((a, b) => a.at.localeCompare(b.at)), [events]);
  const bounds = useMemo<[number, number]>(() => ordered.length ? [stamp(ordered[0].at) - 30 * dayMs, stamp(ordered.at(-1)!.at) + 30 * dayMs] : [Date.now() - 365 * dayMs, Date.now()], [ordered]);
  const recentRange = useMemo<[number, number]>(() => {
    if (!ordered.length) return bounds;
    const recent = ordered.slice(-10);
    const first = stamp(recent[0].at), last = stamp(recent.at(-1)!.at);
    const padding = Math.max(30 * dayMs, (last - first) * .12);
    return [Math.max(bounds[0], first - padding), Math.min(bounds[1], last + padding)];
  }, [ordered, bounds]);
  const [range, setRange] = useState<[number, number]>(recentRange);
  useEffect(() => { setRange(recentRange); setSelectedId(ordered.at(-1)?.id ?? null); }, [recentRange, ordered]);
  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(300, Math.round(entries[0].contentRect.width))));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('de-DE');
    return ordered.filter(event => (group === 'all' || event.category === group) && (!term || `${event.title} ${event.detail} ${eventTitle(event.title)} ${eventDetail(event.detail)}`.toLocaleLowerCase(language).includes(term)));
  }, [ordered, group, search]);
  const timelineHeight = 535;
  const plotInset = 16;
  const plotWidth = width - plotInset * 2;
  const x = (at: number) => plotInset + (at - range[0]) / (range[1] - range[0]) * plotWidth;
  const constrain = (next: [number, number]): [number, number] => {
    const full = bounds[1] - bounds[0];
    const span = clamp(next[1] - next[0], Math.min(7 * dayMs, full), full);
    const start = clamp(next[0], bounds[0], bounds[1] - span);
    return [start, start + span];
  };
  const zoom = (factor: number, anchor: number) => setRange(previous => {
    const focus = previous[0] + anchor * (previous[1] - previous[0]);
    const span = (previous[1] - previous[0]) * factor;
    return constrain([focus - anchor * span, focus + (1 - anchor) * span]);
  });
  useEffect(() => {
    const target = viewport.current;
    if (!target) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = target.getBoundingClientRect();
      zoom(Math.exp(event.deltaY * .001), clamp((event.clientX - rect.left - plotInset) / plotWidth, 0, 1));
    };
    target.addEventListener('wheel', wheel, { passive: false });
    return () => target.removeEventListener('wheel', wheel);
  }, [bounds, plotWidth]);
  const open = (event: TimelineEvent) => {
    if (event.day) onExplore?.({ kind: 'date', date: event.day, metric: event.metric });
    else if (event.asset_id) onExplore?.({ kind: 'asset', asset_id: event.asset_id });
  };
  const activate = (event: TimelineEvent) => { setSelectedId(event.id); open(event); };
  const inRange = visible.filter(event => stamp(event.at) >= range[0] && stamp(event.at) <= range[1]);
  const bandwidth = (range[1] - range[0]) * .055;
  const stamps = visible.map(event => stamp(event.at)).filter(at => at >= range[0] - bandwidth && at <= range[1] + bandwidth);
  const smooth = Array.from({ length: 121 }, (_, index) => {
    const at = range[0] + index / 120 * (range[1] - range[0]);
    return stamps.reduce((sum, value) => { const distance = (at - value) / bandwidth; return sum + (Math.abs(distance) < 1 ? (1 - distance * distance) ** 2 : 0); }, 0);
  });
  const peak = Math.max(1, ...smooth);
  const density = `M ${plotInset} 260 ${smooth.map((value, index) => `L ${plotInset + index / 120 * plotWidth} ${260 - value / peak * 75}`).join(' ')} L ${width - plotInset} 260 Z`;
  const occurrences = new Map<string, number>();
  const markers = inRange.map(event => {
    const day = event.at.slice(0, 10), index = occurrences.get(day) ?? 0;
    occurrences.set(day, index + 1);
    return { x: clamp(x(stamp(event.at)) + (index % 7 - 3) * 3, plotInset, width - plotInset), event };
  });
  const occupied: Array<Array<[number, number]>> = [[], [], [], []];
  const labelsInView = markers.flatMap(marker => {
    const lines = wrapLabel(eventTitle(marker.event.title), width < 520 ? 16 : 27).slice(0, 3);
    const estimatedWidth = Math.min(width - 24, Math.max(90, Math.max(...lines.map(line => line.length)) * (width < 520 ? 6.2 : 6.7)));
    const left = clamp(marker.x - estimatedWidth / 2, 10, width - estimatedWidth - 10);
    for (let lane = 0; lane < occupied.length; lane++) {
      if (occupied[lane].some(([start, end]) => left < end + 12 && left + estimatedWidth > start - 12)) continue;
      occupied[lane].push([left, left + estimatedWidth]);
      return [{ ...marker, lane, left, lines }];
    }
    return [];
  });
  return <section className="panel media-timeline" aria-label={t("Library timeline")}>
    <div className="timeline-heading"><div><p className="eyebrow">{t("Your timeline")}</p><h3>{t("Notable moments on a timeline")}</h3><p className="muted">{t("From the first photo to device changes, records, and milestones. Everything follows the capture date in Immich.")}</p></div></div>
    <div className="timeline-controls"><label>{t("Category")}<select value={group} onChange={event => setGroup(event.target.value as typeof group)}><option value="all">{t("All events")}</option>{Object.entries(groups).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</select></label><label>{t("Search")}<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t("Device or event")} /></label><div className="timeline-zoom" aria-label={t("Control timeline")}><button type="button" className="secondary" onClick={() => zoom(1.7, .5)} aria-label={t("Zoom out")}>−</button><button type="button" className="secondary" onClick={() => zoom(1 / 1.7, .5)} aria-label={t("Zoom in")}>+</button><button type="button" className="secondary" onClick={() => setRange(bounds)}>{t("Everything")}</button><button type="button" className="secondary" onClick={() => setRange(recentRange)}>{t("Recent")}</button></div></div>
    <div className="timeline-legend">{Object.entries(groups).map(([key, label]) => <span key={key}><i className={`timeline-dot ${key}`} />{t(label)}</span>)}</div>
    {visible.length ? <>
      <div ref={viewport} className="timeline-viewport" style={{ height: timelineHeight }} tabIndex={0} aria-label={t("Timeline: mouse wheel zooms, drag or swipe pans, arrow keys navigate")}
        onKeyDown={event => { if (event.key === '+' || event.key === '=') zoom(.65, .5); else if (event.key === '-') zoom(1.5, .5); else if (event.key === 'Home') setRange(bounds); else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { const shift = (range[1] - range[0]) * (event.key === 'ArrowRight' ? .2 : -.2); setRange(previous => constrain([previous[0] + shift, previous[1] + shift])); } else return; event.preventDefault(); }}
        onPointerDown={event => { if ((event.target as Element).closest('.timeline-event,.timeline-event-label-group')) { suppressClick.current = false; return; } if (event.pointerType === 'mouse' && event.button !== 0) return; const left = event.clientX - event.currentTarget.getBoundingClientRect().left; pointers.current.set(event.pointerId, left); suppressClick.current = false; if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()]; pinch.current = { distance: Math.max(10, Math.abs(a - b)), anchor: clamp(((a + b) / 2 - plotInset) / plotWidth, 0, 1), range }; drag.current = null; } else drag.current = { x: event.clientX, range, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (!pointers.current.has(event.pointerId)) return; pointers.current.set(event.pointerId, event.clientX - event.currentTarget.getBoundingClientRect().left); if (pointers.current.size === 2 && pinch.current) { const [a, b] = [...pointers.current.values()]; const initial = pinch.current; const focus = initial.range[0] + initial.anchor * (initial.range[1] - initial.range[0]); const span = (initial.range[1] - initial.range[0]) * initial.distance / Math.max(10, Math.abs(a - b)); setRange(constrain([focus - initial.anchor * span, focus + (1 - initial.anchor) * span])); suppressClick.current = true; return; } if (!drag.current) return; const shift = (drag.current.x - event.clientX) / plotWidth * (drag.current.range[1] - drag.current.range[0]); if (Math.abs(event.clientX - drag.current.x) > 3) drag.current.moved = true; setRange(constrain([drag.current.range[0] + shift, drag.current.range[1] + shift])); }}
        onPointerUp={event => { pointers.current.delete(event.pointerId); suppressClick.current = suppressClick.current || Boolean(drag.current?.moved); if (pointers.current.size === 1) { drag.current = { x: [...pointers.current.values()][0] + event.currentTarget.getBoundingClientRect().left, range, moved: true }; pinch.current = null; } else { drag.current = null; pinch.current = null; } }}
        onPointerCancel={event => { pointers.current.delete(event.pointerId); drag.current = null; pinch.current = null; }}>
        <svg viewBox={`0 0 ${width} ${timelineHeight}`} role="group" aria-label={`${inRange.length} ${t("events in view")}`}>
          <path d={density} className="timeline-density" /><line x1={plotInset} x2={width - plotInset} y1="260" y2="260" className="timeline-axis" />
          {timelineTicks(range[0], range[1], language, width < 520 ? 4 : 8).map(tick => <g key={tick.at} transform={`translate(${x(tick.at)} 0)`}><line y1="175" y2="266" className="timeline-gridline" /><text y="292" textAnchor="middle" className="timeline-tick">{tick.label}</text></g>)}
          {markers.map(marker => { const active = marker.event.id === selectedId; return <g key={marker.event.id} className="timeline-event" transform={`translate(${marker.x} 260)`} onClick={event => { event.stopPropagation(); activate(marker.event); }} tabIndex={0} role="button" onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(marker.event); } }} aria-label={`${dateLabel(marker.event.at)}: ${eventTitle(marker.event.title)}. ${eventDetail(marker.event.detail)}`}><title>{dateLabel(marker.event.at)} · {eventTitle(marker.event.title)} · {eventDetail(marker.event.detail)}</title><circle r="16" fill="transparent" /><circle r={active ? 8 : 6} fill={colors[marker.event.category]} fillOpacity={active ? '.85' : '.52'} stroke="var(--app-surface)" strokeWidth={active ? 2 : 1} pointerEvents="none" /></g>; })}
          {labelsInView.map(marker => { const labelY = [185, 100, 365, 455][marker.lane]; const below = marker.lane >= 2; return <g key={`label-${marker.event.id}`} className="timeline-event-label-group" role="button" tabIndex={0} aria-label={`${dateLabel(marker.event.at)}: ${eventTitle(marker.event.title)}. ${eventDetail(marker.event.detail)}`} onClick={event => { event.stopPropagation(); activate(marker.event); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(marker.event); } }}><line x1={marker.x} x2={marker.x} y1={below ? 268 : 252} y2={below ? labelY - 13 : labelY + 11} stroke={colors[marker.event.category]} strokeWidth="1.2" opacity=".55" /><text x={marker.left} y={labelY - (marker.lines.length - 1) * 13} textAnchor="start" className="timeline-event-label">{marker.lines.map((line, index) => <tspan key={index} x={marker.left} dy={index ? 13 : 0}>{line}</tspan>)}<tspan x={marker.left} dy="15" className="timeline-event-date">{dateLabel(marker.event.at)}</tspan></text></g>; })}
        </svg>
      </div>
      <div className="timeline-range-label">{dateLabel(new Date(range[0]).toISOString())} – {dateLabel(new Date(range[1]).toISOString())} · {inRange.length} {t("events in view")}</div>
    </> : <p className="muted">{t("No events for this selection.")}</p>}
    <p className="muted tiny timeline-footnote">{t("Use the mouse wheel to zoom and drag to pan. Click a point or label to view matching assets.")}</p>
    <p className="muted tiny timeline-credit">{t("Inspired by the")} <a href="https://github.com/gramps-project/gramps-web" target="_blank" rel="noreferrer">{t("Gramps Web open-source project")}</a>. {t("Many thanks to its team for their excellent work!")}</p>
  </section>;
}
