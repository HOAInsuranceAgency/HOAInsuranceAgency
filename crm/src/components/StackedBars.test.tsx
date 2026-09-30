import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { StackedBars } from './StackedBars';
it('exposes every signed series value and the reconciled total without relying on color', () => {
  render(<StackedBars label="Commission" series={[{ key: 'a', label: 'Avery' }, { key: 'b', label: 'Blake' }]} rows={[{ key: 'month', label: 'September', values: { a: 200, b: -50 } }]} />);
  expect(screen.getByRole('img', { name: 'September: 150. Avery: 200; Blake: -50' })).toHaveAttribute('tabindex', '0');
  expect(screen.getByText('View chart values')).toBeInTheDocument();
  expect(document.querySelector('.sales-chart-zero')).toBeInTheDocument();
});
