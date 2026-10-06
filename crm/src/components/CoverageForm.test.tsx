import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models: { Policy: { list: async () => ({ data: [] }) }, Quote: { create: h.create } } }) }));
import CoverageForm from "./CoverageForm";
beforeEach(() => { h.create.mockReset(); });

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
