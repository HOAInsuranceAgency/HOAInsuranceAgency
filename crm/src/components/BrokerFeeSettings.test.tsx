import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateLiveUpdates } from '../test/liveUpdates';

const h = vi.hoisted(() => ({ admin: true, get: vi.fn(), save: vi.fn(), identifiers: vi.fn(), storage: vi.fn() }));
vi.mock('../lib/client', async original => ({
  ...await original<typeof import('../lib/client')>(),
  client: { models: { AgencySettings: { get: h.get } }, mutations: { brokerFeeAction: h.save } },
  US_STATES: ['MA', 'WA', 'FL'],
}));
vi.mock('../lib/auth', () => ({ useIsAdmin: () => h.admin }));
vi.mock('../lib/scopedStorage', () => ({ list: h.storage, uploadData: vi.fn() }));
vi.mock('../lib/acord', () => ({ ACORD_FORMS: [], listTemplateFields: vi.fn() }));
vi.mock('../lib/agencySettings', () => ({ EMPTY_IDENTIFIERS: { agencyNpn: '', drlpNpn: '', agencyEin: '' }, loadAgencyIdentifiers: h.identifiers, saveAgencyIdentifiers: vi.fn() }));
vi.mock('../pages/Team', () => ({ default: () => null }));
vi.mock('./CommunicationSettings', () => ({ default: () => null }));
vi.mock('./MarketingReportSettings', () => ({ default: () => null }));
vi.mock('./Licensing', () => ({ default: () => null }));
vi.mock('./SignatureManager', () => ({ default: () => null }));

import BrokerFeeSettings from './BrokerFeeSettings';
import Settings from '../pages/Settings';

type Snapshot = { id: string; brokerFeeJurisdictionsVersion: number; brokerFeeJurisdictions: Record<string, any> };
let stored: Snapshot;
const approvedRule = () => ({ approved: true, version: 'MA-v1', reviewedBy: 'Agency reviewer', reviewedAt: '2026-11-01T12:00:00Z', evidenceUrl: 'https://regulator.example.test/fees',
  allowedLines: ['Property', 'D&O'], allowedBillTypes: ['AGENCY', 'DIRECT'], allowsCarrierCommission: true, maxFeeCents: 50025,
  forms: [{ title: 'State disclosure', paragraphs: ['Complete required state wording.'] }], requiresBrokerSignature: true,
  agencySigner: { name: 'Jake Greasley', title: 'Owner', licenseNumber: 'LICENSE-123', authorized: true, authorizedBy: 'verified-owner', authorizedAt: '2026-11-01T12:00:00Z' } });
const field = (label: string | RegExp) => label === 'State' ? screen.getByRole('combobox', { name: 'State' }) : screen.getByLabelText(label, { exact: false });
const saveButton = () => screen.getByRole('button', { name: 'Save disclosure rules' });
function edit(label: string | RegExp, value: string) { fireEvent.change(field(label), { target: { value } }); }
async function ready() { await screen.findByLabelText('State'); }
function fillRules() {
  edit('Review reference/version', 'MA-v1'); edit('Reviewed by', 'Agency reviewer'); edit('Review date', '2026-11-01');
  edit('Source/reference link', 'https://regulator.example.test/fees'); edit('Permitted coverage lines, separated by commas', 'Property, D&O'); edit('Maximum fee ($), if applicable', '500.25');
  fireEvent.click(screen.getByRole('button', { name: 'Add state form' }));
  edit('Form title', 'State disclosure'); edit('Disclosure wording', 'First complete paragraph.\n\nSecond complete paragraph.');
  fireEvent.click(field(/reviewed rules for fees alongside carrier commission/));
}
beforeEach(() => {
  vi.resetAllMocks(); h.admin = true;
  stored = { id: 'AGENCY', brokerFeeJurisdictionsVersion: 0, brokerFeeJurisdictions: {} };
  h.get.mockImplementation(async () => ({ data: structuredClone(stored) }));
  h.save.mockImplementation(async ({ input }) => {
    const request = JSON.parse(input);
    const rules = { ...stored.brokerFeeJurisdictions };
    if (request.rule == null) delete rules[request.state]; else rules[request.state] = request.rule;
    stored = { ...stored, brokerFeeJurisdictionsVersion: stored.brokerFeeJurisdictionsVersion + 1, brokerFeeJurisdictions: rules };
    return { data: { ok: true, version: stored.brokerFeeJurisdictionsVersion, rules: structuredClone(stored.brokerFeeJurisdictions) } };
  });
  h.identifiers.mockResolvedValue({ agencyNpn: '', drlpNpn: '', agencyEin: '' }); h.storage.mockResolvedValue({ items: [] });
});

describe('one-time broker fee jurisdiction configuration', () => {
  it('starts unconfigured without claiming fees are permitted, then saves reviewed terms in the existing agency settings', async () => {
    render(<BrokerFeeSettings />); await ready();
    expect(screen.queryByRole('button', { name: /reload|refresh|retry/i })).not.toBeInTheDocument();
    expect(screen.getByText(/A state without configured rules cannot charge a broker fee/)).toBeVisible();
    expect(field(/reviewed rules for fees alongside carrier commission/)).not.toBeChecked();
    fillRules(); fireEvent.click(saveButton());
    await waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
    const request = JSON.parse(h.save.mock.calls[0][0].input);
    expect(request).toMatchObject({ op: 'saveJurisdiction', state: 'MA', version: 0, rule: {
      approved: true, version: 'MA-v1', maxFeeCents: 50025, allowedLines: ['Property', 'D&O'], allowedBillTypes: ['AGENCY'],
      forms: [{ title: 'State disclosure', paragraphs: ['First complete paragraph.', 'Second complete paragraph.'] }],
    } });
    await waitFor(() => expect(field('Review reference/version')).toHaveValue('MA-v1'));
    expect(field('Maximum fee ($), if applicable')).toHaveValue('500.25');
  });

  it('submits actual authorized signer fields while leaving signer audit identity to the server', async () => {
    render(<BrokerFeeSettings />); await ready(); fillRules();
    fireEvent.click(field(/This state requires the agency to countersign/));
    edit('Authorized agency signer', 'Jake Greasley'); edit('Signer title', 'Owner'); edit('Agency/broker license number', 'LICENSE-123');
    fireEvent.click(field(/I authorize this agency electronic countersignature/));
    fireEvent.click(saveButton());
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const { agencySigner, requiresBrokerSignature } = JSON.parse(h.save.mock.calls[0][0].input).rule;
    expect(requiresBrokerSignature).toBe(true);
    expect(agencySigner).toEqual({ name: 'Jake Greasley', title: 'Owner', licenseNumber: 'LICENSE-123', authorized: true });
    expect(screen.queryByLabelText('Authorized by')).not.toBeInTheDocument();
  });

  it.each([
    ['Authorized agency signer', 'Updated Signer', 'name'],
    ['Signer title', 'Agency Principal', 'title'],
    ['Agency/broker license number', 'LICENSE-456', 'licenseNumber'],
  ])('requires fresh countersignature authorization after changing %s', async (label, value, key) => {
    stored.brokerFeeJurisdictions.MA = approvedRule();
    render(<BrokerFeeSettings />); await ready();
    expect(field(/I authorize this agency electronic countersignature/)).toBeChecked();
    edit(label, value);
    expect(field(/I authorize this agency electronic countersignature/)).not.toBeChecked();
    edit('Review reference/version', 'MA-v2');
    fireEvent.click(field(/I authorize this agency electronic countersignature/));
    fireEvent.click(saveButton()); await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const signer = JSON.parse(h.save.mock.calls[0][0].input).rule.agencySigner;
    expect(signer).toMatchObject({ [key]: value, authorized: true });
    expect(signer).not.toHaveProperty('authorizedBy');
    expect(signer).not.toHaveProperty('authorizedAt');
  });

  it('enables actual insurer commission disclosure when the reviewed state form requires it', async () => {
    render(<BrokerFeeSettings />); await ready(); fillRules();
    fireEvent.click(field(/Disclose each policy’s insurer-paid agency commission/));
    fireEvent.click(saveButton()); await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(JSON.parse(h.save.mock.calls[0][0].input).rule.discloseCarrierCommission).toBe(true);
  });

  it('can withdraw configured jurisdiction permission without deleting prior signed evidence', async () => {
    stored = { ...stored, brokerFeeJurisdictionsVersion: 2, brokerFeeJurisdictions: { MA: approvedRule() } };
    render(<BrokerFeeSettings />); await ready();
    expect(field(/reviewed rules for fees alongside carrier commission/)).toBeChecked();
    fireEvent.click(field(/reviewed rules for fees alongside carrier commission/)); fireEvent.click(saveButton());
    await waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
    expect(JSON.parse(h.save.mock.calls[0][0].input)).toMatchObject({ op: 'saveJurisdiction', state: 'MA', version: 2, rule: null });
    await waitFor(() => expect(field(/reviewed rules for fees alongside carrier commission/)).not.toBeChecked());
  });

  it('locks jurisdiction selection and all terms while a save is pending', async () => {
    let complete!: (value: unknown) => void;
    h.save.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    render(<BrokerFeeSettings />); await ready(); fillRules(); fireEvent.click(saveButton());
    expect(saveButton()).toBeDisabled(); expect(field('State')).toBeDisabled();
    expect(field('Reviewed by')).toBeDisabled();
    await act(async () => complete({ data: { ok: false, error: 'Storage unavailable' } }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Storage unavailable');
    expect(field('State')).toBeEnabled(); expect(field('Reviewed by')).toHaveValue('Agency reviewer');
  });

  it('preserves edits after a save failure and permits retry without duplicate pending requests', async () => {
    h.save.mockResolvedValueOnce({ data: { ok: false, error: 'Storage unavailable' } });
    render(<BrokerFeeSettings />); await ready(); fillRules(); fireEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Storage unavailable');
    expect(field('Disclosure wording')).toHaveValue('First complete paragraph.\n\nSecond complete paragraph.');
    fireEvent.click(saveButton()); await waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
    expect(h.save).toHaveBeenCalledTimes(2);
  });

  it('offers an error-only retry after a stale version instead of retrying the same obsolete version forever', async () => {
    stored.brokerFeeJurisdictionsVersion = 2; stored.brokerFeeJurisdictions.MA = approvedRule();
    h.save.mockResolvedValueOnce({ data: { ok: false, error: 'Jurisdiction settings changed. Reload before saving.' } });
    render(<BrokerFeeSettings />); await ready(); edit('Review reference/version', 'MA-my-review-v2'); fireEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Reload before saving');
    expect(JSON.parse(h.save.mock.calls[0][0].input).version).toBe(2);
    expect(field('Review reference/version')).toHaveValue('MA-my-review-v2');
    stored = { ...stored, brokerFeeJurisdictionsVersion: 3, brokerFeeJurisdictions: { MA: { ...approvedRule(), version: 'MA-other-review-v3' } } };
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(field('Review reference/version')).toHaveValue('MA-other-review-v3'));
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    edit('Review reference/version', 'MA-my-review-v4'); fireEvent.click(saveButton());
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(2));
    expect(JSON.parse(h.save.mock.calls[1][0].input).version).toBe(3);
  });

  it('updates pristine disclosure rules automatically and defers updates while reviewed terms are being edited', async () => {
    stored = { ...stored, brokerFeeJurisdictionsVersion: 2, brokerFeeJurisdictions: { MA: approvedRule() } };
    render(<BrokerFeeSettings />); await ready();
    stored = { ...stored, brokerFeeJurisdictionsVersion: 3, brokerFeeJurisdictions: { MA: { ...approvedRule(), version: 'MA-current-v3' } } };
    await invalidateLiveUpdates(['CRM']);
    expect(field('Review reference/version')).toHaveValue('MA-current-v3');
    expect(h.get).toHaveBeenCalledTimes(2);
    edit('Review reference/version', 'MA-unsaved-review');
    stored = { ...stored, brokerFeeJurisdictionsVersion: 4, brokerFeeJurisdictions: { MA: { ...approvedRule(), version: 'MA-current-v4' } } };
    await invalidateLiveUpdates(['CRM']);
    expect(field('Review reference/version')).toHaveValue('MA-unsaved-review');
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('rejects a fractional-cent maximum rather than silently changing a reviewed legal fee limit', async () => {
    render(<BrokerFeeSettings />); await ready(); fillRules(); edit('Maximum fee ($), if applicable', '500.259'); fireEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/decimal|cent|valid|rules/i);
    expect(h.save).not.toHaveBeenCalled(); expect(field('Maximum fee ($), if applicable')).toHaveValue('500.259');
  });

  it('recovers an initial read failure without presenting missing configuration as an empty confirmed state', async () => {
    h.get.mockRejectedValueOnce(new Error('Settings unavailable'));
    render(<BrokerFeeSettings />);
    expect(await screen.findByText(/Settings unavailable/)).toBeVisible();
    expect(screen.queryByLabelText('Review reference/version')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await ready(); expect(field('Review reference/version')).toHaveValue('');
  });
});

describe('ordinary Settings role integration', () => {
  const profile = { id: 'profile', userId: 'user', firstName: 'Jake', lastName: 'Greasley' } as import('../lib/client').UserProfile;
  it('loads disclosure configuration inside the existing Agency tab for administrators', async () => {
    render(<MemoryRouter initialEntries={['/settings?tab=agency']}><Settings profile={profile} /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Broker fee disclosures' })).toBeVisible();
    await ready(); expect(h.get).toHaveBeenCalledExactlyOnceWith({ id: 'AGENCY' });
    expect(screen.getByRole('heading', { name: 'Agency identifiers' })).toBeVisible();
  });
  it('does not load administrator configuration through a guessed Agency tab in an ordinary role', async () => {
    h.admin = false;
    render(<MemoryRouter initialEntries={['/settings?tab=agency']}><Settings profile={profile} /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'ACORD templates' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Agency' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Broker fee disclosures' })).not.toBeInTheDocument();
    expect(h.get).not.toHaveBeenCalled();
  });
  it('unmounts disclosure configuration immediately when administrator privileges are narrowed', async () => {
    const view = render(<MemoryRouter initialEntries={['/settings?tab=agency']}><Settings profile={profile} /></MemoryRouter>);
    await ready(); h.admin = false;
    view.rerender(<MemoryRouter initialEntries={['/settings?tab=agency']}><Settings profile={profile} /></MemoryRouter>);
    expect(screen.queryByRole('heading', { name: 'Broker fee disclosures' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save disclosure rules' })).not.toBeInTheDocument();
  });
});
