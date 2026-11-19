import { createHash } from 'node:crypto';
import type { IntakeSettlement } from '../../../../shared/commissionIntake';
import type { assertStatementPostingPlan } from './posting';
import * as store from './store';
export type Calculation = ReturnType<typeof assertStatementPostingPlan>['calculations'][number];
type ReviewRows = {rowId:string; calculations:Calculation[]}[];
interface ReviewRecord {id:string;token:string;rows:ReviewRows;version?:number}
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export const reviewRecordHash = (rows:ReviewRows) => createHash('sha256').update(JSON.stringify(canonical(rows))).digest('hex');
/** Prepare small immutable snapshots before the versioned approval commits. Unreferenced snapshots authorize nothing. */
export async function saveReviewRecords(token:string, rows:ReviewRows, actor:string) {
  const groups:ReviewRows[]=[];let group:ReviewRows=[];
  for(const row of rows){
    if(Buffer.byteLength(JSON.stringify(row))>24000)throw new Error('This employee calculation exceeds the supported review size.');
    if(group.length&&Buffer.byteLength(JSON.stringify([...group,row]))>24000){groups.push(group);group=[];}
    group.push(row);
  }
  if(group.length)groups.push(group);
  const records=groups.map((rows,i)=>({id:token+':'+i,token,rows}));
  const verify=(saved:ReviewRecord|undefined,expected:ReviewRecord)=>saved?.token===token&&reviewRecordHash(saved.rows)===reviewRecordHash(expected.rows);
  for(let offset=0;offset<records.length;offset+=4)await Promise.all(records.slice(offset,offset+4).map(async record=>{
    const old=await store.get<ReviewRecord>('INTAKE_REVIEW',record.id);
    if(old){if(!verify(old,record))throw new Error('Saved financial review does not match. Refresh before confirming.');return;}
    try {await store.commit([{kind:'INTAKE_REVIEW',value:record as unknown as store.Change['value']}],actor);}
    catch(error){if(!verify(await store.get<ReviewRecord>('INTAKE_REVIEW',record.id),record))throw error;}
  }));
  return records.map(record=>({id:record.id,hash:reviewRecordHash(record.rows),rowIds:record.rows.map(r=>r.rowId)}));
}
export async function readReviewCalculations(review:NonNullable<IntakeSettlement['review']>, rowIds:string[]) {
  const refs=review.records.filter(ref=>ref.rowIds.some(id=>rowIds.includes(id)));
  const saved=await store.getMany<ReviewRecord>(refs.map(ref=>({kind:'INTAKE_REVIEW',id:ref.id})));
  const rows=new Map<string,Calculation[]>();
  for(const ref of refs){
    const record=saved.find(r=>r.id===ref.id);
    if(!record||record.token!==review.token||reviewRecordHash(record.rows)!==ref.hash)throw new Error('The approved employee calculation records are incomplete or changed. Review the remaining calculations again.');
    for(const row of record.rows)if(rowIds.includes(row.rowId)){if(rows.has(row.rowId))throw new Error('Duplicate approved calculation row.');rows.set(row.rowId,row.calculations);}
  }
  if(rowIds.some(id=>!rows.has(id)))throw new Error('Approved employee calculations are missing. Review the remaining calculations again.');
  return rows;
}
