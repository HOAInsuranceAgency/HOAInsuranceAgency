import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { appendEntry, required } from '../../../shared/commissions';
import { buildPayrollApproval, cyclePayrollRows, defaultPayrollSettings, payrollBlockers, payrollPreview, payrollRowKey, validatePayrollCycle } from '../../../shared/commissionPayroll';
import type { CommissionEarning } from '../../../shared/commissionExceptions';
import { commissionPolicy, line, statement } from './commissionFixtures';
import { commissionReportFiles, reportReference } from '../../amplify/functions/commissions/reports';

const policy = () => appendEntry(commissionPolicy(), line({agencyCents:100000}), statement(), 'receipt');
const extra = (id='extra'): CommissionEarning => ({
  id,version:1,policyId:'p',policyNumber:'POL-1',accountName:'Cedar HOA',producerId:'producer',producerName:'Avery',
  transaction:'NEW',entryId:'adjustment:'+id,receivedOn:'2026-10-02',agencyCents:0,producerBps:1600,amountCents:5000,
  source:'ADJUSTMENT',status:'PAYABLE',
});
const offCycle = () => validatePayrollCycle({
  id:'2026-10-OFF-12345678',version:0,revision:1,cutoff:'2026-10-23',reviewOn:'2026-10-24',
  hrDueOn:'2026-10-26',processingOn:'2026-10-26',payDate:'2026-10-30',status:'OPEN',batchIds:[],totalCents:0,
  producerIds:['producer'],reason:'TEST selected adjustment',selectedEarningKeys:[payrollRowKey({earningId:'extra',policyId:'p',entryId:'adjustment:extra'})],
});
describe('selected off-cycle earnings',()=>{
  it('reserves only the selected $50 once and leaves the regular receipt for monthly payroll',()=>{
    const p=policy(),e=extra(),c=offCycle();
    expect(cyclePayrollRows(c,[p],[e]).map(r=>r.amountCents)).toEqual([5000]);
    const approval=buildPayrollApproval(c,[p],[],defaultPayrollSettings(),'owner','2026-10-24T12:00:00Z',[e]);
    expect(approval.cycle.totalCents).toBe(5000);
    expect(approval.policies).toEqual([]);
    expect(approval.batches[0].lines).toHaveLength(1);
    expect(payrollPreview([p],'2026-10-23',undefined,approval.earnings).map(r=>r.amountCents)).toEqual([16000]);
    expect(payrollBlockers(c,[p],[],approval.earnings).join(' ')).toMatch(/no longer eligible/);
  });
  it('rejects stale, excluded, wrong-employee, and after-cutoff selections instead of silently omitting them',()=>{
    for(const e of [{...extra(),status:'EXCLUDED' as const},{...extra(),producerId:'another'},{...extra(),receivedOn:'2026-10-24'}]) {
      expect(payrollBlockers(offCycle(),[policy()],[],[e]).join(' ')).toMatch(/no longer eligible/);
      expect(()=>buildPayrollApproval(offCycle(),[policy()],[],defaultPayrollSettings(),'owner','2026-10-24T12:00:00Z',[e])).toThrow(/no longer eligible/);
    }
  });
  it('preserves all-earnings legacy cycles but rejects empty and monthly selections',()=>{
    const c=offCycle();delete c.selectedEarningKeys;
    expect(cyclePayrollRows(c,[policy()],[extra()])).toHaveLength(2);
    expect(()=>validatePayrollCycle({...offCycle(),selectedEarningKeys:[]})).toThrow(/Choose/);
    expect(()=>validatePayrollCycle({...offCycle(),id:'2026-10'})).toThrow(/off-cycle/);
  });
  it('keeps a draft blocker and removes only a voided draft from payroll review',()=>{
    expect(payrollBlockers(offCycle(),[policy()],[statement()],[extra()]).join(' ')).toMatch(/Reconcile draft/);
    expect(payrollBlockers(offCycle(),[policy()],[{...statement(),status:'VOID',voidReason:'Duplicate'}],[extra()])).toEqual([]);
  });
});
it('accepts detailed review notes and explains an overlong value',()=>{
  expect(()=>appendEntry(commissionPolicy(),line({eligibilityNote:'Evidence '.repeat(100)}),statement(),'r')).not.toThrow();
  expect(()=>required('x'.repeat(2001),'review notes',2000)).toThrow('Use 2000 characters or fewer for review notes.');
});
it('retains readable receipt references in compact reports',()=>{
  expect(reportReference('a'.repeat(64)+':TEST-CARRIER-1')).toBe('TEST-CARRIER-1');
  expect(reportReference('receipt-74')).toBe('receipt-74');
});
it('generates compact approved PDFs with an explicit test watermark and unchanged totals',async()=>{
  const approval=buildPayrollApproval(offCycle(),[policy()],[],defaultPayrollSettings(),'owner','2026-10-24T12:00:00Z',[extra()]);
  const files=await commissionReportFiles(approval.cycle,approval.batches,undefined,{isTest:true});
  expect(files).toHaveLength(2);
  for(const f of files){
    const pdf=await PDFDocument.load(f.content);
    expect(pdf.getSubject()).toMatch(/TEST DATA/);
    expect(pdf.getPageCount()).toBe(1);
  }
  expect(approval.cycle.totalCents).toBe(5000);
});
