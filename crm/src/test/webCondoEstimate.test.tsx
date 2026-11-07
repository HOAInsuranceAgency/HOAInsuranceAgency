import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CondoEstimate from "../../../web/src/components/CondoEstimate";
import { attachAddressAutocomplete, type ChosenPlace } from "../../../web/src/lib/googlePlaces";

vi.mock("../../../web/src/lib/googlePlaces", () => ({
  loadGooglePlaces: vi.fn(async () => {}),
  attachAddressAutocomplete: vi.fn(),
}));

let choose: (place: ChosenPlace) => void;
const firstAddress: ChosenPlace = {
  address: "10 Atlantic Avenue", city: "Boston", state: "MA", zip: "02110",
  formatted: "10 Atlantic Avenue, Boston, MA 02110",
};

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(attachAddressAutocomplete).mockReset().mockImplementation((_input, onChoose) => {
    choose = onChoose;
    return () => {};
  });
});

async function openEstimate() {
  render(<CondoEstimate />);
  await waitFor(() => expect(attachAddressAutocomplete).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText(/^Association name/), { target: { value: "Harbor Condominium" } });
}

describe("condominium estimate address selection", () => {
  it("replaces every location field when a second suggestion is selected and keeps association details", async () => {
    await openEstimate();
    act(() => choose(firstAddress));
    expect(screen.getByLabelText("Street address")).toHaveValue("10 Atlantic Avenue");
    expect(screen.getByLabelText("City")).toHaveValue("Boston");
    expect(screen.getByLabelText("State")).toHaveValue("MA");
    expect(screen.getByLabelText(/^ZIP/)).toHaveValue("02110");

    act(() => choose({
      address: "20 Bay Street", city: "Tampa", state: "FL", zip: "33602",
      formatted: "20 Bay Street, Tampa, FL 33602",
    }));
    expect(screen.getByLabelText("Street address")).toHaveValue("20 Bay Street");
    expect(screen.getByLabelText("City")).toHaveValue("Tampa");
    expect(screen.getByLabelText("State")).toHaveValue("FL");
    expect(screen.getByLabelText(/^ZIP/)).toHaveValue("33602");
    expect(screen.getByLabelText(/^Association name/)).toHaveValue("Harbor Condominium");
  });

  it("clears missing components rather than keeping a previous address and asks for the required location", async () => {
    await openEstimate();
    act(() => choose(firstAddress));
    act(() => choose({ address: "", city: "", state: "", zip: "", formatted: "New Street, United States" }));

    expect(screen.getByLabelText("Street address")).toHaveValue("New Street, United States");
    expect(screen.getByLabelText("City")).toHaveValue("");
    expect(screen.getByLabelText("State")).toHaveValue("");
    expect(screen.getByLabelText(/^ZIP/)).toHaveValue("");
    expect(screen.getByLabelText(/^Association name/)).toHaveValue("Harbor Condominium");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "Where is the condominium?" })).toBeInTheDocument();
    expect(screen.getAllByText("Please complete this field.")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Portland" } });
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "ME" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("heading", { name: "About the building" })).toBeInTheDocument();
  });
});
