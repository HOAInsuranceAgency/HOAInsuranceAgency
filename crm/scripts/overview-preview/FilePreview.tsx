import Modal from '../../src/components/Modal';

export default function FilePreview({ name, onClose }: { name: string; onClose: () => void }) {
  return <Modal title={name} onClose={onClose}>
    <div style={{ padding: 32, minHeight: 320, background: '#f7f9fb' }}>
      <p className="small muted">Fictional file preview</p>
      <h2 style={{ overflowWrap: 'anywhere' }}>{name}</h2>
      <p>This is local sample content. No CRM file or external service is opened.</p>
      <hr /><h3>Willow Court Condominium</h3>
      <p>100 Example Street · Boston, MA 02110</p>
      <p>Site imagery and plans appear here in the CRM.</p>
    </div>
  </Modal>;
}
