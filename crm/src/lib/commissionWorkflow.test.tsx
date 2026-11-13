import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { CommissionWorkflowContext, useCommissionPreference } from './commissionWorkflow';

function Choice() {
  const [choice, setChoice] = useCommissionPreference('choice', 'initial');
  return <button onClick={() => setChoice('new choice')}>{choice}</button>;
}
function Workspace({ storageKey }: { storageKey?: string }) {
  return <CommissionWorkflowContext.Provider value={{target:{tab:'statements'},navigate:()=>{},storageKey}}><Choice /></CommissionWorkflowContext.Provider>;
}
beforeEach(() => localStorage.clear());
it('restores a saved preference when the Owner identity arrives', async () => {
  localStorage.setItem('owner:choice', JSON.stringify('saved choice'));
  const view = render(<Workspace />);
  view.rerender(<Workspace storageKey="owner" />);
  expect(await screen.findByRole('button', {name:'saved choice'})).toBeInTheDocument();
});
it('keeps and saves a fresh selection made before the Owner identity arrives', async () => {
  localStorage.setItem('owner:choice', JSON.stringify('saved choice'));
  const view = render(<Workspace />);
  fireEvent.click(screen.getByRole('button', {name:'initial'}));
  view.rerender(<Workspace storageKey="owner" />);
  expect(screen.getByRole('button', {name:'new choice'})).toBeInTheDocument();
  await waitFor(() => expect(JSON.parse(localStorage.getItem('owner:choice')!)).toBe('new choice'));
});
