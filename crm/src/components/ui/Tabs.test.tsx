import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Tabs, TabPanel } from './Tabs';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Panels() {
  const [value, setValue] = useState('first');
  return <><Tabs id="example" label="Example views" value={value} onChange={setValue} items={[
    { value: 'first', label: 'First' }, { value: 'disabled', label: 'Unavailable', disabled: true }, { value: 'last', label: 'Last' },
  ]} /><TabPanel tabsId="example" value={value}>{value} content</TabPanel></>;
}

it('connects the selected tab to the mounted panel and uses one keyboard stop', async () => {
  const user = userEvent.setup();
  render(<Panels />);
  const first = screen.getByRole('tab', { name: 'First' }), last = screen.getByRole('tab', { name: 'Last' });
  expect(screen.getByRole('tablist', { name: 'Example views' })).toBeInTheDocument();
  expect(first).toHaveAttribute('aria-selected', 'true');
  expect(first).toHaveAttribute('tabindex', '0');
  expect(last).toHaveAttribute('tabindex', '-1');
  expect(first.getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel').id);
  expect(screen.getByRole('tabpanel')).toHaveAccessibleName('First');
  await user.tab();
  expect(first).toHaveFocus();
  await user.keyboard('{ArrowRight}');
  expect(last).toHaveFocus();
  expect(last).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Last');
  await user.keyboard('{ArrowRight}');
  expect(first).toHaveFocus();
  await user.keyboard('{End}');
  expect(last).toHaveFocus();
  await user.keyboard('{Home}');
  expect(first).toHaveFocus();
  await user.keyboard('{ArrowLeft}');
  expect(last).toHaveFocus();
});

it('does not submit its containing form or activate disabled tabs', () => {
  const submit = vi.fn(event => event.preventDefault());
  render(<form onSubmit={submit}><Panels /></form>);
  fireEvent.click(screen.getByRole('tab', { name: 'Unavailable' }));
  expect(screen.getByRole('tabpanel')).toHaveAccessibleName('First');
  fireEvent.click(screen.getByRole('tab', { name: 'Last' }));
  expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Last');
  expect(submit).not.toHaveBeenCalled();
});

const bounds = (left: number, right: number) => ({ left, right, top: 0, bottom: 40, width: right - left, height: 40, x: left, y: 0, toJSON: () => ({}) });

it('reveals an initially selected offscreen tab by scrolling only its strip', () => {
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(120);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.getAttribute('role') === 'tab' ? bounds(240, 320) : bounds(20, 140);
  });
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  const scrollDocument = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  render(<Tabs id="linked" label="Linked views" value="last" onChange={() => {}} items={[{ value: 'last', label: 'Last' }]} />);
  expect(screen.getByRole('tablist')).toHaveProperty('scrollLeft', 180);
  expect(focus).not.toHaveBeenCalled();
  expect(scrollDocument).not.toHaveBeenCalled();
});

it('reveals changed selections and resized strips without moving existing focus', () => {
  let width = 300, resized!: () => void;
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.id === 'resizing-tab-last' ? bounds(240, 320) : bounds(20, 100);
  });
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const items = [{ value: 'first', label: 'First' }, { value: 'last', label: 'Last' }];
  const { rerender, unmount } = render(<><button>Keep focus</button><Tabs id="resizing" label="Resizing views" value="first" onChange={() => {}} items={items} /></>);
  const existing = screen.getByRole('button', { name: 'Keep focus' });
  existing.focus();
  rerender(<><button>Keep focus</button><Tabs id="resizing" label="Resizing views" value="last" onChange={() => {}} items={items} /></>);
  expect(screen.getByRole('tablist')).toHaveProperty('scrollLeft', 0);
  width = 120;
  act(() => resized());
  expect(screen.getByRole('tablist')).toHaveProperty('scrollLeft', 180);
  expect(existing).toHaveFocus();
  unmount();
  expect(disconnect).toHaveBeenCalledTimes(2);
});
