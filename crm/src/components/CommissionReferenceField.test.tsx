import { fireEvent,render,screen,waitFor } from '@testing-library/react';
import { beforeEach,expect,it,vi } from 'vitest';
import { CommissionAccessContext } from '../features/commissions/context';
const h=vi.hoisted(()=>({list:vi.fn()}));
vi.mock('../lib/client',()=>({client:{models:{Document:{listDocumentByEntityId:h.list}}},friendlyError:(e:Error)=>e.message}));
import CommissionReferenceField from './CommissionReferenceField';
beforeEach(()=>vi.resetAllMocks());
const scope={entityType:'ACCOUNT' as const,entityId:'a',policyId:'p',quoteId:'q'};
const doc=(id:string,patch={})=>({id,name:id+'.pdf',entityId:'a',entityType:'ACCOUNT',...patch});
it('offers saved references and scoped documents without automatically choosing evidence',async()=>{
  h.list.mockResolvedValueOnce({data:[doc('account'),doc('other-policy',{policyId:'other'}),doc('foreign',{entityId:'b'})],nextToken:'next'})
    .mockResolvedValueOnce({data:[doc('policy',{policyIds:['p']}),doc('quote',{quoteId:'q'}),doc('carrier',{entityType:'CARRIER'})]});
  const change=vi.fn();
  render(<CommissionReferenceField label="Agreement" value="" change={change} scope={scope} references={['Signed agreement','Signed agreement','-']}/>);
  const field=screen.getByLabelText('Agreement');
  expect(h.list).not.toHaveBeenCalled();
  fireEvent.focus(field);
  await waitFor(()=>expect(document.querySelectorAll('datalist option')).toHaveLength(4));
  const choices=Array.from(document.querySelectorAll('datalist option')).map(option=>(option as HTMLOptionElement).value);
  expect(choices).toEqual(['Signed agreement','CRM document: account.pdf [account]','CRM document: policy.pdf [policy]','CRM document: quote.pdf [quote]']);
  expect(h.list).toHaveBeenLastCalledWith({entityId:'a'},expect.objectContaining({nextToken:'next',filter:{entityType:{eq:'ACCOUNT'}}}));
  expect(change).not.toHaveBeenCalled();
  fireEvent.change(field,{target:{value:choices[2]}});
  expect(change).toHaveBeenCalledWith(choices[2]);
});
it('clears old document options and reports revoked access when the scope changes',async()=>{
  h.list.mockResolvedValueOnce({data:[doc('private')]}).mockResolvedValueOnce({data:[],errors:[{message:'Access denied',errorType:'Unauthorized'}]});
  const denied=vi.fn();
  const component=(entityId:string)=><CommissionAccessContext.Provider value={denied}><CommissionReferenceField label="Agreement" value="" change={vi.fn()} scope={{...scope,entityId}}/></CommissionAccessContext.Provider>;
  const view=render(component('a'));
  fireEvent.focus(screen.getByLabelText('Agreement'));
  await waitFor(()=>expect(document.querySelectorAll('datalist option')).toHaveLength(1));
  view.rerender(component('b'));
  expect(document.querySelectorAll('datalist option')).toHaveLength(0);
  await waitFor(()=>expect(denied).toHaveBeenCalled());
  expect(screen.getByRole('alert')).toHaveTextContent('Access denied');
  expect(document.querySelectorAll('datalist option')).toHaveLength(0);
});
it('keeps external references usable when the supporting record is outside CRM',()=>{
  const change=vi.fn();
  render(<CommissionReferenceField label="Agreement" value="Existing signed document" change={change}/>);
  fireEvent.change(screen.getByLabelText('Agreement'),{target:{value:'New signed addendum'}});
  expect(change).toHaveBeenCalledWith('New signed addendum');
  expect(h.list).not.toHaveBeenCalled();
});
