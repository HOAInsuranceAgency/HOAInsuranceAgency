import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Button, ButtonLink, ButtonSummary } from './Button';
import { Input } from './Input';
import { Table } from './Table';
import { FilePicker } from './FilePicker';

it('keeps native submit, explicit button, disabled and ref behavior', async () => {
  const submit = vi.fn(event => event.preventDefault()), ref = createRef<HTMLButtonElement>();
  render(<form onSubmit={submit}><Button ref={ref}>Save</Button><Button type="button">Other</Button><Button disabled>Blocked</Button></form>);
  expect(ref.current).toBe(screen.getByRole('button', { name: 'Save' }));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Other' }));
  await user.click(screen.getByRole('button', { name: 'Blocked' }));
  expect(submit).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(submit).toHaveBeenCalledTimes(1);
});

it('retains navigation and native disclosure semantics', () => {
  render(<><ButtonLink href="/documents" target="_blank" rel="noreferrer">Documents</ButtonLink><details><ButtonSummary>Add contact</ButtonSummary><p>Contact form</p></details></>);
  expect(screen.getByRole('link', { name: 'Documents' })).toHaveAttribute('href', '/documents');
  expect(screen.getByText('Add contact').tagName).toBe('SUMMARY');
});

it('preserves table semantics and refs while sharing compact control sizing', () => {
  const ref = createRef<HTMLTableElement>();
  render(<Table ref={ref} aria-label="Policies"><thead><tr><th>Policy</th></tr></thead><tbody><tr><th scope="row">A</th><td><Input aria-label="Premium" defaultValue="10" /><Button>View</Button></td></tr></tbody></Table>);
  expect(ref.current).toBe(screen.getByRole('table', { name: 'Policies' }));
  expect(screen.getByRole('rowheader', { name: 'A' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Premium' })).toHaveAttribute('data-size', 'compact');
  expect(screen.getByRole('button', { name: 'View' })).toHaveAttribute('data-size', 'compact');
});

it('keeps the native file input in the tab order and preserves uploads and disabled state', async () => {
  const changed = vi.fn(), ref = createRef<HTMLInputElement>();
  const view = render(<FilePicker label="Upload document" ref={ref} onChange={changed} accept=".pdf" />);
  const input = screen.getByLabelText('Upload document');
  expect(ref.current).toBe(input);
  await userEvent.setup().tab();
  expect(input).toHaveFocus();
  const file = new File(['pdf'], 'policy.pdf', { type: 'application/pdf' });
  await userEvent.setup().upload(input, file);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(ref.current?.files?.[0]).toBe(file);
  view.rerender(<FilePicker label="Upload document" ref={ref} onChange={changed} disabled />);
  expect(screen.getByLabelText('Upload document')).toBeDisabled();
  fireEvent.click(screen.getByText('Upload document'));
  expect(changed).toHaveBeenCalledTimes(1);
});
