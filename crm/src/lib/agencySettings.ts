import { client, type AgencySettings } from "./client";

/**
 * The agency's NPNs — read by the sidebar, written by Settings → Agency.
 *
 * One record, one id. Everything here exists so the two call sites cannot
 * disagree about which row that is or how it comes into being.
 */

/**
 * The singleton's primary key.
 *
 * A constant rather than "the first row of a list": a `list()` gives no
 * guarantee about order, so two rows would make which NPN you see depend on
 * DynamoDB's mood. With a fixed id a read is a `get` and there is exactly one
 * row it can return.
 */
export const AGENCY_SETTINGS_ID = "AGENCY";

/** Just the editable fields, which is all either call site cares about. */
export interface AgencyNpns {
  agencyNpn: string;
  drlpNpn: string;
}

export const EMPTY_NPNS: AgencyNpns = { agencyNpn: "", drlpNpn: "" };

/**
 * The stored NPNs, or empty strings.
 *
 * A missing row is the normal state of a fresh backend, not an error, so it
 * reads the same as a row with both fields blank — the sidebar shows nothing
 * either way and the form opens empty. Returns `null` only when the read
 * itself failed, which is a different thing and the caller may want to say so.
 */
export async function loadAgencyNpns(): Promise<AgencyNpns | null> {
  const { data, errors } = await client.models.AgencySettings.get({
    id: AGENCY_SETTINGS_ID,
  });
  if (errors?.length) return null;
  return {
    agencyNpn: data?.agencyNpn ?? "",
    drlpNpn: data?.drlpNpn ?? "",
  };
}

/**
 * Write both NPNs, creating the row if this is the first time.
 *
 * `update` on a row that does not exist does not create it, and the first
 * admin to open this form is editing a backend that has never had one — so the
 * create path is the common one exactly once and the update path forever
 * after. Throws on failure: Amplify's `{ data, errors }` does not, and a
 * silently dropped error here would leave the form saying "Saved."
 */
export async function saveAgencyNpns(
  npns: AgencyNpns,
  updatedBy: string
): Promise<AgencySettings> {
  const fields = {
    // Trimmed, and empty means empty rather than " " — these get copied
    // straight into carrier portals.
    agencyNpn: npns.agencyNpn.trim() || null,
    drlpNpn: npns.drlpNpn.trim() || null,
    updatedBy,
  };

  const existing = await client.models.AgencySettings.get({
    id: AGENCY_SETTINGS_ID,
  });

  const { data, errors } = existing.data
    ? await client.models.AgencySettings.update({
        id: AGENCY_SETTINGS_ID,
        ...fields,
      })
    : await client.models.AgencySettings.create({
        id: AGENCY_SETTINGS_ID,
        ...fields,
      });

  if (errors?.length || !data) {
    throw new Error(errors?.[0]?.message ?? "Couldn't save the agency NPNs.");
  }
  return data;
}
