import { forwardRef, type SelectHTMLAttributes } from 'react';
import { useControlSize, type ControlSize } from './ControlDensity';
import './FormControls.css';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  controlSize?: ControlSize;
}

/** Single and multiple selection both retain their native form semantics. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, controlSize, multiple, size, ...props }, ref,
) {
  const density=useControlSize(controlSize);
  return <select
    {...props}
    ref={ref}
    multiple={multiple}
    size={size}
    className={className ? `ui-select ${className}` : 'ui-select'}
    data-size={density}
    data-listbox={multiple || (size ?? 0) > 1 ? 'true' : undefined}
  />;
});

export default Select;
