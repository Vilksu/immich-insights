import { FormEvent, useEffect, useMemo, useState } from 'react';
import { displayDeviceName, useLocale } from './i18n';
import { formatNumber } from './number-format';

type Candidate = {
  make: string; model: string; count: number;
  automatic_name: string; automatic_manufacturer: string; automatic_category: string;
  device_name: string | null; manufacturer: string | null; category: string | null;
};
type Draft = { device_name: string; manufacturer: string; category: string };

export function DeviceRules({ revision, request }: {
  revision: string | null;
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
}) {
  const { t } = useLocale();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'corrected' | 'automatic'>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({ device_name: '', manufacturer: '', category: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const key = (row: Candidate) => `${row.make}\u0000${row.model}`;
  const load = () => request<Candidate[]>('/me/device-candidates').then(setCandidates).catch(error => setMessage(error.message));
  useEffect(() => { load(); }, [revision]);
  const current = candidates.find(row => key(row) === selected);
  const visible = useMemo(() => candidates.filter(row => {
    const corrected = Boolean(row.device_name || row.manufacturer || row.category);
    return (filter === 'all' || (filter === 'corrected') === corrected) &&
      `${row.make} ${row.model} ${row.automatic_name} ${row.automatic_manufacturer} ${row.manufacturer ?? ''} ${row.device_name ?? ''} ${row.category ?? ''} ${displayDeviceName(row.automatic_name, t)} ${displayDeviceName(row.automatic_manufacturer, t)}`.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  }), [candidates, search, filter, t]);
  const choose = (row: Candidate) => {
    setSelected(key(row));
    setDraft({ device_name: row.device_name ?? '', manufacturer: row.manufacturer ?? '', category: row.category ?? '' });
    setMessage('');
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!current) return;
    setBusy(true); setMessage('');
    try {
      await request('/me/device-rules', { method: 'PUT', body: JSON.stringify({ make: current.make, model: current.model,
        device_name: draft.device_name.trim() || null, manufacturer: draft.manufacturer.trim() || null, category: draft.category || null }) });
      await load();
      setMessage(t("Saved. Statistics are recalculated locally without a new Immich scan."));
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!current) return;
    setBusy(true); setMessage('');
    try {
      await request(`/me/device-rules?make=${encodeURIComponent(current.make)}&model=${encodeURIComponent(current.model)}`, { method: 'DELETE' });
      setDraft({ device_name: '', manufacturer: '', category: '' });
      await load();
      setMessage(t("Correction removed. Automatic classification is restored locally."));
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  };
  return <section className="panel device-rules-panel" id="device-rules">
    <p className="eyebrow">{t("Your library")}</p><h2>{t("Correct device assignments")}</h2>
    <p className="muted">{t("Immich Insights automatically classifies devices using EXIF manufacturer and model. Here you can rename combinations for your profile, assign a manufacturer, and classify them as camera, mobile device, or other. Original EXIF data remains unchanged.")}</p>
    {!candidates.length ? <p className="muted">{t("Your devices appear here after the first sync.")}</p> : <div className="device-rule-layout">
      <div><label>{t("Search devices")}<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={t("Manufacturer or model")} /></label><div className="segmented device-rule-filters"><button type="button" className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>{t("All")}</button><button type="button" className={filter === 'corrected' ? 'selected' : ''} onClick={() => setFilter('corrected')}>{t("Corrected")}</button><button type="button" className={filter === 'automatic' ? 'selected' : ''} onClick={() => setFilter('automatic')}>{t("Automatic")}</button></div>
        <div className="device-rule-list">{visible.map(row => <button type="button" key={key(row)} className={selected === key(row) ? 'selected' : ''} onClick={() => choose(row)}><span><b>{displayDeviceName(row.device_name || row.automatic_name, t)}</b><small>{row.make || '—'} · {row.model || '—'}</small><small className="device-rule-current">{displayDeviceName(row.manufacturer || row.automatic_manufacturer, t)} · {t(row.category || row.automatic_category)}</small></span><em>{formatNumber(row.count)}{row.category || row.manufacturer || row.device_name ? t(" · corrected") : ''}</em></button>)}{!visible.length && <p className="muted tiny">{t("No matching devices.")}</p>}</div>
      </div>
      <div>{current ? <form onSubmit={save}><h3>{displayDeviceName(current.automatic_name, t)}</h3><p className="muted tiny">{t("Automatic")}: {displayDeviceName(current.automatic_manufacturer, t)} · {t(current.automatic_category)}</p><div className="device-rule-preview"><small>{t("Current assignment")}</small><strong>{displayDeviceName(current.device_name || current.automatic_name, t)}</strong><span>{displayDeviceName(current.manufacturer || current.automatic_manufacturer, t)} · {t(current.category || current.automatic_category)}</span></div><label>{t("Display name")}<input value={draft.device_name} onChange={event => setDraft({ ...draft, device_name: event.target.value })} placeholder={displayDeviceName(current.automatic_name, t)} maxLength={300} /></label><label>{t("Manufacturer")}<input value={draft.manufacturer} onChange={event => setDraft({ ...draft, manufacturer: event.target.value })} placeholder={displayDeviceName(current.automatic_manufacturer, t)} maxLength={200} /></label><label>{t("Device category")}<select value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value })}><option value="">{t("Automatic")} ({t(current.automatic_category)})</option><option value="Camera">{t("Camera")}</option><option value="Mobile device">{t("Mobile device")}</option><option value="Other">{t("Other")}</option></select></label><div className="device-rule-actions"><button className="primary" disabled={busy || !(draft.device_name.trim() || draft.manufacturer.trim() || draft.category)}>{t("Save correction")}</button>{(current.device_name || current.manufacturer || current.category) && <button type="button" className="secondary" disabled={busy} onClick={remove}>{t("Reset")}</button>}</div></form> : <p className="muted">{t("Choose a device on the left.")}</p>}</div>
    </div>}
    {message && <p className="muted tiny" role="status">{message}</p>}
  </section>;
}
