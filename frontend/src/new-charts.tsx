import { useMemo, useState } from 'react';
import { qualitativeColor, type AssetFilter, type NumericDistribution } from './charts';
import { smoothPath } from './smooth-path';
import { FloatingTooltip } from './tooltip';
import { useLocale } from './i18n';
import { formatNumber } from './number-format';

type ResolutionYear = { year: number; resolution_count: number; average_megapixels: number | null; minimum_megapixels: number | null; maximum_megapixels: number | null };
const count = (value: number) => formatNumber(value);
const mp = (value: number) => formatNumber(value, { maximumFractionDigits: 1 });
const focalLabel = (value: number) => formatNumber(value, { maximumFractionDigits: 8 });

export function ResolutionDevelopment({ years }: { years: ResolutionYear[] }) {
  const { t } = useLocale();
  const [showRange, setShowRange] = useState(false);
  const [hovered, setHovered] = useState<ResolutionYear | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const points = years.filter(year => year.resolution_count > 0 && year.average_megapixels !== null);
  if (!points.length) return <p className="muted">{t("No image dimensions are available for these years.")}</p>;
  const max = Math.max(1, ...points.map(year => showRange ? year.maximum_megapixels ?? 0 : year.average_megapixels ?? 0));
  const y = (value: number) => 210 - value / max * 170;
  const x = (index: number) => 54 + index / Math.max(1, years.length - 1) * 700;
  const line = (field: 'average_megapixels' | 'minimum_megapixels' | 'maximum_megapixels') => smoothPath(years.map((year, index) => year[field] === null || year.resolution_count === 0 ? null : [x(index), y(year[field]!)] as const));
  const yearStep = Math.max(1, Math.ceil(years.length / 11));
  return <div className="resolution-development">
    <label className="resolution-range"><input type="checkbox" checked={showRange} onChange={event => setShowRange(event.target.checked)} />{t("Show minimum and maximum")}</label>
    <div className="comparison-scroll"><svg viewBox="0 0 800 260" role="img" aria-label={t("Average photo resolution by capture year in megapixels")}>
      {[0, .5, 1].map(fraction => <g key={fraction}><line x1="54" x2="754" y1={y(max * fraction)} y2={y(max * fraction)} stroke="var(--app-border)" /><text x="47" y={y(max * fraction) + 4} textAnchor="end" fontSize="11">{mp(max * fraction)}</text></g>)}
      {showRange && <><path d={line('minimum_megapixels')} fill="none" stroke="var(--plot-primary)" opacity=".38" strokeWidth="1.8" strokeDasharray="5 4" /><path d={line('maximum_megapixels')} fill="none" stroke="var(--plot-primary)" opacity=".62" strokeWidth="1.8" strokeDasharray="5 4" /></>}
      <path d={line('average_megapixels')} fill="none" stroke="var(--plot-primary)" strokeWidth="3.5" strokeLinejoin="round" />
      {years.map((year, index) => year.average_megapixels === null ? null : <g key={year.year} onPointerMove={event => { setHovered(year); setPointer({ x: event.clientX, y: event.clientY }); }} onPointerLeave={() => setHovered(null)} onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setHovered(year); setPointer({ x: rect.left, y: rect.top }); }} onBlur={() => setHovered(null)} tabIndex={0} aria-label={t("{year}: average {mp} megapixels across {count} photos", { year: year.year, mp: mp(year.average_megapixels), count: count(year.resolution_count) })}>
        <rect x={x(index) - Math.min(28, 350 / Math.max(1, years.length))} y="35" width={Math.min(56, 700 / Math.max(1, years.length))} height="182" fill="transparent" /><circle cx={x(index)} cy={y(year.average_megapixels)} r={hovered?.year === year.year ? 7 : 5} fill="var(--plot-primary)" stroke="var(--app-surface)" strokeWidth="2" pointerEvents="none" />
      </g>)}
      {years.map((year, index) => index % yearStep === 0 || index === years.length - 1 ? <text key={year.year} x={x(index)} y="238" textAnchor="middle" fontSize="11">{year.year}</text> : null)}
      <text x="9" y="24" fontSize="11">MP</text>
    </svg></div>{hovered && <FloatingTooltip x={pointer.x} y={pointer.y} className="chart-tooltip-list"><b>{hovered.year} · {t("Photo resolution")}</b><span>Ø {mp(hovered.average_megapixels ?? 0)} MP</span><span>{t("Minimum")} {mp(hovered.minimum_megapixels ?? 0)} MP</span><span>{t("Maximum")} {mp(hovered.maximum_megapixels ?? 0)} MP</span><span>{count(hovered.resolution_count)} {t("photos with dimensions")}</span></FloatingTooltip>}
    <div className="resolution-legend"><span><i style={{ background: 'var(--plot-primary)' }} />{t("Average")}</span>{showRange && <><span><i style={{ background: 'var(--plot-primary)', opacity: .38 }} />{t("Minimum")}</span><span><i style={{ background: 'var(--plot-primary)', opacity: .62 }} />{t("Maximum")}</span></>}</div>
    <p className="muted tiny">{t("By capture year, only photos with known dimensions. Minimum and maximum can be influenced by unusual image formats.")}</p>
  </div>;
}

export function FocalFieldOfView({ distribution, onExplore, theme }: { distribution: NumericDistribution; onExplore?: (filter: AssetFilter) => void; theme: 'light' | 'dark' }) {
  const { t } = useLocale();
  const [hovered, setHovered] = useState<number | null>(null);
  const top = useMemo(() => {
    const exact = new Map<number, number>();
    for (const point of distribution.points) {
      const focal = point.value;
      if (focal > 0) exact.set(focal, (exact.get(focal) ?? 0) + point.count);
    }
    // Schematic full-frame reference only: actual FOV also needs sensor size.
    return [...exact].map(([focal, photos]) => ({ focal, photos, angle: 2 * Math.atan(Math.hypot(36, 24) / (2 * focal)) * 180 / Math.PI })).sort((a, b) => b.photos - a.photos || a.focal - b.focal).slice(0, 5).sort((a, b) => a.focal - b.focal);
  }, [distribution]);
  if (!top.length) return <p className="muted">{t("No original EXIF focal lengths available yet.")}</p>;
  const colors = Array.from({ length: 5 }, (_, index) => qualitativeColor(index, theme));
  // Paint narrow, long cones first. Wide, short cones stay on top and clickable.
  const cones = [...top].sort((a, b) => b.focal - a.focal);
  const minimum = Math.log(Math.min(...cones.map(item => item.focal))), maximum = Math.log(Math.max(...cones.map(item => item.focal)));
  const colorFor = (focal: number) => colors[top.findIndex(item => item.focal === focal)];
  const explore = (focal: number) => onExplore?.({ kind: 'distribution', field: 'focal', metric: 'photos', lower: focal, upper: focal, upper_inclusive: true });
  return <div className="fov-chart">
    <div className="fov-svg-wrap"><svg viewBox="0 0 820 390" role="img" aria-label={t("Schematic fields of view for the five most frequent original EXIF focal lengths")}>
      <line x1="160" x2="780" y1="195" y2="195" stroke="var(--app-border)" strokeDasharray="5 5" />
      {cones.map(item => {
        const radius = 185 + 460 * (Math.log(item.focal) - minimum) / Math.max(.01, maximum - minimum);
        const halfAngle = item.angle * Math.PI / 360;
        const fittedRadius = Math.min(radius, 165 / Math.max(.01, Math.sin(halfAngle)), 605 / Math.max(.01, Math.cos(halfAngle)));
        const front = 160 + fittedRadius * Math.cos(halfAngle);
        const halfHeight = fittedRadius * Math.sin(halfAngle);
        const color = colorFor(item.focal);
        return <g key={item.focal} className={onExplore ? 'fov-clickable' : ''} role={onExplore ? 'button' : undefined} tabIndex={onExplore ? 0 : undefined} aria-label={t("{focal} mm: view {count} photos", { focal: focalLabel(item.focal), count: count(item.photos) })} onPointerEnter={() => setHovered(item.focal)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(item.focal)} onBlur={() => setHovered(null)} onClick={() => explore(item.focal)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); explore(item.focal); } }}><path d={`M 160 195 L ${front} ${195 - halfHeight} A ${fittedRadius} ${fittedRadius} 0 0 1 ${front} ${195 + halfHeight} Z`} fill={color} fillOpacity={hovered === item.focal ? '.48' : '.21'} stroke={color} strokeOpacity=".85" strokeWidth={hovered === item.focal ? 4 : 2.5}><title>{focalLabel(item.focal)} mm · {mp(item.angle)}° diagonal · {count(item.photos)} {t("Photos")}</title></path></g>;
      })}
      <image href="/camera-top.svg" x="0" y="130" width="160" height="130" aria-hidden="true" />
      <text x="760" y="375" textAnchor="end" fontSize="11">{t("Diagonal angle of view · schematic reach")}</text>
    </svg></div>
    <div className="fov-legend">{[...top].sort((a, b) => a.focal - b.focal).map(item => <button type="button" disabled={!onExplore} key={item.focal} className={hovered === item.focal ? 'selected' : ''} onPointerEnter={() => setHovered(item.focal)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(item.focal)} onBlur={() => setHovered(null)} onClick={() => explore(item.focal)}><i style={{ background: colorFor(item.focal) }} /><strong>{focalLabel(item.focal)} mm</strong><span>{mp(item.angle)}° {t("diagonal")}</span><small>{count(item.photos)} {t("Photos")} →</small></button>)}</div>
    <p className="muted tiny fov-note">{t("Top 5 by original EXIF focal length. To compare different cameras and calculate their actual angles of view, a 35 mm-equivalent focal length or sensor dimensions are needed. The plotted angles use a schematic full-frame reference; cone length is not subject distance. See Profile → Notes.")}</p>
  </div>;
}
