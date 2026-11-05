import { forwardRef, type TableHTMLAttributes } from 'react';
import { ControlSizeProvider } from './ControlDensity';
import './Table.css';

/** One native table and one horizontal-scroll boundary on every screen. */
export const Table = forwardRef<HTMLTableElement, TableHTMLAttributes<HTMLTableElement>>(
  function Table({ className, ...props }, ref) {
    return <ControlSizeProvider size="compact"><div className="ui-table-scroll"><table {...props} ref={ref} className={['ui-table', className].filter(Boolean).join(' ')} /></div></ControlSizeProvider>;
  },
);
