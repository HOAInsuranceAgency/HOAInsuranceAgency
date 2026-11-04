import { activeRole, type RoleRequest } from '../crm-access/active-role';
import { assertUserSession, activeTeamUserCheck } from '../crm-access/user-status';
import type { Identity } from '../crm-access/policy';
import { jurisdictionRule } from './agreements';
import { getModel, modelTable, transact } from './store';

/** One-time agency setup, versioned independently from unrelated identifiers. */
export async function saveJurisdiction(event:{identity?:Identity;request?:RoleRequest},input:Record<string,unknown>) {
  await assertUserSession(event.identity);
  if(!['ADMIN','OWNER'].includes(activeRole(event.identity,event.request)??''))throw new Error('Only an active agency administrator can configure broker fee jurisdictions.');
  const state=String(input.state??'').trim().toUpperCase();
  if(!/^(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])$/.test(state))throw new Error('Choose a US state or the District of Columbia.');
  const settings=await getModel<Record<string,unknown>>('AgencySettings','AGENCY');
  const prior=Number(settings?.brokerFeeJurisdictionsVersion??0);
  if(input.version!==prior)throw new Error('Jurisdiction settings changed. Reload before saving.');
  let rules:Record<string,unknown>={};
  const raw=settings?.brokerFeeJurisdictions;
  if(raw) rules=typeof raw==='string'?JSON.parse(raw):raw as Record<string,unknown>;
  const requested=input.rule as Record<string,unknown>;
  const signer=requested?.agencySigner as Record<string,unknown>|undefined;
  const toValidate=signer?.authorized===true?{...requested,agencySigner:{...signer,authorizedBy:event.identity!.sub,authorizedAt:new Date().toISOString()}}:requested;
  const next={...rules};
  if(input.rule==null)delete next[state];
  else {
    const rule=jurisdictionRule({[state]:toValidate},state,[]);
    if((rules[state] as {version?:string}|undefined)?.version===rule.version)throw new Error('Use a new review version when changing a jurisdiction rule.');
    next[state]=rule;
  }
  const now=new Date().toISOString();
  const names={'#version':'brokerFeeJurisdictionsVersion'};
  await transact([activeTeamUserCheck(event.identity!.sub!),{Update:{TableName:modelTable('AgencySettings'),Key:{id:'AGENCY'},UpdateExpression:'SET brokerFeeJurisdictions = :rules, #version = :next, updatedAt = :now, updatedBy = :actor, createdAt = if_not_exists(createdAt,:now), #type = :type',ConditionExpression:prior===0?'attribute_not_exists(#version) OR #version = :old':'#version = :old',ExpressionAttributeNames:{...names,'#type':'__typename'},ExpressionAttributeValues:{':rules':JSON.stringify(next),':next':prior+1,':old':prior,':now':now,':actor':event.identity!.sub,':type':'AgencySettings'}}}]);
  return {ok:true,version:prior+1,rules:next};
}
