import { StrictMode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
const h = vi.hoisted(() => ({ load: vi.fn(), sign: vi.fn() }));
vi.mock('../../../web/src/lib/brokerFeeDisclosure', () => ({ loadBrokerFeeDisclosure: h.load, signBrokerFeeDisclosure: h.sign }));
import { BrokerFeeDisclosure } from '../../../web/src/components/BrokerFeeDisclosure';
const terms = () => ({ ok: true, state: 'open', accountName: 'Maple HOA', totalCents: 25000, purpose: 'Insurance placement', refundTerms: 'Refunded if no coverage is bound.', quotes: [{ id: 'q1', carrierName: 'Example Mutual', lines: ['Property'], brokerFee: 250, effectiveDate: '2027-01-01', expirationDate: '2028-01-01' }], stateForms: [{ title: 'Approved state disclosure', paragraphs: ['All required state text is shown before signing.'] }] });
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState({}, '', '/broker-fee/?t=private-token'); h.load.mockResolvedValue(terms()); h.sign.mockResolvedValue({ ...terms(), state: 'signed', signedAt: '2026-11-04T15:00:00Z', downloadUrl: 'https://documents.example.test/signed.pdf', payments: [{ label: 'Pay invoice INV-1', url: 'https://buy.stripe.com/example' }] }); });
it('preserves the token under strict rendering while removing it from the address bar', async () => {
  render(<StrictMode><BrokerFeeDisclosure /></StrictMode>);
  expect(await screen.findByText('Approved state disclosure')).toBeInTheDocument();
  expect(window.location.search).toBe(''); expect(h.load).toHaveBeenCalledWith('private-token');
  expect(screen.queryByRole('link', { name: /pay invoice/i })).not.toBeInTheDocument();
});
it('requires electronic consent then saves the disclosure and offers the existing invoice payment link', async () => {
  const user = userEvent.setup(); render(<BrokerFeeDisclosure />); await screen.findByText('Approved state disclosure');
  const button = screen.getByRole('button', { name: 'Sign fee agreement' }); expect(button).toBeDisabled();
  await user.type(screen.getByLabelText('Your full name'), 'Pat Manager'); await user.type(screen.getByLabelText('Your email'), 'pat@example.com'); await user.type(screen.getByLabelText('Your role'), 'Property Manager');
  expect(button).toBeDisabled(); await user.click(screen.getByRole('checkbox')); await user.click(button);
  expect(await screen.findByText('Disclosure signed and saved')).toBeInTheDocument();
  expect(h.sign).toHaveBeenCalledWith('private-token', { signerName: 'Pat Manager', signerEmail: 'pat@example.com', signerRole: 'Property Manager', consent: true });
  expect(screen.getByRole('link', { name: 'Pay invoice INV-1' })).toHaveAttribute('href', 'https://buy.stripe.com/example');
  expect(screen.getByRole('link', { name: 'Download your signed disclosure' })).toBeInTheDocument();
  expect(screen.getByText(/does not authorize binding or establish coverage/i)).toBeInTheDocument();
});
it('leaves the signer entries available when saving fails', async () => {
  h.sign.mockRejectedValue(new Error('The quote changed. Ask your agency for its current disclosure.'));
  const user = userEvent.setup(); render(<BrokerFeeDisclosure />); await screen.findByText('Approved state disclosure');
  await user.type(screen.getByLabelText('Your full name'), 'Pat Manager'); await user.type(screen.getByLabelText('Your email'), 'pat@example.com'); await user.type(screen.getByLabelText('Your role'), 'Property Manager'); await user.click(screen.getByRole('checkbox')); await user.click(screen.getByRole('button', { name: 'Sign fee agreement' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('quote changed'));
  expect(screen.getByLabelText('Your full name')).toHaveValue('Pat Manager'); expect(screen.queryByText('Disclosure signed and saved')).not.toBeInTheDocument();
});

it('shows the signed IPFS down payment split without offering an agency checkout', async () => {
  const mock = terms();
  h.load.mockResolvedValue({ ...mock, state: 'signed', quotes: [{ ...mock.quotes[0], brokerFee: 3500, billType: 'AGENCY', ipfsAmountFinanced: 10000 }], totalCents: 350000, payments: [{ label: 'Pay invoice INV-1', url: 'https://buy.stripe.com/example' }] });
  render(<BrokerFeeDisclosure />);
  const details = await screen.findByText(/Pay IPFS/);
  expect(details).toHaveTextContent('$3,000.00 is financed and $500.00 is due with your down payment');
  expect(screen.queryByRole('link', { name: /pay invoice/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/when the invoice is ready|excluded from premium financing/i)).not.toBeInTheDocument();
});

it('acknowledges the IPFS display version only after showing the fee split and taking consent', async () => {
  const mock = terms(), user = userEvent.setup();
  h.load.mockResolvedValue({ ...mock, quotes: [{ ...mock.quotes[0], billType: 'AGENCY', ipfsAmountFinanced: 1000, ipfsPriorBrokerFees: 100 }] });
  render(<BrokerFeeDisclosure />);
  expect(await screen.findByText(/Pay IPFS/)).toHaveTextContent('$200.00 is financed and $50.00 is due with your down payment');
  await user.type(screen.getByLabelText('Your full name'), 'Pat Manager'); await user.type(screen.getByLabelText('Your email'), 'pat@example.com'); await user.type(screen.getByLabelText('Your role'), 'Treasurer');
  await user.click(screen.getByRole('checkbox')); await user.click(screen.getByRole('button', { name: 'Sign fee agreement' }));
  expect(h.sign).toHaveBeenCalledWith('private-token', expect.objectContaining({ consent: true, ipfsDisclosureVersion: 'ipfs-v1' }));
});
