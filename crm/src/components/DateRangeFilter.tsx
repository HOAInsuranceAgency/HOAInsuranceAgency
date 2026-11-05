import { useId } from 'react';
import { dateRangeError, dateRangePreset, reportToday, type DateRange, type DateRangePreset, type DateRangeValidation } from '../lib/dateRange';
import './DateRangeFilter.css';

type Props = DateRangeValidation & {
  value: DateRange;
  onChange: (value: DateRange) => void;
  label?: string;
  disabled?: boolean;
};

/** One report filter: every valid date/preset applies without a submit step. */
export function DateRangeFilter({ value, onChange, label = 'Date range', disabled = false, allowOpenEnded = false, validate }: Props) {
  const id = useId();
  const today = reportToday();
  const error = dateRangeError(value, { allowOpenEnded, validate });
  const presets: [DateRangePreset, string][] = [
    ...(allowOpenEnded ? [['all', 'All time'] as [DateRangePreset, string]] : []),
    ['ytd', 'Year to date'], ['12mo', 'Last 12 months'],
  ];
  return <div className="card date-range-filter" role="group" aria-label={label}>
    <div className="chip-row date-range-presets">
      {presets.map(([preset, title]) => {
        const range = dateRangePreset(preset, today);
        const selected = range.from === value.from && range.to === value.to;
        return <button key={preset} type="button" disabled={disabled} className={selected ? 'on' : ''} aria-pressed={selected} onClick={() => onChange(dateRangePreset(preset))}>{title}</button>;
      })}
    </div>
    <div className="date-range-fields">
      <div className="field"><label htmlFor={`${id}-from`}>From</label><input id={`${id}-from`} aria-label="From date" type="date" value={value.from} disabled={disabled} required={!allowOpenEnded} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} onChange={event => onChange({ ...value, from: event.target.value })} /></div>
      <div className="field"><label htmlFor={`${id}-to`}>Through</label><input id={`${id}-to`} aria-label="Through date" type="date" value={value.to} disabled={disabled} required={!allowOpenEnded} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} onChange={event => onChange({ ...value, to: event.target.value })} /></div>
    </div>
    {error && <p id={`${id}-error`} role="alert" className="error-text">{error}</p>}
  </div>;
}
