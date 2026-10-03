import { useState } from 'react';
import type { AssetFilter, Year } from './charts';
import { useLocale } from './i18n';
import { FloatingTooltip } from './tooltip';
import { formatNumber } from './number-format';

type Metric = 'photos' | 'videos' | 'people' | 'geo' | 'favorites';
const names: Record<Metric, string> = { photos: "Photos", videos: "Videos", people: "Assets with a person", geo: "Assets with location", favorites: "Favorites" };
const format = (value: number) => formatNumber(value, { maximumFractionDigits: 1 });

export function AnnualVolume({ years, onExplore }: { years: Year[]; onExplore?: (filter: AssetFilter) => void }) {
  const { t } = useLocale();
  const [metric, setMetric] = useState<Metric>('photos');
  const [hover, setHover] = useState<{ year: Year; x: number; y: number } | null>(null);
  const active = years.filter(year => year[metric] > 0);
  const peak = Math.max(1, ...years.map(year => year[metric]));
  const total = years.reduce((sum, year) => sum + year[metric], 0);
  const average = years.length ? total / years.length : 0;
  return <section className="panel annual-volume"><p className="eyebrow">{t("Volumes by year")}</p><h3>{t("How are your captures distributed?")}</h3><div className="segmented">{(Object.keys(names) as Metric[]).map(key => <button type="button" key={key} className={metric === key ? 'selected' : ''} onClick={() => { setMetric(key); setHover(null); }}>{t(names[key])}</button>)}</div><div className="annual-volume-summary"><span>{t("Total")}: <strong>{format(total)}</strong></span><span>{t("Average per capture year")}: <strong>{format(average)}</strong></span></div><div className="annual-volume-bars" role="group" aria-label={t("Captures by year")}>{active.map(year => <button type="button" key={year.year} className="annual-volume-bar" onClick={() => onExplore?.({ kind: 'year', year: year.year, metric })} onPointerEnter={event => setHover({ year, x: event.clientX, y: event.clientY })} onPointerMove={event => setHover({ year, x: event.clientX, y: event.clientY })} onPointerLeave={() => setHover(null)} onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setHover({ year, x: rect.left, y: rect.top }); }} onBlur={() => setHover(null)} aria-label={`${year.year}: ${format(year[metric])} ${t(names[metric])}`}><span style={{ height: `${Math.max(3, year[metric] / peak * 100)}%` }} /><small>{year.year}</small></button>)}</div>{hover && <FloatingTooltip x={hover.x} y={hover.y} className="chart-tooltip-list"><b>{hover.year.year} · {t(names[metric])}</b><span>{format(hover.year[metric])} · {format(hover.year[metric] / Math.max(1, total) * 100)} % {t("of the total")}</span><small>{t("Click to view matching assets")}</small></FloatingTooltip>}</section>;
}
