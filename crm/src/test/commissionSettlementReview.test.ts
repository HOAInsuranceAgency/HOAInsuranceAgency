// @vitest-environment node
import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({send:vi.fn(),items:new Map<string,any>(),transactions:[] as any[]}));
vi.mock('@aws-sdk/lib-dynamodb',async original=>({...await original<typeof import('@aws-sdk/lib-dynamodb')>(),DynamoDBDocumentClient:{from:()=>({send:h.send})}}));
import {saveReviewRecords,readReviewCalculations,type Calculation} from '../../amplify/functions/commissions/settlement-review';
import {commit} from '../../amplify/functions/commissions/store';
beforeEach(()=>{
 h.items.clear();h.transactions=[];h.send.mockReset();vi.stubEnv('COMMISSION_TABLE','private');
 h.send.mockImplementation(async command=>{
  const input=command.input;
  if(command.constructor.name==='GetCommand')return{Item:structuredClone(h.items.get(input.Key.kind+':'+input.Key.id))};
  if(command.constructor.name==='BatchGetCommand')return{Responses:{private:input.RequestItems.private.Keys.map((k:any)=>structuredClone(h.items.get(k.kind+':'+k.id))).filter(Boolean)}};
  h.transactions.push(input.TransactItems);
  for(const w of input.TransactItems){if(w.Put)h.items.set(w.Put.Item.kind+':'+w.Put.Item.id,structuredClone(w.Put.Item));if(w.Delete)h.items.delete(w.Delete.Key.kind+':'+w.Delete.Key.id);}
  return{};
 });
});
const rows=()=>Array.from({length:400},(_,i)=>({rowId:'row-'+i,calculations:Array.from({length:3},(_,j)=>({policyId:'policy-'+i,lineRef:'transaction-'+i+'x'.repeat(100),producerId:'employee-'+j,producerName:'Employee '+j+'x'.repeat(100),agencyCents:10000,producerBps:1600,shareBps:j===2?3334:3333,amountCents:533,reviewOnly:false} as Calculation))}));
it('keeps a 400-row three-employee approval and its audits inside the unchanged production write envelope',async()=>{
 const source=rows();expect(Buffer.byteLength(JSON.stringify(source))).toBeGreaterThan(300000);
 const refs=await saveReviewRecords('token',source,'owner');expect(refs.length).toBeGreaterThan(1);
 const review={token:'token',records:refs,policyVersions:Object.fromEntries(source.map((_,i)=>['policy-'+i,1])),approvedAt:'2026-11-19',approvedBy:'owner'};
 await commit([{kind:'INTAKE_SETTLEMENT',value:{id:'s',intakeId:'inbox',reference:'bank',status:'POSTING',allocations:source.map(r=>({rowId:r.rowId,amountCents:10000})),postedRows:[],statementIds:[],review}}],'owner');
 for(const transaction of h.transactions){expect(transaction.length).toBeLessThanOrEqual(100);for(const w of transaction)if(w.Put)expect(Buffer.byteLength(JSON.stringify(w.Put.Item))).toBeLessThan(300000);}
 h.send.mockClear();
 const selected=await readReviewCalculations(review,source.slice(0,5).map(r=>r.rowId));expect(selected.size).toBe(5);
 const queried=h.send.mock.calls[0][0].input.RequestItems.private.Keys;expect(queried.length).toBeLessThan(refs.length);
 const count=h.transactions.length;expect(await saveReviewRecords('token',source,'owner')).toEqual(refs);expect(h.transactions).toHaveLength(count);
});
it('fails closed for a missing or changed immutable calculation snapshot',async()=>{
 const refs=await saveReviewRecords('t',rows().slice(0,1),'owner');const review={token:'t',records:refs,policyVersions:{},approvedAt:'today',approvedBy:'owner'};
 const snapshot=h.items.get('INTAKE_REVIEW:'+refs[0].id);snapshot.rows[0].calculations[0].amountCents++;
 await expect(readReviewCalculations(review,['row-0'])).rejects.toThrow(/incomplete or changed/);
 h.items.delete('INTAKE_REVIEW:'+refs[0].id);await expect(readReviewCalculations(review,['row-0'])).rejects.toThrow(/incomplete or changed/);
});
