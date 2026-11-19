import '../../src/styles.css';
import { mountPreview } from '../preview-support/mount';
import SalespersonAccessSettings from '../../src/components/SalespersonAccessSettings';
mountPreview(<main style={{maxWidth:960,margin:'32px auto',padding:'0 24px'}}><p className="muted">Settings / Team</p><h1>Team settings</h1><p className="card">Interactive preview — saves apply only to this preview and reset when you refresh. Live CRM permissions are unchanged.</p><SalespersonAccessSettings /></main>);
