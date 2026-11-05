import { useState } from 'react';
import {
  type CommissionOverview
} from '../../../../shared/commissions';
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { assertGraphqlErrors } from '../../lib/apiResponse';
import { client, fmtMoney } from "../../lib/client";
import { commissionAction } from '../../lib/commissions';
import { useAsyncResource } from '../../lib/useAsyncResource';
import { ActionForm, Field } from './CommissionForm';

export function LegacyPolicies({
  data,
  refresh,
}: {
  data: CommissionOverview;
  refresh: () => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const resource = useAsyncResource(
    async () => {
      if (!query) return { data: [], nextToken: null };
      const page = await client.models.Policy.list({
        filter: {
          and: [
            { commissionSnapshotId: { attributeExists: false } },
            { policyNumber: { contains: query } },
          ],
        },
        limit: 25,
        nextToken: cursor,
      });
      assertGraphqlErrors(page);
      return page;
    },
    [query, cursor],
    { clearDataOnError: () => true, live: { topics: ['CRM', 'OWNER', 'PERSONAL'] } },
  );
  const [premium, setPremium] = useState(''),
    [agencyRate, setAgencyRate] = useState(''),
    [effectiveDate, setEffectiveDate] = useState(''),
    [expirationDate, setExpirationDate] = useState('');
  const [policyId, setPolicy] = useState(''),
    [producerId, setProducer] = useState(''),
    [boundOn, setBound] = useState(''),
    [transaction, setTransaction] = useState<'NEW' | 'RENEWAL' | ''>(''),
    [evidence, setEvidence] = useState('');
  const options = resource.data?.data ?? [],
    selected = options.find((p) => p.id === policyId);
  const draft = { policyId, producerId, boundOn, transaction, evidence, premium, agencyRate, effectiveDate, expirationDate };
  return (
    <ActionForm
      title="Add an existing policy to commission tracking"
      draft={draft}
      onDone={async () => {
        setPolicy('');
        await refresh();
        await resource.refetch();
        return { savedDraft: { ...draft, policyId: '' } };
      }}
      submit={() =>
        commissionAction('adoptPolicy', {
          policyId,
          producerId,
          boundOn,
          transaction,
          evidence,
          premium,
          agencyRate,
          effectiveDate,
          expirationDate,
        })
      }
    >
      <p className="small muted">
        Use documented original ownership and agreement terms. Current account assignment is not
        evidence of historical commission ownership. Import receipts and prior payments separately
        so opening balances reconcile.
      </p>
      <label className="field">
        Find historical policy number
        <Input value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <Button variant="secondary"
        type="button"

        disabled={resource.loading || search.trim().length < 2}
        onClick={() => {
          setPolicy('');
          if (query === search.trim() && cursor === undefined) void resource.refetch();
          else {
            setCursor(undefined);
            setQuery(search.trim());
          }
        }}
      >
        Search historical policies
      </Button>
      {resource.error && <p role="alert">{resource.error}</p>}
      {resource.loading && <p>Loading matching policies…</p>}
      {query && !resource.loading && !resource.error && !options.length && (
        <p>
          No matching policies on this page.
          {resource.data?.nextToken ? ' Continue to the next page to search more records.' : ''}
        </p>
      )}
      {resource.data?.nextToken && (
        <Button variant="secondary"
          type="button"

          disabled={resource.loading}
          onClick={() => {
            setPolicy('');
            setCursor(resource.data?.nextToken ?? undefined);
          }}
        >
          Next policies
        </Button>
      )}
      <p className="small muted">
        Search by policy number (at least two characters). Results are paged; only policies without
        commission tracking are returned. Add a missing policy number in the policy editor first.
      </p>
      <label className="field">
        Existing policy
        <Select
          required
          value={policyId}
          onChange={(e) => {
            setPolicy(e.target.value);
            const selected = options.find((p) => p.id === e.target.value);
            setPremium(selected?.premium == null ? '' : String(selected.premium));
            setAgencyRate(selected?.commissionPct == null ? '' : String(selected.commissionPct));
            setEffectiveDate(selected?.effectiveDate ?? '');
            setExpirationDate(selected?.expirationDate ?? '');
            setBound(
              options.find((p) => p.id === e.target.value)?.datePolicyBound?.slice(0, 10) ?? '',
            );
          }}
        >
          <option value="">Choose…</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.policyNumber || p.id} · {p.effectiveDate}
            </option>
          ))}
        </Select>
      </label>
      {selected && (
        <p>
          Recorded premium {selected.premium == null ? 'Missing' : fmtMoney(selected.premium)} ·
          Agency rate {selected.commissionPct ?? 'Missing'}%
        </p>
      )}
      <div className="form-grid">
        <label className="field">
          Original producer
          <Select required value={producerId} onChange={(e) => setProducer(e.target.value)}>
            <option value="">Choose…</option>
            {data.plans.map((p) => (
              <option key={p.id} value={p.producerId}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <Field label="Original bind date" type="date" value={boundOn} change={setBound} />
        <label className="field">
          Original transaction
          <Select required value={transaction} onChange={(e) => { if (e.target.value === "NEW" || e.target.value === "RENEWAL" || e.target.value === "") setTransaction(e.target.value); }}>
            <option value="">Choose…</option>
            <option value="NEW">New business</option>
            <option value="RENEWAL">Renewal</option>
          </Select>
        </label>
      </div>
      <div className="form-grid">
        <Field label="Confirmed policy premium ($)" value={premium} change={setPremium} />
        <Field label="Confirmed agency commission (%)" value={agencyRate} change={setAgencyRate} />
        <Field
          label="Confirmed effective date"
          type="date"
          value={effectiveDate}
          change={setEffectiveDate}
        />
        <Field
          label="Confirmed expiration date"
          type="date"
          value={expirationDate}
          change={setExpirationDate}
        />
      </div>
      <Field
        label="Historical attribution and policy evidence"
        value={evidence}
        change={setEvidence}
      />
    </ActionForm>
  );
}
