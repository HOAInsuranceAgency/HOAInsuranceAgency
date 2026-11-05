import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type HTMLAttributes } from 'react';
import { useControlSize, type ControlSize } from './ControlDensity';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'link' | 'ghost' | 'plain' | 'surface' | 'inverse' | 'google';
export type { ControlSize } from './ControlDensity';
type Appearance = { variant?: ButtonVariant; controlSize?: ControlSize; iconOnly?: boolean };

export function buttonClassName(className = '') { return ['ui-button', className].filter(Boolean).join(' '); }

/** Native type is deliberately preserved, including implicit form submission. */
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & Appearance>(
  function Button({ variant = 'secondary', controlSize, iconOnly = false, className, ...props }, ref) {
    const size = useControlSize(controlSize);
    return <button {...props} ref={ref} className={buttonClassName(className)} data-variant={variant} data-size={size} data-icon-only={iconOnly || undefined} />;
  },
);

/** Navigation/download actions keep anchor semantics while sharing button chrome. */
export const ButtonLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & Appearance>(
  function ButtonLink({ variant = 'secondary', controlSize, iconOnly = false, className, ...props }, ref) {
    const size = useControlSize(controlSize);
    return <a {...props} ref={ref} className={buttonClassName(className)} data-variant={variant} data-size={size} data-icon-only={iconOnly || undefined} />;
  },
);

/** A button-shaped disclosure keeps native details/summary keyboard behavior. */
export const ButtonSummary = forwardRef<HTMLElement, HTMLAttributes<HTMLElement> & Appearance>(
  function ButtonSummary({ variant = 'secondary', controlSize, iconOnly = false, className, ...props }, ref) {
    const size = useControlSize(controlSize);
    return <summary {...props} ref={ref} className={buttonClassName(className)} data-variant={variant} data-size={size} data-icon-only={iconOnly || undefined} />;
  },
);
