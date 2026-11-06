import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Button } from './Button';
import './MetricButton.css';

/** A navigable metric uses a real button, with shared card/hover/focus chrome. */
export const MetricButton = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & { hot?: boolean }>(
  function MetricButton({ hot, className, ...props }, ref) {
    return <Button {...props} ref={ref} type="button" variant="surface" className={['ui-metric-button', 'stat', className].filter(Boolean).join(' ')} data-hot={hot || undefined} />;
  },
);
