import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: { Policy: { update: h.update, list: async () => ({ data: [] }) }, Quote: { create: h.create } } }) }));
import CoverageForm from "./CoverageForm";
beforeEach(() => { h.create.mockReset(); h.update.mockReset(); });

it('starts new quotes at zero broker fee and validates cents before saving', async () => {
  h.create.mockResolvedValue({ data: {} });
  render(<CoverageForm kind="quote" accountId="a" carriers={[]} existing={null} onSaved={() => {}} onCancel={() => {}} />);
  const fee = screen.getByLabelText('Broker fee ($)');
  expect(fee).toHaveValue('0');
  fireEvent.change(fee, { target: { value: '500.123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save quote' }));
  expect(h.create).not.toHaveBeenCalled();
  expect(screen.getByText(/at most two decimal places/)).toBeInTheDocument();
  fireEvent.change(fee, { target: { value: '500.25' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save quote' })));
  expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ brokerFee: 500.25, premium: null, commissionPct: null }));
});

it('uses the existing bill type before presenting a fee quote so direct bill does not charge premium twice', async () => {
  h.create.mockResolvedValue({ data: {} });
  render(<CoverageForm kind="quote" accountId="a" carriers={[]} existing={null} onSaved={() => {}} onCancel={() => {}} />);
  expect(screen.queryByLabelText('Bill type')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Broker fee ($)'), { target: { value: '500' } });
  fireEvent.change(screen.getByRole('option', { name: 'QUOTED' }).parentElement!, { target: { value: 'QUOTED' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save quote' }));
  expect(h.create).not.toHaveBeenCalled();
  expect(screen.getByText(/Choose who bills the premium/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Bill type'), { target: { value: 'DIRECT' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save quote' })));
  expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ brokerFee: 500, billType: 'DIRECT' }));
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
