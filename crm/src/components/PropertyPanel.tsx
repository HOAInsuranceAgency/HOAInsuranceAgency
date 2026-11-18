import { type Account } from "../lib/client";
import { AccountEditBoundary } from './AccountPermissions';
import DetailsCard from "./property/DetailsCard";
import PhotosCard from "./property/PhotosCard";

/** General property information and site photos shown on Overview. */
export default function PropertyPanel({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  return (
    <>
      <AccountEditBoundary><DetailsCard account={account} onChange={onChange} /></AccountEditBoundary>
      <PhotosCard account={account} onChange={onChange} />
    </>
  );
}
