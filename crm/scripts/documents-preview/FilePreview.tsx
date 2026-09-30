import Modal from '../../src/components/Modal';

export function canPreview(name: string) { return /\.(pdf|txt|png|jpe?g|gif|webp|svg|bmp)$/i.test(name); }

/** The actual modal shell, with a local placeholder instead of a signed CRM file. */
export default function FilePreview({ name, onClose }: { name: string; onClose: () => void }) {
  return <Modal title={name} onClose={onClose}>
    <div style={{ padding: 32, minHeight: 320, background: '#f7f9fb' }}>
      <p className="small muted">Fictional document preview</p>
      <h2 style={{ overflowWrap: 'anywhere' }}>{name}</h2>
      <p>This preview uses in-memory sample files. No CRM file or external service is opened.</p>
      <hr /><h3>Willow Court Condominium</h3>
      <p>100 Example Street · Boston, MA 02110</p>
      <p>Property schedule, building information and coverage details appear here in the CRM.</p>
    </div>
  </Modal>;
}
