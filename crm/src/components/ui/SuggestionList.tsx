import { forwardRef, type HTMLAttributes } from 'react';
import { useControlSize, type ControlSize } from './ControlDensity';
import './SuggestionList.css';

/** The owning combobox keeps focus and controls its active descendant. */
export const SuggestionList = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function SuggestionList({ className, ...props }, ref) {
    return <div {...props} ref={ref} role="listbox" className={['ui-suggestion-list', className].filter(Boolean).join(' ')} />;
  },
);

type SuggestionOptionProps = HTMLAttributes<HTMLDivElement> & {
  variant?: 'default' | 'footer';
  controlSize?: ControlSize;
};

/** Selection is expressed with aria-selected; navigation stays with the owner. */
export const SuggestionOption = forwardRef<HTMLDivElement, SuggestionOptionProps>(
  function SuggestionOption({ variant = 'default', controlSize, className, ...props }, ref) {
    const size = useControlSize(controlSize);
    return <div {...props} ref={ref} role="option" className={['ui-suggestion-option', className].filter(Boolean).join(' ')} data-variant={variant} data-size={size} />;
  },
);
