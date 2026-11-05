import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: { Policy: { update: h.update, list: async () => ({ data: [] }) }, Quote: { create: h.create, update: h.update } } }) }));
import CoverageForm from "./CoverageForm";
beforeEach(() => { h.create.mockReset(); h.update.mockReset(); });

it('starts new quotes at zero broker fee and validates cents before saving', async () => {
  h.create.mockResolvedValue({ data: {} });
  render(<CoverageForm kind="quote" accountId="a" carriers={[]} existing={null} onSaved={() => {}} onCancel={() => {}} />);
  const fee = screen.getByLabelText('HOA broker fee ($)');
  expect(fee).toHaveValue('0');
  fireEvent.change(fee, { target: { value: '500.123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save quote' }));
  expect(h.create).not.toHaveBeenCalled();
  expect(screen.getByText(/at most two decimal places/)).toBeInTheDocument();
  fireEvent.change(fee, { target: { value: '500.25' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save quote' })));
  expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ brokerFee: 500.25, premium: null, commissionPct: null }));
});

it('automatically uses agency billing for a positive HOA fee and disables direct billing', async () => {
  h.create.mockResolvedValue({ data: {} });
  render(<CoverageForm kind="quote" accountId="a" carriers={[]} existing={null} onSaved={() => {}} onCancel={() => {}} />);
  expect(screen.queryByLabelText('Bill type')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('HOA broker fee ($)'), { target: { value: '500' } });
  fireEvent.change(screen.getByRole('option', { name: 'QUOTED' }).parentElement!, { target: { value: 'QUOTED' } });
  expect(screen.getByLabelText('Bill type')).toHaveValue('AGENCY');
  expect(screen.getByLabelText('Bill type').querySelector('option[value="DIRECT"]')).toBeDisabled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save quote' })));
  expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ brokerFee: 500, billType: 'AGENCY' }));
});

it('rejects an existing direct-bill fee combination until the quote is corrected', async () => {
  render(<CoverageForm kind="quote" accountId="a" carriers={[]} existing={{ id: 'q', brokerFee: 500, billType: 'DIRECT' } as import('../lib/client').Quote} onSaved={() => {}} onCancel={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(h.update).not.toHaveBeenCalled();
  expect(screen.getByText(/Choose Agency bill before saving/)).toBeVisible();
});

it("locks quote fields and cancellation until a pending save settles, then permits recovery", async () => {
  let reject!: (error: Error) => void;
  h.create.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
  const saved = vi.fn(), cancel = vi.fn();
  render(<CoverageForm kind="quote" accountId="a" carriers={[]} existing={null} onSaved={saved} onCancel={cancel} />);
  const textareas = screen.getAllByRole('textbox').filter(node => node.tagName === 'TEXTAREA');
  fireEvent.change(textareas[0], { target: { value: 'Keep this quote note' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save quote' }));
  expect(textareas[0]).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(cancel).not.toHaveBeenCalled();
  await act(async () => reject(new Error('Save unavailable')));
  expect(textareas[0]).toBeEnabled();
  expect(textareas[0]).toHaveValue('Keep this quote note');
  expect(screen.getByText('Save unavailable')).toBeInTheDocument();
  expect(saved).not.toHaveBeenCalled();
});

it('routes tracked policy number corrections to the synchronized commission workflow', async () => {
  h.update.mockResolvedValue({ data: {} });
  const saved = vi.fn();
  render(<CoverageForm kind="policy" accountId="a" carriers={[]}
    existing={{ id: 'p', policyNumber: 'OLD-1', commissionSnapshotId: 'p' } as import('../lib/client').Policy}
    onSaved={saved} onCancel={() => {}} />);
  expect(screen.getByLabelText('Policy number')).toBeDisabled();
  expect(screen.getByRole('link', { name: 'Commissions' })).toHaveAttribute('href', '/commissions');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
  expect(h.update).toHaveBeenCalled();
  expect(h.update.mock.calls[0][0]).not.toHaveProperty('policyNumber');
  expect(saved).toHaveBeenCalled();
});

it.each([0, 500])('records source charges and client conditions alongside a $%s HOA fee', async brokerFee => {
  h.create.mockResolvedValue({ data: {} });
  render(<CoverageForm kind="quote" accountId="a" carriers={[]} existing={null} onSaved={() => {}} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText('Premium ($)'), { target: { value: '55541' } });
  fireEvent.change(screen.getByLabelText('HOA broker fee ($)'), { target: { value: String(brokerFee) } });
  fireEvent.click(screen.getByRole('button', { name: 'Add supplier charge or tax' }));
  fireEvent.change(screen.getByLabelText('Charge 1 description'), { target: { value: 'RT brokerage fee' } });
  fireEvent.change(screen.getByLabelText('Charge 1 amount'), { target: { value: '250' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add supplier charge or tax' }));
  fireEvent.change(screen.getByLabelText('Charge 2 type'), { target: { value: 'SURPLUS_LINES' } });
  fireEvent.change(screen.getByLabelText('Charge 2 description'), { target: { value: 'MA surplus lines tax' } });
  fireEvent.change(screen.getByLabelText('Charge 2 amount'), { target: { value: '2221.64' } });
  fireEvent.change(screen.getByLabelText('Client conditions'), { target: { value: '25% minimum earned premium. No flat cancellations.' } });
  expect(screen.getByText(`Client policy total: $${brokerFee ? '58,512.64' : '58,012.64'}`)).toBeVisible();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save quote' })));
  const saved = h.create.mock.calls[0][0];
  expect(saved).toMatchObject({ premium: 55541, brokerFee, clientConditions: '25% minimum earned premium. No flat cancellations.' });
  expect(JSON.parse(saved.passThroughCharges)).toEqual([
    { id: expect.any(String), kind: 'WHOLESALER_FEE', description: 'RT brokerage fee', amountCents: 25000 },
    { id: expect.any(String), kind: 'SURPLUS_LINES', description: 'MA surplus lines tax', amountCents: 222164 },
  ]);
});

it('preserves source charge IDs on editing and rejects fractional cents before saving', async () => {
  h.update.mockResolvedValue({ data: {} });
  render(<CoverageForm kind="quote" accountId="a" carriers={[]} existing={{ id: 'q', status: 'DRAFT', passThroughCharges: JSON.stringify([{ id: 'original-charge', kind: 'CARRIER_FEE', description: 'Carrier fee', amountCents: 5000 }]) } as import('../lib/client').Quote} onSaved={() => {}} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText('Charge 1 amount'), { target: { value: '55.123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(h.update).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Charge 1 amount'), { target: { value: '55.12' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
  expect(JSON.parse(h.update.mock.calls[0][0].passThroughCharges)[0]).toMatchObject({ id: 'original-charge', amountCents: 5512 });
});

it('preserves absent structured charges on ordinary legacy quote edits', async () => {
  h.update.mockResolvedValue({ data: {} });
  render(<CoverageForm kind="quote" accountId="a" carriers={[]} existing={{ id: 'legacy', status: 'DRAFT', notes: 'Legacy tax invoice remains valid' } as import('../lib/client').Quote} onSaved={() => {}} onCancel={() => {}} />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' })));
  expect(h.update.mock.calls[0][0]).not.toHaveProperty('passThroughCharges');
});

it('keeps unfinished charge rows editable and previews amounts before their labels are complete', () => {
  render(<CoverageForm kind="quote" accountId="a" carriers={[]} existing={null} onSaved={() => {}} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText('Premium ($)'), { target: { value: '19.99' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add supplier charge or tax' }));
  expect(screen.getByText('Client policy total: $19.99')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Charge 1 amount'), { target: { value: '.' } });
  expect(screen.getByLabelText('Charge 1 amount')).toHaveValue('.');
  expect(screen.getByText('Client policy total: —')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Charge 1 amount'), { target: { value: '.01' } });
  expect(screen.getByLabelText('Charge 1 description')).toHaveValue('');
  expect(screen.getByText('Client policy total: $20.00')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Charge 1 amount'), { target: { value: '1.001' } });
  expect(screen.getByText('Client policy total: —')).toBeVisible();
  fireEvent.change(screen.getByLabelText('Charge 1 amount'), { target: { value: '1.00' } });
  expect(screen.getByText('Client policy total: $20.99')).toBeVisible();
  expect(h.create).not.toHaveBeenCalled();
});
