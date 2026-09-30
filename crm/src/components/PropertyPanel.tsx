import { type Account } from "../lib/client";
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
      <DetailsCard account={account} onChange={onChange} />
      <PhotosCard account={account} onChange={onChange} />
    </>
  );
}
