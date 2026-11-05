import { forwardRef, type InputHTMLAttributes } from 'react';
import { useControlSize, type ControlSize } from './ControlDensity';
import './FormControls.css';

export type { ControlSize } from './ControlDensity';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Visual density; the native `size` attribute retains its normal meaning. */
  controlSize?: ControlSize;
}

const nativeTypes = new Set(['checkbox', 'radio', 'file', 'hidden', 'range', 'color', 'button', 'submit', 'reset', 'image']);

/** Native input behavior and events, with shared field styling where appropriate. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, controlSize, type, ...props }, ref,
) {
  const density=useControlSize(controlSize);
  return <input
    {...props}
    ref={ref}
    type={type}
    className={className ? `ui-input ${className}` : 'ui-input'}
    data-size={density}
    data-ui-appearance={nativeTypes.has(type?.toLowerCase() ?? 'text') ? 'native' : 'field'}
  />;
});

export default Input;
