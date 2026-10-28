import { createRoot } from 'react-dom/client';
import { MemoryRouter, Link, Routes, Route } from 'react-router-dom';
import Relationships from '../../src/pages/Relationships';
import RelationshipDetail from '../../src/pages/RelationshipDetail';
import AccountRelationships from '../../src/components/AccountRelationships';
import '../../src/styles.css';
function Preview() {
  return <div className="shell"><aside className="sidebar"><div className="sidebar-top"><div className="brand"><img src="/logo.png" alt="HOA Insurance Agency" /></div></div><nav><Link to="/relationships">Relationships</Link><Link to="/accounts/willow">Willow Court</Link></nav><div className="spacer"/><div className="user">Fictional local preview</div></aside><main className="main"><Routes><Route path="/relationships" element={<Relationships />}/><Route path="/relationships/:id" element={<RelationshipDetail />}/><Route path="/accounts/:id" element={<><h1>Willow Court Condominium</h1><p className="sub">Client · Boston, MA · Insured account retained since 2024</p><AccountRelationships accountId="willow" onChanged={() => {}} /></>} /></Routes></main></div>;
}
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/relationships']}><Preview /></MemoryRouter>);
