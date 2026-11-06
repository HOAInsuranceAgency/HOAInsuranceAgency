import { createRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Field } from './Field';
import { Input } from './Input';
import { Select } from './Select';
import { Textarea } from './Textarea';
import { DateInput, FeinInput, IntegerInput, MoneyInput, PercentInput, PhoneInput, YearInput } from '../inputs';

vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ models: {} }) }));

describe('Field composition', () => {
  it('provides unique stable IDs and focuses the native control through its label', async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLInputElement>();
    const view = render(<>
      <Field label="Name">{control => <Input {...control} ref={ref} />}</Field>
      <Field label="State">{control => <Select {...control}><option>MA</option></Select>}</Field>
      <Field label="Notes">{control => <Textarea {...control} />}</Field>
    </>);
    const input = screen.getByLabelText('Name');
    const originalId = input.id;
    expect(new Set([...view.container.querySelectorAll('label')].map(label => label.htmlFor)).size).toBe(3);
    expect(ref.current).toBe(input);
    await user.click(screen.getByText('Name'));
    expect(input).toHaveFocus();
    view.rerender(<>
      <Field label="Name" help="As shown on the application.">{control => <Input {...control} ref={ref} />}</Field>
      <Field label="State">{control => <Select {...control}><option>MA</option></Select>}</Field>
      <Field label="Notes">{control => <Textarea {...control} />}</Field>
    </>);
    expect(screen.getByLabelText('Name')).toBe(input);
    expect(input.id).toBe(originalId);
    expect(ref.current).toBe(input);
    expect(input).toHaveFocus();
  });

  it('merges help, errors and existing descriptions without stale or duplicate references', () => {
    const view = render(<>
      <p id="external-description">External guidance.</p>
      <Field label="Amount" id="existing-amount" className="full" describedBy="external-description external-description" help="Enter dollars." error="Check the amount.">
        {control => <Input {...control} />}
      </Field>
    </>);
    const input = screen.getByLabelText('Amount');
    expect(input.id).toBe('existing-amount');
    expect(input).toHaveAccessibleDescription('External guidance. Enter dollars. Check the amount.');
    expect(input).toHaveAttribute('aria-describedby', 'external-description existing-amount-help existing-amount-error');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Check the amount.');
    expect(input.closest('.field')).toHaveClass('full');
    view.rerender(<>
      <p id="external-description">External guidance.</p>
      <Field label="Amount" id="existing-amount">{control => <Input {...control} />}</Field>
    </>);
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([MoneyInput, PercentInput, IntegerInput, YearInput, PhoneInput, FeinInput, DateInput])('forwards field accessibility through %s', Component => {
    render(<Field label="Formatted value" help="Source value." error="Review this value.">
      {control => <Component {...control} value="" onChange={vi.fn()} aria-required="true" aria-errormessage="other-error" />}
    </Field>);
    const input = screen.getByLabelText('Formatted value');
    expect(input).toHaveAccessibleDescription('Source value. Review this value.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input).toHaveAttribute('aria-errormessage', 'other-error');
  });

  it('does not remount a focused formatted input or reshape its draft when help or error changes', async () => {
    const user = userEvent.setup();
    const onKeyDown = vi.fn();
    function Editor({ error }: { error?: string }) {
      const [value, setValue] = useState('1234.50');
      return <Field label="Premium" help="Client premium." error={error}>
        {control => <MoneyInput {...control} value={value} onChange={setValue} onKeyDown={onKeyDown} />}
      </Field>;
    }
    const view = render(<Editor />);
    const input = screen.getByLabelText('Premium') as HTMLInputElement;
    expect(input).toHaveValue('1,234.50');
    await user.click(input);
    expect(input).toHaveValue('1234.50');
    input.setSelectionRange(2, 2);
    view.rerender(<Editor error="Check premium." />);
    expect(screen.getByLabelText('Premium')).toBe(input);
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(2);
    expect(input).toHaveValue('1234.50');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalledOnce();
    await user.tab();
    expect(input).toHaveValue('1,234.50');
  });
});
