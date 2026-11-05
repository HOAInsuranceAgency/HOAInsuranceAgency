import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';
import './Tabs.css';

export interface TabItem<Value extends string> {
  value: Value;
  label: ReactNode;
  disabled?: boolean;
}

type TabsProps<Value extends string> = {
  id: string;
  label: string;
  items: readonly TabItem<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  className?: string;
};

/** Navigation between panels. Filters use SegmentedControl instead. */
export function Tabs<Value extends string>({ id, label, items, value, onChange, className = '' }: TabsProps<Value>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const strip = useRef<HTMLDivElement>(null);
  const selected = items.findIndex(item => item.value === value && !item.disabled);
  const focusable = selected < 0 ? items.findIndex(item => !item.disabled) : selected;
  useLayoutEffect(() => {
    const container = strip.current, tab = buttons.current[selected];
    if (!container || !tab) return;
    const reveal = () => {
      if (!container.clientWidth) return;
      const left = container.getBoundingClientRect().left + container.clientLeft;
      const right = left + container.clientWidth;
      const tabRect = tab.getBoundingClientRect();
      // Only the strip moves. A deep link must never scroll the document or
      // steal focus from another field while keeping the selected tab visible.
      if (tabRect.left < left) container.scrollLeft += tabRect.left - left;
      else if (tabRect.right > right) container.scrollLeft += tabRect.right - right;
    };
    reveal();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reveal);
    observer.observe(container);
    observer.observe(tab);
    return () => observer.disconnect();
  }, [value, selected]);
  return <div ref={strip} className={`ui-tabs ${className}`.trim()} role="tablist" aria-label={label}>
    {items.map((item, index) => <button
      key={item.value}
      ref={element => { buttons.current[index] = element; }}
      type="button"
      className="ui-tabs__tab"
      id={`${id}-tab-${item.value}`}
      role="tab"
      aria-selected={value === item.value}
      aria-controls={`${id}-panel`}
      tabIndex={focusable === index ? 0 : -1}
      disabled={item.disabled}
      onClick={() => onChange(item.value)}
      onKeyDown={event => {
        const enabled = items.flatMap((entry, i) => entry.disabled ? [] : [i]);
        const position = enabled.indexOf(index);
        const next = event.key === 'ArrowRight' ? enabled[(position + 1) % enabled.length]
          : event.key === 'ArrowLeft' ? enabled[(position + enabled.length - 1) % enabled.length]
          : event.key === 'Home' ? enabled[0]
          : event.key === 'End' ? enabled[enabled.length - 1] : undefined;
        if (next === undefined) return;
        event.preventDefault();
        buttons.current[next]?.focus({ preventScroll: true });
        onChange(items[next].value);
      }}
    >{item.label}</button>)}
  </div>;
}

/** The currently mounted panel; callers keep their existing conditional reads. */
export function TabPanel({ tabsId, value, children, ...props }: HTMLAttributes<HTMLDivElement> & { tabsId: string; value: string }) {
  return <div {...props} id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-tab-${value}`} tabIndex={0}>{children}</div>;
}
