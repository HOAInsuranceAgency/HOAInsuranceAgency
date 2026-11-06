import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import PolicyCharges from './PolicyCharges';

it('itemizes supplier charges with no HOA fee and keeps the client total separate from premium', () => {
  render(<PolicyCharges source={{ premium: 100.01, passThroughCharges: [{ id: 'tax', kind: 'TAX', description: 'Supplier tax', amountCents: 503 }] }} />);
  expect(screen.getByText('Supplier tax: $5.03')).toBeVisible();
  expect(screen.getByText('$105.04 client policy total')).toBeVisible();
  expect(screen.queryByText(/HOA broker fee/)).toBeNull();
});

it('leaves ordinary legacy premium-only policies uncluttered', () => {
  const { container } = render(<PolicyCharges source={{ premium: 100.01 }} />);
  expect(container).toBeEmptyDOMElement();
});

it('shows a review message instead of a misleading total for malformed recorded charges', () => {
  render(<PolicyCharges source={{ premium: 100, brokerFee: 5, passThroughCharges: [{ id: 'tax', kind: 'TAX', description: 'Supplier tax', amountCents: -1 }] }} />);
  expect(screen.getByText('Review the recorded client charges.')).toBeVisible();
  expect(screen.queryByText(/client policy total/)).toBeNull();
});
