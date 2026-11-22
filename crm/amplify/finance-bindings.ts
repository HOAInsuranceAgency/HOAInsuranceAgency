import type { backend as Backend } from './backend';

type FinanceFunction = 'pfServicing' | 'pfDefaultSweep'
  | 'sendInvoice' | 'stripeWebhook' | 'pfAutopay';
type FinanceBackend = Pick<typeof Backend, FinanceFunction | 'data'>;

// A model has one environment name throughout this feature. The generated
// tables stay in their existing stacks; this module only binds their consumers.
const environment = {
  PfComplianceLog: 'PF_COMPLIANCE_LOG_TABLE',
  PfLoan: 'PF_LOAN_TABLE', PfLoanPayment: 'PF_LOAN_PAYMENT_TABLE', PfNotice: 'PF_NOTICE_TABLE',
  Invoice: 'INVOICE_TABLE', Account: 'ACCOUNT_TABLE', Policy: 'POLICY_TABLE', Carrier: 'CARRIER_TABLE',
} as const satisfies Partial<Record<keyof FinanceBackend['data']['resources']['tables'], string>>;
type Model = keyof typeof environment;
type Access = 'read' | 'write' | 'readWrite';
type Binding = { target: FinanceFunction; tables: readonly (readonly [Model, Access])[] };

const bindings = {
  // Servicing posts deterministic payment/notice rows with conditional loan changes.
  servicing: { target: 'pfServicing', tables: [['PfComplianceLog', 'readWrite'], ['PfLoan', 'readWrite'], ['PfLoanPayment', 'readWrite'], ['PfNotice', 'readWrite']] },
  defaultSweep: { target: 'pfDefaultSweep', tables: [['PfComplianceLog', 'readWrite'], ['PfLoan', 'readWrite']] },
  // URL configuration remains between these groups to retain template bytes.
  invoicePublication: { target: 'sendInvoice', tables: [['Invoice', 'readWrite'], ['PfLoan', 'read']] },
  // Kept separate to retain the existing SES statement's placement between grants.
  webhookReporting: { target: 'stripeWebhook', tables: [['Account', 'read'], ['Policy', 'read'], ['Carrier', 'read']] },
  webhookSettlement: { target: 'stripeWebhook', tables: [['PfLoan', 'readWrite'], ['PfComplianceLog', 'write'], ['PfLoanPayment', 'readWrite']] },
  // Recovery can adopt a succeeded debit and post it through the existing ledger core.
  autopay: { target: 'pfAutopay', tables: [['PfLoan', 'readWrite'], ['PfComplianceLog', 'write'], ['PfLoanPayment', 'readWrite']] },
} as const satisfies Record<string, Binding>;

export type FinanceBindingGroup = keyof typeof bindings;

/** Feature-owned grants only: no new resources, roles, policies or caller-selected tables. */
export function bindPremiumFinanceTables(backend: FinanceBackend, group: FinanceBindingGroup) {
  const binding = bindings[group], fn = backend[binding.target];
  for (const [model, access] of binding.tables) {
    const table = backend.data.resources.tables[model];
    fn.addEnvironment(environment[model], table.tableName);
    if (access === 'read') table.grantReadData(fn.resources.lambda);
    else if (access === 'write') table.grantWriteData(fn.resources.lambda);
    else table.grantReadWriteData(fn.resources.lambda);
  }
}
