import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({
  GlApplication: { get: vi.fn(), create: vi.fn(), update: vi.fn() },
  GlClassCode: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock("aws-amplify/data", () => ({ generateClient: () => ({ models }) }));
import GeneralLiabilityCard from "./GeneralLiabilityCard";

beforeEach(() => {
  vi.resetAllMocks();
  models.GlApplication.get.mockResolvedValue({ data: null });
  models.GlApplication.create.mockImplementation(async fields => ({ data: fields }));
  models.GlClassCode.list.mockResolvedValue({ data: [], nextToken: null });
});

it("labels application controls and saves formatted values while retaining unanswered radio semantics", async () => {
  const user = userEvent.setup();
  render(<GeneralLiabilityCard accountId="a1" />);
  const amount = await screen.findByLabelText("Each occurrence ($)");
  for (const label of ["General aggregate ($)", "General aggregate applies per", "Products / completed ops ($)", "Personal & advertising injury ($)", "Damage to rented premises ($)", "Medical expense ($)", "Applies", "Property damage ($)", "Bodily injury ($)", "Paid to sub-contractors ($)", "Work sub-contracted", "Full-time employees", "Part-time employees", "Description of work sub-contracted"]) {
    expect(screen.getByLabelText(label)).toHaveAccessibleName(label);
  }
  await user.type(amount, "1000000");
  expect(screen.getByLabelText("Each occurrence ($)")).toBe(amount);
  await user.click(screen.getByRole("button", { name: "Save general liability" }));
  expect(models.GlApplication.create).toHaveBeenCalledWith(expect.objectContaining({
    accountId: "a1", eachOccurrence: 1000000, usesSubcontractors: null, subsCarryLowerLimits: null, subsAllowedWithoutCoi: null,
  }));
  expect(amount).toHaveValue("1,000,000");
});

it("keeps distinct add/edit labels and the existing Enter-to-add class-code behavior", async () => {
  const user = userEvent.setup();
  const code = { id: "c1", accountId: "a1", classCode: "62003", exposure: 24 };
  models.GlClassCode.create.mockResolvedValue({ data: code });
  render(<GeneralLiabilityCard accountId="a1" />);
  const addCode = await screen.findByLabelText("Class code");
  await user.type(addCode, "62003{Enter}");
  expect(models.GlClassCode.create).toHaveBeenCalledWith(expect.objectContaining({ accountId: "a1", classCode: "62003" }));
  await screen.findByText("62003 added.");
  await user.click(screen.getByRole("button", { name: "Edit" }));
  const dialog = within(screen.getByRole("dialog"));
  const editCode = dialog.getByLabelText("Class code");
  expect(editCode.id).not.toBe(addCode.id);
  for (const label of ["Class code", "Hazard #", "Premium basis", "Exposure", "Description"]) {
    expect(dialog.getByLabelText(label)).toHaveAccessibleName(label);
  }
  await user.click(dialog.getByText("Class code", { selector: "label" }));
  expect(editCode).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(models.GlClassCode.update).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Class code")).toBe(addCode);
});
