import { useId, type AriaAttributes, type ReactNode } from 'react';

export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
}

export interface FieldProps {
  label: ReactNode;
  /** Keep an existing public control ID, or let React allocate a stable unique ID. */
  id?: string;
  help?: ReactNode;
  error?: ReactNode;
  /** Existing descriptions outside this field remain part of the control's description. */
  describedBy?: string;
  invalid?: AriaAttributes['aria-invalid'];
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

const hasContent = (value: ReactNode) => value != null && value !== false && value !== '';

/** Compose one labeled control without inspecting, cloning or remounting its element. */
export function Field({ label, id, help, error, describedBy, invalid, className, children }: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? `field-${generatedId}`;
  const hasHelp = hasContent(help), hasError = hasContent(error);
  const helpId = `${controlId}-help`, errorId = `${controlId}-error`;
  const descriptions = [...new Set([
    ...(describedBy?.split(/\s+/).filter(Boolean) ?? []),
    ...(hasHelp ? [helpId] : []), ...(hasError ? [errorId] : []),
  ])].join(' ') || undefined;
  return <div className={className ? `field ui-field ${className}` : 'field ui-field'}>
    <label htmlFor={controlId}>{label}</label>
    {children({ id: controlId, 'aria-describedby': descriptions, 'aria-invalid': hasError ? true : invalid })}
    {hasHelp && <p id={helpId} className="small muted">{help}</p>}
    {hasError && <p id={errorId} className="error-text" role="alert">{error}</p>}
  </div>;
}
