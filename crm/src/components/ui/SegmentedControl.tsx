import { useRef, type ReactNode } from 'react';
import './SegmentedControl.css';

export interface SegmentedItem<Value extends string> {
  value: Value;
  label: ReactNode;
  count?: number;
  ariaLabel?: string;
  disabled?: boolean;
  title?: string;
}

type Props<Value extends string> = {
  label: string;
  items: readonly SegmentedItem<Value>[];
  value?: Value;
  onChange: (value: Value) => void;
  disabled?: boolean;
  /** Preserve one-stop, arrow-key navigation for saved list filters. */
  rovingFocus?: boolean;
  className?: string;
};

/** Mutually exclusive or single-toggle filters, without implying tab panels. */
export function SegmentedControl<Value extends string>({ label, items, value, onChange, disabled, rovingFocus = false, className = '' }: Props<Value>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const firstEnabled = items.findIndex(item => !item.disabled);
  const selected = items.findIndex(item => item.value === value && !item.disabled);
  return <div className={`ui-segmented-control ${className}`.trim()} role="group" aria-label={label}>
    {items.map((item, index) => <button
      key={item.value}
      ref={element => { buttons.current[index] = element; }}
      type="button"
      className="ui-segmented-control__option"
      aria-pressed={value === item.value}
      aria-label={item.ariaLabel}
      disabled={disabled || item.disabled}
      title={item.title}
      tabIndex={rovingFocus ? index === (selected < 0 ? firstEnabled : selected) ? 0 : -1 : undefined}
      onClick={() => onChange(item.value)}
      onKeyDown={event => {
        if (!rovingFocus) return;
        const enabled = items.flatMap((entry, i) => entry.disabled ? [] : [i]);
        const position = enabled.indexOf(index);
        const next = event.key === 'ArrowRight' ? enabled[(position + 1) % enabled.length]
          : event.key === 'ArrowLeft' ? enabled[(position + enabled.length - 1) % enabled.length]
          : event.key === 'Home' ? enabled[0]
          : event.key === 'End' ? enabled[enabled.length - 1] : undefined;
        if (next === undefined) return;
        event.preventDefault();
        buttons.current[next]?.focus();
        onChange(items[next].value);
      }}
    >{item.label}{item.count !== undefined && <span className="ui-segmented-control__count" aria-hidden="true">({item.count})</span>}</button>)}
  </div>;
}

/** Native radios retain form values, browser keyboard behavior and optional clearing. */
export function SegmentedRadioControl<Value extends string>({ label, name, items, value, onChange, disabled, allowEmpty = false }: Omit<Props<Value>, 'rovingFocus' | 'className' | 'value' | 'onChange'> & { name: string; value: Value | ''; onChange: (value: Value | '') => void; allowEmpty?: boolean }) {
  return <div className="ui-segmented-control" role="radiogroup" aria-label={label}>
    {items.map(item => <label key={item.value} className="ui-segmented-control__radio">
      <input type="radio" name={name} value={item.value} checked={value === item.value} disabled={disabled || item.disabled}
        onClick={() => { if (allowEmpty) onChange(value === item.value ? '' : item.value); }}
        onChange={() => { if (!allowEmpty) onChange(item.value); }} />
      <span>{item.label}</span>
    </label>)}
  </div>;
}
