import { useState } from "react";
import { feeAllocations } from "../../../../shared/brokerFees";
import { isGroupedInvoice } from "../../../../shared/groupedInvoiceGuard";
import { listAllPages } from "../../../../shared/pagination";
import { assertGraphqlErrors } from '../../lib/apiResponse';
import { readBrokerFeeStatus } from '../../lib/brokerFees';
import {
  client,
  type Invoice,
  type InvoiceLine
} from "../../lib/client";
import { brokerFeeLineFromSource, passThroughLinesFromSource, seededLineDescription, seededQuoteLineDescription, sourceChargeLineId } from "../../lib/invoiceSeed";
import { useAsyncResource } from "../../lib/useAsyncResource";

export function useInvoiceLines(invoice: Invoice) {

  const [legacyPolicyCharges, setLegacyPolicyCharges] = useState(false);
  const linesRes = useAsyncResource(
    async () => {
      setLegacyPolicyCharges(false);
      const loaded = await listAllPages((nextToken) =>
        client.models.InvoiceLine.list({
          filter: { invoiceId: { eq: invoice.id } },
          nextToken,
        })
      );
      if (isGroupedInvoice(invoice) || invoice.status !== "DRAFT" || invoice.stripePaymentLinkId || feeAllocations(invoice.brokerFeeAllocations).length || (!invoice.policyId && !invoice.quoteId)) return loaded;
      if (invoice.sourcePricingVersion === 2) {
        if (loaded.length) return loaded;
        const seeded = await client.models.InvoiceLine.create({
          id: `invoice:${invoice.id}:adjustment`, invoiceId: invoice.id,
          accountId: invoice.accountId, policyId: invoice.policyId, kind: "ENDORSEMENT", description: "Endorsement or audit adjustment",
          retailAmount: null, costAmount: null, sortOrder: 0
        });
        assertGraphqlErrors(seeded);
        if (!seeded.data) throw new Error(seeded.errors?.[0]?.message ?? "The adjustment line could not be refreshed. Retry this invoice.");
        return [seeded.data];
      }
      // Unflagged drafts may be older endorsement/audit bills. Their existing
      // amounts are their snapshot; current full-term charges must not rewrite it.
      if (invoice.sourcePricingVersion !== 1) return loaded;
      const sourceResult = invoice.policyId
        ? await client.models.Policy.get({ id: invoice.policyId })
        : await client.models.Quote.get({ id: invoice.quoteId! });
      assertGraphqlErrors(sourceResult);
      if (!sourceResult.data) throw new Error(sourceResult.errors?.[0]?.message ?? "The invoice source could not be refreshed.");
      setLegacyPolicyCharges(!!invoice.policyId && sourceResult.data.id === invoice.policyId && sourceResult.data.passThroughCharges == null);
      const expected = passThroughLinesFromSource(sourceResult.data, invoice.policyId ?? undefined);
      const expectedIds = new Set(expected.map(charge => charge.sourceQuoteChargeId));
      const next = [...loaded];
      if (invoice.sourcePricingVersion === 1 && sourceResult.data.billType !== "DIRECT") {
        const source = sourceResult.data;
        const premium = next.find(line => line.kind === "PREMIUM");
        const values = {
          kind: "PREMIUM" as const, retailAmount: source.premium ?? null,
          description: invoice.policyId ? seededLineDescription(source) : seededQuoteLineDescription(source)
        };
        if (!premium || premium.retailAmount !== values.retailAmount || premium.description !== values.description) {
          const result = premium
            ? await client.models.InvoiceLine.update({ id: premium.id, ...values })
            : await client.models.InvoiceLine.create({
              id: `invoice:${invoice.id}:premium`, invoiceId: invoice.id, accountId: invoice.accountId,
              ...(invoice.policyId ? { policyId: invoice.policyId } : {}), ...values, costAmount: null, sortOrder: 0
            });
          assertGraphqlErrors(result);
          if (!result.data) throw new Error(result.errors?.[0]?.message ?? "The source premium could not be refreshed. Retry this invoice before sending.");
          if (premium) next.splice(next.findIndex(line => line.id === premium.id), 1, result.data);
          else next.unshift(result.data);
        }
      }
      for (const line of loaded.filter(line => line.sourceQuoteChargeId && !expectedIds.has(line.sourceQuoteChargeId))) {
        const result = await client.models.InvoiceLine.delete({ id: line.id });
        assertGraphqlErrors(result);
        next.splice(next.findIndex(row => row.id === line.id), 1);
      }
      for (const charge of expected) {
        const previous = next.find(line => line.sourceQuoteChargeId === charge.sourceQuoteChargeId);
        if (previous && previous.kind === charge.kind && previous.description === charge.description && previous.retailAmount === charge.retailAmount && previous.costAmount === charge.costAmount) continue;
        const result = previous
          ? await client.models.InvoiceLine.update({ id: previous.id, ...charge })
          : await client.models.InvoiceLine.create({ id: sourceChargeLineId(invoice.id, charge.sourceQuoteChargeId), invoiceId: invoice.id, accountId: invoice.accountId, ...charge, sortOrder: next.length });
        assertGraphqlErrors(result);
        if (!result.data) throw new Error(result.errors?.[0]?.message ?? "Supplier charges could not be refreshed. Retry this invoice before sending.");
        if (previous) next.splice(next.findIndex(line => line.id === previous.id), 1, result.data);
        else next.push(result.data);
      }
      const expectedFee = brokerFeeLineFromSource(sourceResult.data, invoice.policyId ?? undefined);
      const priorFee = next.find(line => line.kind === "BROKER_FEE");
      if (!expectedFee && priorFee) {
        const removed = await client.models.InvoiceLine.delete({ id: priorFee.id });
        assertGraphqlErrors(removed);
        next.splice(next.findIndex(line => line.id === priorFee.id), 1);
      } else if (expectedFee && (priorFee ? priorFee.retailAmount !== expectedFee.retailAmount || priorFee.brokerFeeQuoteId !== expectedFee.brokerFeeQuoteId : true)) {
        let alreadyCollected = Number('brokerFeeCollected' in sourceResult.data ? sourceResult.data.brokerFeeCollected : 0) > 0;
        if (!priorFee && !alreadyCollected) {
          const fees = await readBrokerFeeStatus(invoice.accountId, [expectedFee.brokerFeeQuoteId]);
          alreadyCollected = fees.some(fee => fee.quoteId === expectedFee.brokerFeeQuoteId && fee.collectedCents > 0);
        }
        if (!alreadyCollected) {
          const saved = priorFee ? await client.models.InvoiceLine.update({ id: priorFee.id, ...expectedFee })
            : await client.models.InvoiceLine.create({ id: `invoice:${invoice.id}:broker-fee`, invoiceId: invoice.id, accountId: invoice.accountId, ...expectedFee, sortOrder: next.length });
          assertGraphqlErrors(saved);
          if (!saved.data) throw new Error(saved.errors?.[0]?.message ?? "The HOA broker fee could not be refreshed. Retry this invoice before sending.");
          if (priorFee) next.splice(next.findIndex(line => line.id === priorFee.id), 1, saved.data);
          else next.push(saved.data);
        }
      }
      return next;
    },
    [invoice.id],
    { initialData: [] as InvoiceLine[], errorMessage: "Failed to load invoice lines" }
  );
  return { linesRes, legacyPolicyCharges };
}
