import { useEffect, useMemo, useRef, useState } from 'react';
import type { AssetFilter } from './charts';
import { displayDeviceName, useLocale } from './i18n';
import { formatNumber } from './number-format';

export type ExposurePoint = {
  asset_id: string;
  iso: number;
  shutter_seconds: number;
  f_number: number;
  year: number | null;
  device: string;
  category: string;
  geo: boolean;
  people: boolean;
  favorite: boolean;
};

type ColoredPoint = { x: number; y: number; weights: [number, number, number]; asset_id: string; category: string; year: number | null; iso: number; shutter: number; aperture: number };
const number = (value: number) => formatNumber(value);
const quantile = (sorted: number[], proportion: number) => {
  if (!sorted.length) return 0;
  const position = (sorted.length - 1) * proportion;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};
const clamp = (value: number) => Math.max(-1, Math.min(1, value));
// 600 px side, 300 * sqrt(3) px height: all three angles are exactly 60°.
const triangle = { top: { x: 400, y: 52 }, left: { x: 100, y: 52 + 300 * Math.sqrt(3) }, right: { x: 700, y: 52 + 300 * Math.sqrt(3) } };

export function ExposureTriangle({ points, photoCount, theme, onExplore }: { points: ExposurePoint[]; photoCount: number; theme: 'light' | 'dark'; onExplore?: (filter: AssetFilter) => void }) {
  const { t } = useLocale();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [metric, setMetric] = useState<'all' | 'favorite' | 'geo' | 'people'>('all');
  const [category, setCategory] = useState('all');
  const [device, setDevice] = useState('');
  const [year, setYear] = useState('all');
  const [cutoff, setCutoff] = useState<95 | 99>(95);
  const [spread, setSpread] = useState(1.8);
  const [colorMode, setColorMode] = useState<'parameter' | 'category' | 'year'>('parameter');
  const [showAxis, setShowAxis] = useState(false);
  const [hovered, setHovered] = useState<{ index: number; x: number; y: number } | null>(null);
  const devices = useMemo(() => [...new Set(points.map(point => point.device))].sort((a, b) => a.localeCompare(b, 'de')), [points]);
  const years = useMemo(() => [...new Set(points.map(point => point.year).filter((value): value is number => value !== null))].sort((a, b) => a - b), [points]);
  const filtered = useMemo(() => points.filter(point =>
    (metric === 'all' || point[metric]) &&
    (category === 'all' || point.category === category) &&
    (!device || point.device === device) &&
    (year === 'all' || point.year === Number(year))
  ), [points, metric, category, device, year]);
  // Cache the costly sorts while only the visual spread or color changes.
  const values = useMemo(() => filtered.map(point => [Math.log2(point.iso), Math.log2(point.shutter_seconds), -2 * Math.log2(point.f_number)] as const), [filtered]);
  const axisBounds = useMemo(() => [0, 1, 2].map(axis => {
    const ordered = values.map(row => row[axis]).sort((a, b) => a - b);
    return { low: quantile(ordered, 1 - cutoff / 100), center: quantile(ordered, .5), high: quantile(ordered, cutoff / 100) };
  }), [values, cutoff]);
  const plot = useMemo(() => {
    if (!filtered.length) return { dots: [] as ColoredPoint[], dominant: [0, 0, 0, 0] };
    // ISO and time use log2; aperture is inverse f-number squared, i.e. light-area stops.
    const dominant = [0, 0, 0, 0];
    const dots = values.map((row, index) => {
      const standardized = row.map((value, axis) => {
        const bound = axisBounds[axis];
        const distance = value < bound.center ? bound.center - bound.low : bound.high - bound.center;
        return distance <= 1e-9 ? 0 : clamp((value - bound.center) / distance);
      });
      const exponential = standardized.map(value => Math.exp(value * spread));
      const total = exponential.reduce((sum, value) => sum + value, 0);
      const weights = exponential.map(value => value / total) as [number, number, number];
      const orderedWeights = [...weights].sort((a, b) => b - a);
      dominant[orderedWeights[0] - orderedWeights[1] < .06 ? 3 : weights.indexOf(orderedWeights[0])] += 1;
      return {
        x: weights[0] * triangle.top.x + weights[1] * triangle.left.x + weights[2] * triangle.right.x,
        y: weights[0] * triangle.top.y + weights[1] * triangle.left.y + weights[2] * triangle.right.y,
        weights, asset_id: filtered[index].asset_id, category: filtered[index].category, year: filtered[index].year,
        iso: filtered[index].iso, shutter: filtered[index].shutter_seconds, aperture: filtered[index].f_number,
      };
    });
    return { dots, dominant };
  }, [filtered, values, axisBounds, spread]);
  // Only a small, distinct sample per screen cell is tested on pointer movement.
  // This keeps hover responsive even with tens of thousands of photos near the centre.
  const hoverCells = useMemo(() => {
    const cells = new Map<string, number[]>();
    plot.dots.forEach((dot, index) => {
      const key = `${Math.floor(dot.x / 8)}:${Math.floor(dot.y / 8)}`;
      const entries = cells.get(key) ?? [];
      if (entries.length < 24 && !entries.some(other => {
        const point = plot.dots[other];
        return point.iso === dot.iso && point.shutter === dot.shutter && point.aperture === dot.aperture;
      })) entries.push(index);
      cells.set(key, entries);
    });
    return cells;
  }, [plot]);
  const findHover = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * 800;
    const y = (event.clientY - rect.top) / rect.height * 640;
    let best = -1, distance = 100;
    const cx = Math.floor(x / 8), cy = Math.floor(y / 8);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const index of hoverCells.get(`${cx + dx}:${cy + dy}`) ?? []) {
        const dot = plot.dots[index], next = (dot.x - x) ** 2 + (dot.y - y) ** 2;
        if (next < distance) { best = index; distance = next; }
      }
    }
    setHovered(current => best < 0 ? null : current?.index === best ? current : { index: best, x: event.clientX, y: event.clientY });
  };

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const draw = () => {
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      element.width = Math.round(bounds.width * ratio);
      element.height = Math.round(bounds.height * ratio);
      const context = element.getContext('2d');
      if (!context) return;
      const palette = getComputedStyle(document.documentElement);
      const series = (index: number) => palette.getPropertyValue(`--series-${index}`).trim();
      context.setTransform(element.width / 800, 0, 0, element.height / 640, 0, 0);
      context.clearRect(0, 0, 800, 640);
      context.fillStyle = theme === 'dark' ? '#222831' : '#f7f7f9';
      context.beginPath(); context.moveTo(triangle.top.x, triangle.top.y); context.lineTo(triangle.left.x, triangle.left.y); context.lineTo(triangle.right.x, triangle.right.y); context.closePath(); context.fill();
      context.strokeStyle = theme === 'dark' ? '#475363' : '#dfe4ea'; context.lineWidth = 1;
      for (const level of [.25, .5, .75]) {
        const { top, left, right } = triangle;
        const one = { x: left.x * level + top.x * (1 - level), y: left.y * level + top.y * (1 - level) };
        const two = { x: right.x * level + top.x * (1 - level), y: right.y * level + top.y * (1 - level) };
        context.beginPath(); context.moveTo(one.x, one.y); context.lineTo(two.x, two.y); context.stroke();
        const three = { x: top.x * level + left.x * (1 - level), y: top.y * level + left.y * (1 - level) };
        const four = { x: right.x * level + left.x * (1 - level), y: right.y * level + left.y * (1 - level) };
        context.beginPath(); context.moveTo(three.x, three.y); context.lineTo(four.x, four.y); context.stroke();
        const five = { x: top.x * level + right.x * (1 - level), y: top.y * level + right.y * (1 - level) };
        const six = { x: left.x * level + right.x * (1 - level), y: left.y * level + right.y * (1 - level) };
        context.beginPath(); context.moveTo(five.x, five.y); context.lineTo(six.x, six.y); context.stroke();
      }
      context.strokeStyle = theme === 'dark' ? '#b6c3d0' : '#536170'; context.lineWidth = 2;
      context.beginPath(); context.moveTo(triangle.top.x, triangle.top.y); context.lineTo(triangle.left.x, triangle.left.y); context.lineTo(triangle.right.x, triangle.right.y); context.closePath(); context.stroke();
      const minimumYear = years[0] ?? 0, maximumYear = years.at(-1) ?? minimumYear;
      context.globalAlpha = plot.dots.length > 15000 ? .19 : .36;
      for (const dot of plot.dots) {
        if (colorMode === 'parameter') {
          const [iso, shutter, aperture] = dot.weights;
          context.fillStyle = `rgb(${Math.round(137 * iso + 43 * shutter + 211 * aperture)},${Math.round(80 * iso + 138 * shutter + 153 * aperture)},${Math.round(175 * iso + 132 * shutter + 55 * aperture)})`;
        } else if (colorMode === 'category') {
          context.fillStyle = dot.category === "Camera" ? series(0) : dot.category === "Mobile device" ? series(1) : series(2);
        } else {
          const fraction = maximumYear === minimumYear || dot.year === null ? .5 : (dot.year - minimumYear) / (maximumYear - minimumYear);
          const from = Number(palette.getPropertyValue('--series-hue-0').trim()), to = Number(palette.getPropertyValue('--series-hue-2').trim());
          context.fillStyle = `hsl(${Math.round(from + (to - from) * fraction)} ${palette.getPropertyValue('--series-saturation').trim()} ${palette.getPropertyValue('--series-lightness').trim()})`;
        }
        context.beginPath(); context.arc(dot.x, dot.y, 2.2, 0, Math.PI * 2); context.fill();
      }
      context.globalAlpha = 1;
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(element);
    const themeObserver = new MutationObserver(draw);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-palette', 'data-accent', 'data-theme'] });
    return () => { observer.disconnect(); themeObserver.disconnect(); };
  }, [plot, colorMode, years, theme]);

  return <section className="panel exposure-triangle"><p className="eyebrow">{t("Exposure")}</p><h3>{t("Your exposure triangle")}</h3><p className="muted">{t("Each dot is a photo with complete ISO, shutter, and aperture data. The closer it is to a corner, the more that parameter deviates from your usual value relative to the other two. In the center, all three influences are similar. This does not assess image quality or correct exposure.")}</p>
    <div className="triangle-controls"><label>{t("Photos")}<select value={metric} onChange={event => setMetric(event.target.value as typeof metric)}><option value="all">{t("All")}</option><option value="favorite">{t("Favorites")}</option><option value="geo">{t("With location")}</option><option value="people">{t("With person")}</option></select></label><label>{t("Device type")}<select value={category} onChange={event => { setCategory(event.target.value); setDevice(''); }}><option value="all">{t("All")}</option><option value="Camera">{t("Camera")}</option><option value="Mobile device">{t("Mobile device")}</option><option value="Other">{t("Other")}</option></select></label><label>{t("Device")}<select value={device} onChange={event => setDevice(event.target.value)}><option value="">{t("All devices")}</option>{devices.map(name => <option key={name} value={name}>{displayDeviceName(name, t)}</option>)}</select></label>{years.length > 1 && <label>{t("Capture year")}<select value={year} onChange={event => setYear(event.target.value)}><option value="all">{t("All years")}</option>{years.map(value => <option key={value} value={value}>{value}</option>)}</select></label>}<label>{t("Scale clipping")}<select value={cutoff} onChange={event => setCutoff(Number(event.target.value) as 95 | 99)}><option value="95">95 %</option><option value="99">99 %</option></select></label><label>{t("Color")}<select value={colorMode} onChange={event => setColorMode(event.target.value as typeof colorMode)}><option value="parameter">{t("Corner proximity")}</option><option value="category">{t("Device type")}</option><option value="year">{t("Capture year")}</option></select></label><label className="triangle-axis-toggle"><input type="checkbox" checked={showAxis} onChange={event => setShowAxis(event.target.checked)} />{t("Show axis values")}</label></div>
    <label className="triangle-spread">{t("Spread")}: {formatNumber(spread, { maximumFractionDigits: 1 })}<input type="range" min="1" max="3" step="0.2" value={spread} onChange={event => setSpread(Number(event.target.value))} /></label>
    {filtered.length ? <><div className="triangle-plot"><canvas ref={canvas} role="img" aria-label={t("Exposure triangle with {count} individual photo dots", { count: number(filtered.length) })} onPointerMove={findHover} onPointerLeave={() => setHovered(null)} onClick={() => { const point = hovered && plot.dots[hovered.index]; if (point) onExplore?.({ kind: 'asset', asset_id: point.asset_id }); }} /><span className="triangle-label top">{t("High ISO")}</span><span className="triangle-label left">{t("Long shutter time")}</span><span className="triangle-label right">{t("Wide aperture")}</span></div>{hovered && plot.dots[hovered.index] && <div className="heat-tooltip triangle-hover" style={{ left: Math.min(window.innerWidth - 220, hovered.x + 12), top: Math.min(window.innerHeight - 80, hovered.y + 12) }}>ISO {number(plot.dots[hovered.index].iso)} · {plot.dots[hovered.index].shutter < 1 ? `1/${number(Math.round(1 / plot.dots[hovered.index].shutter))}` : `${plot.dots[hovered.index].shutter} s`} · f/{plot.dots[hovered.index].aperture}</div>}{showAxis && <div className="triangle-axis-values"><span>ISO · {t("center")} {number(Math.round(2 ** axisBounds[0].center))} · {t("high corner approx.")} {number(Math.round(2 ** axisBounds[0].high))}</span><span>{t("Time")} · {t("center")} {(2 ** axisBounds[1].center).toFixed(3)} s · {t("long corner approx.")} {(2 ** axisBounds[1].high).toFixed(2)} s</span><span>{t("Aperture")} · {t("center")} f/{(2 ** (-axisBounds[2].center / 2)).toFixed(1)} · {t("wide corner approx.")} f/{(2 ** (-axisBounds[2].high / 2)).toFixed(1)}</span></div>}</> : <p className="muted">{t("No photos with complete exposure data match this selection.")}</p>}
    <div className="triangle-explainer"><div><b>↑ {t("High ISO value")}</b><span>{t("More signal amplification helps in low light but can increase noise.")}</span></div><div><b>↙ {t("Long shutter time")}</b><span>{t("The sensor gathers light for longer; motion can become blur or camera shake.")}</span></div><div><b>↘ {t("Wide aperture")}</b><span>{t("A smaller f-number means a wider opening: more light and shallower depth of field, often with a blurrier background.")}</span></div></div>
    <div className="triangle-summary"><span>{t("{count} dots shown", { count: number(filtered.length) })}</span><span>{t("{count} photos without a complete ISO/shutter/aperture trio", { count: number(Math.max(0, photoCount - points.length)) })}</span><span>{t("Clipping limits outliers on the scale; no photo is hidden.")}</span></div>
    <div className="triangle-legend"><span><i style={{ background: 'var(--series-0)' }} />{t("ISO-dominant")}: {number(plot.dominant[0])}</span><span><i style={{ background: 'var(--series-1)' }} />{t("Shutter-dominant")}: {number(plot.dominant[1])}</span><span><i style={{ background: 'var(--series-2)' }} />{t("Aperture-dominant")}: {number(plot.dominant[2])}</span><span><i style={{ background: 'var(--app-muted-ink)' }} />{t("Evenly balanced")}: {number(plot.dominant[3])}</span></div>
    <p className="muted tiny">{t("How to read this: start with a corner. A dot near “High ISO” has an unusually high ISO relative to its other two settings among your selected photos. Between corners, both settings stand out; near the center, all three are similar. ISO and shutter time use log₂ stops; aperture light effect uses −2 log₂(f-number). Each parameter is centered on its median; 95/99% clipping only limits extreme scale values. The three relative values are then blended into a triangle position. This chart does not show absolute brightness, correct exposure, or quality. Depth-of-field comparison additionally depends on sensor size, angle of view, focus distance, and output size; the EXIF f-number is not converted. Hover a dot for its exact EXIF values.")}</p>
  </section>;
}
