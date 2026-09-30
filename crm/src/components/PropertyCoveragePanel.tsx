import BuildingsCard from "./property/BuildingsCard";
import BlanketsCard from "./property/BlanketsCard";
import GeneralLiabilityCard from "./property/GeneralLiabilityCard";
import DirectorsOfficersCard from "./property/DirectorsOfficersCard";

/** Underwriting schedules and applications retained through lead conversion. */
export default function PropertyCoveragePanel({ accountId }: { accountId: string }) {
  return (
    <>
      <BuildingsCard accountId={accountId} />
      <BlanketsCard accountId={accountId} />
      <GeneralLiabilityCard accountId={accountId} />
      <DirectorsOfficersCard accountId={accountId} />
    </>
  );
}
