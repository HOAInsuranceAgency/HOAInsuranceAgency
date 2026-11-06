import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('../lib/relationships', () => ({ searchParties: h.search }));
vi.mock('../lib/communications', () => ({ communicationRequest: h.search }));

import AccountPicker from './AccountPicker';
import PartyPicker from './PartyPicker';

beforeEach(() => h.search.mockReset());

describe.each([
  {
    name: 'account picker',
    show: () => render(<AccountPicker value="" onChange={vi.fn()} disabled={false} />),
    searchButton: 'Search accounts',
    empty: 'No matching accounts.',
    more: 'More accounts remain to search.',
    continueButton: 'Continue searching accounts',
  },
  {
    name: 'relationship picker',
    show: () => render(<PartyPicker label="Relationship" value="" onChange={vi.fn()} />),
    searchButton: 'Search',
    empty: 'No matching profiles.',
    more: 'More profiles remain to search.',
    continueButton: 'Continue searching',
  },
])('$name', ({ show, searchButton, empty, more, continueButton }) => {
  function search() {
    show();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Sample' } });
    fireEvent.click(screen.getByRole('button', { name: searchButton }));
  }

  it('shows a failed search without claiming no matches, then reports a successful empty retry', async () => {
    h.search.mockRejectedValueOnce(new Error('Search unavailable'))
      .mockResolvedValueOnce({ items: [] });
    search();

    expect(await screen.findByRole('alert')).toHaveTextContent('Search unavailable');
    expect(screen.queryByText(empty)).not.toBeInTheDocument();
    expect(screen.queryByText(more)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(empty)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(h.search).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a successful partial search from a failed continuation', async () => {
    h.search.mockResolvedValueOnce({ items: [], nextToken: 'next-page' })
      .mockRejectedValueOnce(new Error('Next page unavailable'))
      .mockResolvedValueOnce({ items: [] });
    search();

    expect(await screen.findByText(more)).toBeInTheDocument();
    expect(screen.queryByText(empty)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: continueButton }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Next page unavailable');
    expect(screen.queryByText(empty)).not.toBeInTheDocument();
    expect(screen.queryByText(more)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(empty)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(h.search.mock.calls[2]).toEqual(h.search.mock.calls[1]);
  });
});
