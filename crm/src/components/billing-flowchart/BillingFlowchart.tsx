import chartImage from "./client-billing-flowchart.png";
import printableChart from "./client-billing-flowchart.pdf?url";
import "./BillingFlowchart.css";

export function BillingFlowchart() {
  return (
    <details className="card billing-flowchart">
      <summary>Billing flowchart — HOA CRM or IPFS?</summary>
      <img src={chartImage} width="1400" height="1082" alt="" loading="lazy" />
      <div className="billing-flowchart-text">
        <dl>
          <dt>Paid in full → HOA CRM</dt>
          <dd>Invoice the full policy charges. Itemize any broker fee and collect the full invoice amount.</dd>
          <dt>Financed with no broker fee or a fee at or below the 30% cap → IPFS only</dt>
          <dd>IPFS collects the down payment and installments. The agency collects $0.</dd>
          <dt>Financed with a broker fee above the 30% cap → HOA CRM for the excess fee</dt>
          <dd>Invoice only the excess fee when the down payment is due. IPFS collects the regular down payment and all installments.</dd>
        </dl>
        <p>On $10,000 financed, the cap is $3,000. For a $3,500 broker fee, bill $500 in HOA CRM and finance $3,000 through IPFS.</p>
      </div>
      <a href={printableChart} target="_blank" rel="noopener noreferrer">Open printable flowchart (PDF)</a>
    </details>
  );
}
