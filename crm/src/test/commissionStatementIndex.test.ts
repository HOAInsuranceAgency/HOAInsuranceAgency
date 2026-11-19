// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { backfillStatementIndexes } from '../../amplify/functions/commissions/statement-backfill';
import { statementIndexWrites, STATEMENT_INDEX_STATE } from '../../amplify/functions/commissions/statement-index';
const records=new Map<string, any>();
let queries=0, writes=0, conflict=false, interrupt=false;
const db={send:vi.fn(async (command:any):Promise<any>=>{
 const q=command.input;
 if(command.constructor.name==='GetCommand')return {Item:structuredClone(records.get(q.Key.kind+':'+q.Key.id))};
 if(command.constructor.name==='QueryCommand'){
  queries++;const kind=q.ExpressionAttributeValues[':kind'];const all=[...records.values()].filter(r=>r.kind===kind).sort((a,b)=>a.id.localeCompare(b.id));
  const start=q.ExclusiveStartKey?all.findIndex(r=>r.id===q.ExclusiveStartKey.id)+1:0, items=all.slice(start,start+q.Limit);
  return {Items:structuredClone(items),...(start+items.length<all.length?{LastEvaluatedKey:{kind,id:items.at(-1).id}}:{})};
 }
 writes++;
 if(interrupt)throw new Error('Interrupted');
 const guard=q.TransactItems.find((w:any)=>w.ConditionCheck)?.ConditionCheck;
 if(guard&&conflict){conflict=false;const row=records.get(guard.Key.kind+':'+guard.Key.id);row.status='POSTED';row.version++;throw Object.assign(new Error('Concurrent post'),{name:'TransactionCanceledException'});}
 if(guard)expect(records.get(guard.Key.kind+':'+guard.Key.id).version).toBe(guard.ExpressionAttributeValues[':v']);
 for(const w of q.TransactItems){if(w.Put)records.set(w.Put.Item.kind+':'+w.Put.Item.id,structuredClone(w.Put.Item));if(w.Delete)records.delete(w.Delete.Key.kind+':'+w.Delete.Key.id);}
 return {};
})};
beforeEach(()=>{records.clear();queries=0;writes=0;conflict=false;interrupt=false;db.send.mockClear();});
const settlement=(id:string)=>({kind:'INTAKE_SETTLEMENT',id,intakeId:'inbox',version:1,reference:id,status:'RECORDED',statementIds:[]});
it('backfills every page without changing source records, and reruns without writes',async()=>{
 for(let i=0;i<51;i++){const s=settlement('s'+String(i).padStart(3,'0'));records.set('INTAKE_SETTLEMENT:'+s.id,s);}
 const sources=JSON.stringify([...records]);
 expect(await backfillStatementIndexes(db as any,'private')).toEqual({ready:false,records:51,applied:false});expect(writes).toBe(0);expect(queries).toBe(4);
 expect(await backfillStatementIndexes(db as any,'private',true)).toEqual({ready:true,records:51,applied:true});
 expect(JSON.stringify([...records].filter(([key])=>key.startsWith('INTAKE_SETTLEMENT:')))).toBe(sources);
 expect([...records.keys()].filter(k=>k.startsWith('INTAKE_SETTLEMENTS#inbox:'))).toHaveLength(51);
 const before=writes;expect(await backfillStatementIndexes(db as any,'private',true)).toMatchObject({ready:true,applied:false});expect(writes).toBe(before);
});
it('does not publish readiness on failure and can restart',async()=>{
 records.set('INTAKE_SETTLEMENT:s',settlement('s'));interrupt=true;
 await expect(backfillStatementIndexes(db as any,'private',true)).rejects.toThrow('Interrupted');
 expect(records.has('INDEX_STATE:'+STATEMENT_INDEX_STATE)).toBe(false);interrupt=false;
 expect(await backfillStatementIndexes(db as any,'private',true)).toMatchObject({ready:true});
});
it('re-reads concurrent source changes before writing active-work references',async()=>{
 records.set('INTAKE_SETTLEMENT:s',settlement('s'));conflict=true;
 await backfillStatementIndexes(db as any,'private',true);
 expect(records.has('INTAKE_SETTLEMENT_ACTIVE:s')).toBe(false);
 expect(records.get('INTAKE_SETTLEMENT:s')).toMatchObject({version:2,status:'POSTED'});
 expect(records.has('INTAKE_SETTLEMENTS#inbox:s')).toBe(true);
});
it('removes completed work and adds only new posted-statement links',()=>{
 const changes=statementIndexWrites('private',{kind:'INTAKE_SETTLEMENT',value:{...settlement('s'),status:'POSTED',statementIds:['old','new']},previous:{statementIds:['old']}});
 expect(changes).toContainEqual({Delete:{TableName:'private',Key:{kind:'INTAKE_SETTLEMENT_ACTIVE',id:'s'}}});
 const links=changes.filter(w=>w.Put?.Item?.kind==='INTAKE_STATEMENT_LINK');expect(links).toHaveLength(1);expect(links[0].Put!.Item).toMatchObject({id:'new',intakeId:'inbox'});
});
