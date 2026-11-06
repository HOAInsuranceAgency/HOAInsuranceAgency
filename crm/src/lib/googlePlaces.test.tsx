import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Field } from "../components/ui/Field";

let AddressAutocomplete: typeof import("./googlePlaces").AddressAutocomplete;
const initialized = vi.fn(), getPlace = vi.fn();
let placeChanged: () => void;
beforeAll(async () => {
  vi.stubEnv("VITE_GOOGLE_PLACES_KEY", "fictional-local-provider");
  ({ AddressAutocomplete } = await import("./googlePlaces"));
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("google", { maps: { places: { Autocomplete: class {
    constructor(input: HTMLInputElement, options: unknown) { initialized(input, options); }
    addListener(name: string, callback: () => void) { expect(name).toBe("place_changed"); placeChanged = callback; }
    getPlace = getPlace;
  } } } });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => vi.unstubAllEnvs());

it("connects the actual address input to its label, help and error without loading an external script", async () => {
  const onChange = vi.fn(), onPlace = vi.fn();
  render(<Field label="Street address" id="property-address" help="Use the property location." error="Review this address.">
    {control => <AddressAutocomplete {...control} value="" onChange={onChange} onPlace={onPlace} />}
  </Field>);
  const input = screen.getByRole("textbox", { name: "Street address" });
  expect(input).toHaveAttribute("id", "property-address");
  expect(input).toHaveAccessibleDescription("Use the property location. Review this address.");
  expect(input).toHaveAttribute("aria-invalid", "true");
  fireEvent.change(input, { target: { value: "100 Example St" } });
  expect(onChange).toHaveBeenCalledExactlyOnceWith("100 Example St");
  await waitFor(() => expect(initialized).toHaveBeenCalledOnce());
  expect(initialized.mock.calls[0][0]).toBe(input);
  expect(document.querySelector('script[src*="maps.googleapis.com"]')).toBeNull();
  expect(onPlace).not.toHaveBeenCalled();
});

it("keeps the native input and provider instance while applying a selection to the latest callback", async () => {
  const first = vi.fn(), latest = vi.fn();
  const view = render(<AddressAutocomplete id="address" aria-label="Property address" aria-describedby="external-help" value="typed" onChange={vi.fn()} onPlace={first} />);
  const input = screen.getByRole("textbox", { name: "Property address" });
  await waitFor(() => expect(initialized).toHaveBeenCalledOnce());
  view.rerender(<AddressAutocomplete id="address" aria-label="Property address" aria-describedby="external-help" value="still typed" onChange={vi.fn()} onPlace={latest} />);
  expect(screen.getByRole("textbox", { name: "Property address" })).toBe(input);
  expect(input).toHaveAttribute("aria-describedby", "external-help");
  getPlace.mockReturnValue({ address_components: [
    { types: ["street_number"], long_name: "100" }, { types: ["route"], long_name: "Example St" },
    { types: ["locality"], long_name: "Boston" }, { types: ["administrative_area_level_1"], short_name: "ma" },
    { types: ["postal_code"], long_name: "02110" },
  ] });
  await act(async () => placeChanged());
  expect(latest).toHaveBeenCalledExactlyOnceWith({ address: "100 Example St", city: "Boston", state: "MA", zip: "02110" });
  expect(first).not.toHaveBeenCalled();
  expect(initialized).toHaveBeenCalledOnce();
});
