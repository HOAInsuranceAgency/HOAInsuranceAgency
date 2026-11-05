import { useState } from 'react';
import {
  type CommissionOverview
} from '../../../../shared/commissions';
import { listAllPages } from "../../../../shared/pagination";
import { Select } from "../../components/ui/Select";
import { client } from "../../lib/client";
import { communicationRequest } from '../../lib/communications';
import { useAsyncResource } from '../../lib/useAsyncResource';
import { AccountClassifications } from './AccountClassifications';
import { CarrierEditor } from './CarrierTermsEditor';
import { LegacyPolicies } from './LegacyPolicyImport';
import { PlanEditor } from './ProducerAgreementEditor';

export function Settings({ data, refresh }: { data: CommissionOverview; refresh: () => Promise<void> }) {
  const references = useAsyncResource(
    async () => {
      const [team, carriers] = await Promise.all([
        communicationRequest('team', {}),
        listAllPages((nextToken) => client.models.Carrier.list({ nextToken })),
      ]);
      return { team: team.team, carriers };
    },
    [],
    { clearDataOnError: () => true, live: { topics: ['CRM', 'OWNER', 'PERSONAL'] } },
  );
  const [producer, setProducer] = useState(''),
    [carrier, setCarrier] = useState('');
  if (!references.data)
    return (
      <p role={references.error ? 'alert' : undefined}>
        {references.error || 'Loading teammates and carriers…'}
      </p>
    );
  return (
    <>
      <p>
        Rates are set for each producer. New business uses the bind date; renewals use the term
        effective date. Saved policy snapshots keep their original rates when agreements change.
      </p>
      <label className="field">
        Producer
        <Select value={producer} onChange={(e) => setProducer(e.target.value)}>
          <option value="">Choose a producer…</option>
          {references.data.team.map((t) => (
            <option key={t.userId} value={t.userId}>
              {t.name}
            </option>
          ))}
        </Select>
      </label>
      {producer && (
        <PlanEditor
          key={`${producer}:${data.plans.find((p) => p.id === producer)?.version ?? 0}`}
          producerId={producer}
          name={references.data.team.find((t) => t.userId === producer)?.name ?? producer}
          plan={data.plans.find((p) => p.id === producer)}
          refresh={refresh}
        />
      )}
      <label className="field">
        Carrier
        <Select value={carrier} onChange={(e) => setCarrier(e.target.value)}>
          <option value="">Choose a carrier…</option>
          {references.data.carriers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </label>
      {carrier && (
        <CarrierEditor
          key={`${carrier}:${data.carriers.find((c) => c.id === carrier)?.version ?? 0}`}
          id={carrier}
          terms={data.carriers.find((c) => c.id === carrier)}
          refresh={refresh}
        />
      )}
      <AccountClassifications />
      <LegacyPolicies data={data} refresh={refresh} />
    </>
  );
}
