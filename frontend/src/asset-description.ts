import type { AssetFilter } from './charts';
import { displayDeviceName } from './i18n';

type Translate = (source: string, values?: Record<string, string | number>) => string;

/** Describe the structured asset query in the UI locale. Counts still come from the API. */
export function describeAssetSelection(filter: AssetFilter, t: Translate, language: string): string {
  const metrics = { assets: "Assets", photos: "Photos", videos: "Videos", geo: "Assets with location", people: "Assets with a person", favorites: "Favorites" } as const;
  const fields = { iso: "ISO value", focal: "Focal length", aperture: "Aperture", exposure: "Exposure time", video: "Video length", altitude: "GPS altitude" } as const;
  const metric = t(metrics[filter.metric ?? "assets"]);
  const weekday = (index: number) => new Intl.DateTimeFormat(language, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, index + 1)));
  const hour = (value: number) => `${String(value).padStart(2, '0')}:00–${String(value).padStart(2, '0')}:59`;
  const field = filter.field ? t(fields[filter.field]) : '';
  let detail: string;
  switch (filter.kind) {
    case 'asset': detail = t("the selected asset only"); break;
    case 'device': detail = t("captured with device “{name}”", { name: displayDeviceName(filter.name ?? '', t) }); break;
    case 'manufacturer': detail = t(filter.raw ? "captured with devices of EXIF manufacturer “{name}”" : "captured with devices of grouped manufacturer “{name}”", { name: displayDeviceName(filter.name ?? '', t) }); break;
    case 'distribution': {
      const lower = filter.lower ?? 0, upper = filter.upper ?? lower;
      const interval = lower === upper ? String(lower) : t(filter.upper_inclusive ? "{lower} through {upper}" : "{lower} to under {upper}", { lower, upper });
      const unit = filter.field === 'exposure' || filter.field === 'video' ? t("seconds") : filter.field === 'focal' ? 'mm' : filter.field === 'altitude' ? 'm' : '';
      detail = t("with {field} in range {interval} {unit}", { field, interval, unit }).trim();
      break;
    }
    case 'orientation': detail = t(filter.orientation === "portrait" ? "in portrait orientation" : filter.orientation === "landscape" ? "in landscape orientation" : "with square or undetermined orientation"); break;
    case 'dimensions': detail = t("with dimensions {width} × {height} pixels", { width: filter.frame_width ?? 0, height: filter.frame_height ?? 0 }); break;
    case 'date': detail = t("captured on {date}", { date: filter.date ?? '' }); break;
    case 'anniversary': detail = t("captured on {date} (all years)", { date: filter.date ?? '' }); break;
    case 'week': detail = t("captured from {start} through {end} (inclusive)", { start: filter.start ?? '', end: filter.end ?? '' }); break;
    case 'week_hour': detail = t("captured on {weekday} between {hour}", { weekday: weekday(filter.weekday ?? 0), hour: hour(filter.hour ?? 0) }); break;
    case 'month': detail = t("captured in {month} (all years)", { month: new Intl.DateTimeFormat(language, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, (filter.month ?? 1) - 1, 1))) }); break;
    case 'weekday': detail = t("captured on a {weekday} (all years)", { weekday: weekday(filter.weekday ?? 0) }); break;
    case 'hour': detail = t("captured between {hour} (all days)", { hour: hour(filter.hour ?? 0) }); break;
    default: detail = t("captured in {year}", { year: filter.year ?? 0 });
  }
  const qualifiers: string[] = [];
  if (filter.kind === 'week' && filter.name && !filter.source) qualifiers.push(t("with camera “{name}”", { name: displayDeviceName(filter.name, t) }));
  if (filter.source) qualifiers.push(t(filter.source === "device" ? "device “{name}”" : filter.raw ? "EXIF manufacturer “{name}”" : "manufacturer “{name}”", { name: displayDeviceName(filter.name ?? '', t) }));
  if (filter.category && filter.category !== 'all') qualifiers.push(t("category {category}", { category: t(filter.category) }));
  if (filter.favorite_only) qualifiers.push(t("favorites only"));
  if (filter.geo_only) qualifiers.push(t("with location data"));
  if (filter.people_only) qualifiers.push(t("with detected people"));
  if (filter.field && filter.kind !== 'distribution') qualifiers.push(t("with a usable value for {field}", { field }));
  if (filter.orientation && filter.kind !== 'orientation') qualifiers.push(t(filter.orientation === "portrait" ? "Portrait format" : filter.orientation === "landscape" ? "Landscape" : "square/unknown"));
  const scope = filter.scope_year !== undefined ? t(" in {year}", { year: filter.scope_year }) : filter.scope_start ? t(" from {start} through {end}", { start: filter.scope_start, end: filter.scope_end ?? '' }) : '';
  return t("Your {metric}{scope}: {detail}. Capture times follow the local date in Immich.", { metric, scope, detail: [detail, ...qualifiers].join(', ') });
}
