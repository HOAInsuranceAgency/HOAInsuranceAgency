/**
 * California trade name, for the public website only.
 *
 * In California, HOA Insurance Agency LLC is licensed to do business as
 * "Condo Insurance Agency". The website shows that in two ways:
 *
 * 1. Every page carries one disclosure line in the footer (CALIFORNIA_DBA_LINE).
 * 2. California pages (the state page and any California city page) present
 *    the business as Condo Insurance Agency (isCalifornia + CALIFORNIA_DBA).
 *
 * The CRM, ACORD forms and client emails are deliberately NOT driven from
 * here; they read shared/agency.ts. Changing them is a separate decision.
 */
import { AGENCY } from "../../../shared/agency";

export const CALIFORNIA_DBA = {
  /** Trade name exactly as it appears on the California license. */
  name: "Condo Insurance Agency",
  /**
   * California Department of Insurance license number. Leave empty until
   * confirmed; the disclosure lines leave the number out while it is empty.
   */
  licenseNumber: "",
} as const;

/** "CA License #1234567", or "" until the number is filled in above. */
export const CALIFORNIA_LICENSE = CALIFORNIA_DBA.licenseNumber
  ? `CA License #${CALIFORNIA_DBA.licenseNumber}`
  : "";

/** Site-wide footer disclosure. */
export const CALIFORNIA_DBA_LINE =
  `In California, ${AGENCY.name} does business as ${CALIFORNIA_DBA.name}` +
  `${CALIFORNIA_LICENSE ? `, ${CALIFORNIA_LICENSE}` : ""}.`;

/** Disclosure shown on California pages, naming the licensed entity. */
export const CALIFORNIA_PAGE_LINE =
  `${CALIFORNIA_DBA.name} is the California trade name of ${AGENCY.name}` +
  `${CALIFORNIA_LICENSE ? ` (${CALIFORNIA_LICENSE})` : ""}.`;

/** True for a California state code or slug ("CA", "ca", "california"). */
export function isCalifornia(stateAbbrOrSlug: string): boolean {
  const v = stateAbbrOrSlug.toLowerCase();
  return v === "ca" || v === "california";
}
