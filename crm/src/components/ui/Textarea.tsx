import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { useControlSize, type ControlSize } from './ControlDensity';
import './FormControls.css';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  controlSize?: ControlSize;
}

/** Native rows, value, validation, selection, and events pass through unchanged. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, controlSize, ...props }, ref,
) {
  const density=useControlSize(controlSize);
  return <textarea
    {...props}
    ref={ref}
    className={className ? `ui-textarea ${className}` : 'ui-textarea'}
    data-size={density}
  />;
});

export default Textarea;
