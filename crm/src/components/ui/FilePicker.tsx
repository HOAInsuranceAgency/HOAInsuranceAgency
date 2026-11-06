import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { buttonClassName, type ButtonVariant } from './Button';
import { useControlSize, type ControlSize } from './ControlDensity';
import { Input } from './Input';
import './FilePicker.css';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className' | 'size'> & {
  label: ReactNode;
  variant?: ButtonVariant;
  controlSize?: ControlSize;
  className?: string;
};

/** A focusable native file picker with the same chrome as every action button. */
export const FilePicker = forwardRef<HTMLInputElement, Props>(function FilePicker(
  { label, variant = 'secondary', controlSize, className, id, disabled, ...props }, ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const density = useControlSize(controlSize);
  return <label htmlFor={inputId} className={buttonClassName(`ui-file-picker ${className ?? ''}`)} data-variant={variant} data-size={density} aria-disabled={disabled || undefined}>
    {label}
    <Input {...props} ref={ref} id={inputId} type="file" className="ui-file-input" disabled={disabled} />
  </label>;
});
