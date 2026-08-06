import { type Account } from "../lib/client";
import DetailsCard from "./property/DetailsCard";
import BuildingsCard from "./property/BuildingsCard";
import BlanketsCard from "./property/BlanketsCard";
import GeneralLiabilityCard from "./property/GeneralLiabilityCard";
import DirectorsOfficersCard from "./property/DirectorsOfficersCard";
import PhotosCard from "./property/PhotosCard";

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
      <DetailsCard account={account} onChange={onChange} />
      <BuildingsCard accountId={account.id} />
      <BlanketsCard accountId={account.id} />
      <GeneralLiabilityCard accountId={account.id} />
      <DirectorsOfficersCard accountId={account.id} />
      <PhotosCard account={account} onChange={onChange} />
    </>
  );
}
