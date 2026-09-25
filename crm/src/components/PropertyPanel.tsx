import { type Account } from "../lib/client";
import DetailsCard from "./property/DetailsCard";
import BuildingsCard from "./property/BuildingsCard";
import BlanketsCard from "./property/BlanketsCard";
import GeneralLiabilityCard from "./property/GeneralLiabilityCard";
import DirectorsOfficersCard from "./property/DirectorsOfficersCard";
import PhotosCard from "./property/PhotosCard";
import { Disclosure } from "./ui/kit";

/** Underwriting property details: construction, system updates, buildings,
 * the blanket schedule, the GL and D&O applications, and site photos. Feeds
 * the ACORD 125/126/140 autofill. */
export default function PropertyPanel({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  return (
    <>
      <Disclosure title="Property details" description={[account.address, account.city, account.state].filter(Boolean).join(", ") || "Address and construction details"}><DetailsCard account={account} onChange={onChange} /></Disclosure>
      <Disclosure title="Buildings" description="Building schedule, construction, and replacement values"><BuildingsCard accountId={account.id} /></Disclosure>
      <Disclosure title="Blanket coverages" description="Limits shared across buildings"><BlanketsCard accountId={account.id} /></Disclosure>
      <Disclosure title="General liability" description="Limits, operations, deductibles, and class codes"><GeneralLiabilityCard accountId={account.id} /></Disclosure>
      <Disclosure title="Directors & officers" description="Application details and coverage parts"><DirectorsOfficersCard accountId={account.id} /></Disclosure>
      <Disclosure title="Site photos & plans"><PhotosCard account={account} onChange={onChange} /></Disclosure>
    </>
  );
}
