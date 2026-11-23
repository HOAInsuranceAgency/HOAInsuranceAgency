import chartImage from "./client-billing-flowchart.png";
import printableChart from "./client-billing-flowchart.pdf?url";
import "./BillingFlowchart.css";

export function BillingFlowchart() {
  return (
    <details className="card billing-flowchart">
      <summary>Billing flowchart — carrier, HOA CRM or IPFS?</summary>
      <img src={chartImage} width="1400" height="1082" alt="" loading="lazy" />
      <div className="billing-flowchart-text">
        <h3>Who bills the client?</h3>
        <dl>
          <dt>No broker fee and no IPFS request → use carrier direct bill when available</dt>
          <dd>The client pays the carrier in full or on the carrier’s installment plan. HOA collects $0. Skip the HOA CRM invoice.</dd>
          <dt>Broker fee, IPFS request or agency bill only → use agency billing</dt>
          <dd>Select agency bill when the carrier offers it. If the carrier offers only direct bill, set the billing address on the carrier’s bill to HOA Insurance Agency. On the quote, set Client pays to HOA CRM or IPFS.</dd>
        </dl>
        <h3>For agency billing, which platform collects payment?</h3>
        <dl>
          <dt>Paid in full → HOA CRM</dt>
          <dd>Invoice the full policy charges and itemize any broker fee. HOA collects the invoice amount and pays the amount due to the carrier.</dd>
          <dt>IPFS with no broker fee or a fee at or below the cap → IPFS only</dt>
          <dd>IPFS collects the down payment and installments. HOA collects $0 from the client.</dd>
          <dt>IPFS with a broker fee above the cap → IPFS only</dt>
          <dd>Enter the full broker fee on the IPFS quote. Include the excess in the IPFS down payment and finance only the eligible portion. IPFS collects the down payment and installments. HOA collects $0. Skip the separate HOA CRM invoice.</dd>
        </dl>
        <p>The cap is 30% of the IPFS amount financed. On $10,000 financed, the cap is $3,000. For a $3,500 broker fee, IPFS finances $3,000 and collects the remaining $500 with the regular down payment.</p>
      </div>
      <a href={printableChart} target="_blank" rel="noopener noreferrer">Open printable flowchart (PDF)</a>
    </details>
  );
}
