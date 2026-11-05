import { createRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Input } from './Input';
import { Select } from './Select';
import { Textarea } from './Textarea';
import { ControlSizeProvider } from './ControlDensity';

describe('shared native form controls', () => {
  it('inherits compact density while explicit sizes and native size/rows keep their own meanings', () => {
    render(<ControlSizeProvider size="compact">
      <Input aria-label="Inherited input" size={28} />
      <Select aria-label="Inherited select"><option>Choice</option></Select>
      <Textarea aria-label="Inherited notes" rows={4} />
      <Input aria-label="Standard input" controlSize="standard" />
      <Select aria-label="Standard select" controlSize="standard"><option>Choice</option></Select>
      <Textarea aria-label="Standard notes" controlSize="standard" />
    </ControlSizeProvider>);
    for (const label of ['Inherited input', 'Inherited select', 'Inherited notes']) expect(screen.getByLabelText(label)).toHaveAttribute('data-size', 'compact');
    for (const label of ['Standard input', 'Standard select', 'Standard notes']) expect(screen.getByLabelText(label)).toHaveAttribute('data-size', 'standard');
    expect(screen.getByLabelText('Inherited input')).toHaveAttribute('size', '28');
    expect(screen.getByLabelText('Inherited notes')).toHaveAttribute('rows', '4');
  });

  it('preserves controlled input values, native events, accessibility props and refs', () => {
    const ref = createRef<HTMLInputElement>(), changed = vi.fn(), blurred = vi.fn(), keyed = vi.fn();
    function Form() {
      const [value, setValue] = useState('Original');
      return <><span id="search-help">Search accounts</span><Input ref={ref} type="search" name="query" value={value}
        aria-label="Account search" aria-describedby="search-help" autoComplete="off" className="account-query"
        controlSize="compact" size={35} onChange={event => { changed(event.currentTarget.value, event.currentTarget.type); setValue(event.currentTarget.value); }}
        onBlur={blurred} onKeyDown={keyed} /></>;
    }
    render(<Form />);
    const input = screen.getByRole('searchbox', { name: 'Account search' });
    expect(ref.current).toBe(input);
    expect(input).toHaveClass('ui-input', 'account-query');
    expect(input).toHaveAttribute('size', '35');
    expect(input).toHaveAttribute('data-size', 'compact');
    expect(input).toHaveAccessibleDescription('Search accounts');
    fireEvent.change(input, { target: { value: 'A & B Association' } });
    expect(input).toHaveValue('A & B Association');
    expect(changed).toHaveBeenCalledExactlyOnceWith('A & B Association', 'search');
    fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.blur(input);
    expect(keyed).toHaveBeenCalledTimes(1); expect(blurred).toHaveBeenCalledTimes(1);
    ref.current!.focus(); expect(input).toHaveFocus();
  });

  it('keeps uncontrolled values and normal form reset/submission behavior', () => {
    const view = render(<form aria-label="Contact"><Input name="name" aria-label="Name" defaultValue="Pat" /></form>);
    const form = screen.getByRole('form', { name: 'Contact' }) as HTMLFormElement;
    const input = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.change(input, { target: { value: 'Taylor' } });
    view.rerender(<form aria-label="Contact"><Input name="name" aria-label="Name" defaultValue="Pat" className="updated" /></form>);
    expect(input).toHaveValue('Taylor');
    expect(new FormData(form).get('name')).toBe('Taylor');
    form.reset();
    expect(input).toHaveValue('Pat');
  });

  it('retains number/date constraints and native invalid events', () => {
    const invalid = vi.fn();
    render(<><Input aria-label="Amount" type="number" required min={1} max={3} step={0.5} defaultValue="0" onInvalid={invalid} />
      <Input aria-label="Effective date" type="date" required min="2026-01-01" max="2026-12-31" defaultValue="2026-11-04" /></>);
    const amount = screen.getByRole('spinbutton', { name: 'Amount' }) as HTMLInputElement;
    expect(amount.checkValidity()).toBe(false); expect(invalid).toHaveBeenCalledTimes(1);
    fireEvent.change(amount, { target: { value: '2.5' } }); expect(amount.checkValidity()).toBe(true);
    fireEvent.change(amount, { target: { value: '' } }); expect(amount.validity.valueMissing).toBe(true);
    const date = screen.getByLabelText('Effective date') as HTMLInputElement;
    expect(date.type).toBe('date'); expect(date.value).toBe('2026-11-04');
    expect(date.min).toBe('2026-01-01'); expect(date.max).toBe('2026-12-31'); expect(date.checkValidity()).toBe(true);
  });

  it('keeps checkbox and radio checked/change semantics without opting into text-field appearance', () => {
    const checked = vi.fn();
    render(<><Input aria-label="Consent" type="checkbox" defaultChecked onChange={event => checked(event.currentTarget.checked)} />
      <Input aria-label="Agency bill" type="radio" name="billing" value="AGENCY" defaultChecked />
      <Input aria-label="Direct bill" type="radio" name="billing" value="DIRECT" /></>);
    const checkbox = screen.getByRole('checkbox', { name: 'Consent' });
    fireEvent.click(checkbox); expect(checkbox).not.toBeChecked(); expect(checked).toHaveBeenCalledExactlyOnceWith(false);
    fireEvent.click(screen.getByRole('radio', { name: 'Direct bill' }));
    expect(screen.getByRole('radio', { name: 'Agency bill' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Direct bill' })).toBeChecked();
    for (const control of [checkbox, ...screen.getAllByRole('radio')]) expect(control).toHaveAttribute('data-ui-appearance', 'native');
  });

  it('forwards file inputs and selection events without assigning a value or field appearance', () => {
    const ref = createRef<HTMLInputElement>(), selected = vi.fn();
    render(<Input ref={ref} type="file" aria-label="Documents" name="documents" accept="application/pdf" multiple
      onChange={event => selected(event.currentTarget.files)} />);
    const input = screen.getByLabelText('Documents'), file = new File(['policy'], 'policy.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(ref.current).toBe(input); expect(input).toHaveAttribute('accept', 'application/pdf');
    expect(input).toHaveAttribute('multiple'); expect(input).toHaveAttribute('data-ui-appearance', 'native');
    expect(selected).toHaveBeenCalledExactlyOnceWith([file]);
  });

  it('preserves a controlled select, options, forwarded ref and required validation', () => {
    const ref = createRef<HTMLSelectElement>(), selected = vi.fn();
    function Form() {
      const [value, setValue] = useState('');
      return <Select ref={ref} name="state" aria-label="State" required value={value} controlSize="compact"
        onChange={event => { selected(event.currentTarget.value); setValue(event.currentTarget.value); }}>
        <option value="">Choose…</option><optgroup label="New England"><option value="MA">Massachusetts</option><option value="NH">New Hampshire</option></optgroup>
      </Select>;
    }
    render(<Form />);
    const select = screen.getByRole('combobox', { name: 'State' }) as HTMLSelectElement;
    expect(ref.current).toBe(select); expect(select.checkValidity()).toBe(false);
    fireEvent.change(select, { target: { value: 'NH' } });
    expect(selected).toHaveBeenCalledExactlyOnceWith('NH'); expect(select).toHaveValue('NH'); expect(select.checkValidity()).toBe(true);
    expect(select).toHaveAttribute('data-size', 'compact'); expect(select).not.toHaveAttribute('data-listbox');
    ref.current!.focus(); expect(select).toHaveFocus();
  });

  it('retains native multiple-select values and size instead of forcing a one-line dropdown', () => {
    const ref = createRef<HTMLSelectElement>();
    render(<form aria-label="Coverage"><Select ref={ref} aria-label="Lines" name="line" multiple size={5} defaultValue={['property', 'gl']}>
      <option value="property">Property</option><option value="gl">Liability</option><option value="crime">Crime</option>
    </Select></form>);
    const select = screen.getByRole('listbox', { name: 'Lines' });
    expect(ref.current).toBe(select); expect(select).toHaveAttribute('size', '5'); expect(select).toHaveAttribute('data-listbox', 'true');
    expect(select).toHaveValue(['property', 'gl']);
    expect(new FormData(screen.getByRole('form', { name: 'Coverage' }) as HTMLFormElement).getAll('line')).toEqual(['property', 'gl']);
  });

  it('preserves controlled textarea newlines, rows, native attributes and selection through its ref', () => {
    const ref = createRef<HTMLTextAreaElement>(), changed = vi.fn();
    function Form() {
      const [value, setValue] = useState('Initial');
      return <Textarea ref={ref} aria-label="Conditions" name="conditions" value={value} rows={6} maxLength={6000} required
        onChange={event => { changed(event.currentTarget.value); setValue(event.currentTarget.value); }} />;
    }
    render(<Form />);
    const textarea = screen.getByRole('textbox', { name: 'Conditions' });
    fireEvent.change(textarea, { target: { value: 'First line\nSecond line' } });
    expect(ref.current).toBe(textarea); expect(textarea).toHaveValue('First line\nSecond line');
    expect(changed).toHaveBeenCalledExactlyOnceWith('First line\nSecond line');
    expect(textarea).toHaveAttribute('rows', '6'); expect(textarea).toHaveAttribute('maxlength', '6000');
    ref.current!.setSelectionRange(0, 5); expect(ref.current!.selectionStart).toBe(0); expect(ref.current!.selectionEnd).toBe(5);
  });

  it('retains uncontrolled textarea values, readonly/disabled semantics and native form exclusion', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<form aria-label="Saved values"><Input name="readonly" aria-label="Read only" readOnly defaultValue="Keep" />
      <Input name="disabled" aria-label="Disabled" disabled defaultValue="Skip" />
      <Textarea ref={ref} name="notes" aria-label="Notes" defaultValue="Original" rows={3} controlSize="compact" />
      <Select name="disabled-select" aria-label="Disabled choice" disabled defaultValue="a"><option value="a">A</option></Select>
    </form>);
    const form = screen.getByRole('form', { name: 'Saved values' }) as HTMLFormElement;
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'Edited' } });
    expect(new FormData(form).get('readonly')).toBe('Keep'); expect(new FormData(form).has('disabled')).toBe(false);
    expect(new FormData(form).has('disabled-select')).toBe(false); expect(new FormData(form).get('notes')).toBe('Edited');
    expect(screen.getByRole('textbox', { name: 'Read only' })).toHaveAttribute('readonly');
    expect(ref.current).toHaveAttribute('data-size', 'compact'); form.reset(); expect(ref.current).toHaveValue('Original');
  });
});
