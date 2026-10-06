import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { CommercialPlan } from '../../../shared/quotePackages';
const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/communications', () => ({ communicationRequest: request }));
import { OpportunityEstimate } from './OpportunityEstimate';

it('saves against the version originally edited when a refresh changes the estimate', async () => {
  request.mockRejectedValue(new Error('Estimate changed. Refresh and try again.'));
  const plan = { accountId: 'a', version: 1, estimatedCents: 10000 } as CommercialPlan;
  const saved = vi.fn();
  const view = render(<OpportunityEstimate plan={plan} onSaved={saved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit estimated opportunity' }));
  fireEvent.change(screen.getByLabelText('Estimated agency commission'), { target: { value: '250' } });
  view.rerender(<OpportunityEstimate plan={{ ...plan, version: 2, estimatedCents: 30000 }} onSaved={saved} />);
  fireEvent.submit(screen.getByLabelText('Estimated agency commission').closest('form')!);
  await act(async () => {});
  expect(request).toHaveBeenCalledWith('saveCommercial', expect.objectContaining({ version: 1, amount: '250' }), true);
  expect(screen.getByLabelText('Estimated agency commission')).toHaveValue('250');
  expect(saved).not.toHaveBeenCalled();
});
