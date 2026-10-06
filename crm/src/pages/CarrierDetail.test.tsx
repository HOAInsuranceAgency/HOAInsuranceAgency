import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('aws-amplify/data', () => ({ generateClient: () => ({ models: { Carrier: { get } } }) }));
vi.mock('../components/DocumentsPanel', () => ({ default: () => null }));
vi.mock('./carrier/AppetiteGuides', () => ({ AppetiteGuides: () => null }));
vi.mock('./carrier/CarrierForm', () => ({ CarrierForm: () => null }));
import CarrierDetail from './CarrierDetail';

it('offers retry for a failed read instead of claiming the carrier does not exist', async () => {
  get.mockResolvedValueOnce({ data: null, errors: [{ message: 'Carrier read failed' }] })
    .mockResolvedValueOnce({ data: { id: 'c1', name: 'Carrier One', appointed: true } });
  render(<MemoryRouter initialEntries={['/carriers/c1']}><Routes><Route path="/carriers/:id" element={<CarrierDetail />} /></Routes></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Carrier read failed');
  expect(screen.queryByText('Carrier not found.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('heading', { name: /Carrier One/ })).toBeInTheDocument();
});
