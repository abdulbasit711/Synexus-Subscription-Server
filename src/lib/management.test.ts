import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { NextRequest } from 'next/server';
import { upgradeCharge, supportActive, ensureDefaultPlans, planFeatures, PREMIUM_FEATURES, ENTERPRISE_FEATURES } from './catalog';
import { registrationSchema, registerBusiness, paymentSchema, renewSupport, changePlan, deleteBusiness, deletionSchema } from './management';
import { Business, Installation, Plan, ActivationCode, ManualPayment, SubscriptionEvent } from './models';
import { claimInstallation, completeProvisioning, provisioningManifest } from './provisioning';
import { issueEntitlement } from './entitlements';
import { createActivationCode } from './activation-codes';
import { withMongoTransaction } from './transaction';
import { backupHost, configureBackup, machineBackupDestination } from './backup';
import { POST as installationBackup } from '../app/api/v1/installations/backup/route';

test('upgrade price differences and support boundaries', () => {
  assert.equal(upgradeCharge(20000, 35000), 15000); assert.equal(upgradeCharge(20000, 50000), 30000);
  assert.equal(upgradeCharge(35000, 50000), 15000); assert.equal(upgradeCharge(50000, 20000), 0);
  assert.equal(supportActive('2026-10-25T00:00:00Z', new Date('2026-10-25T00:00:00Z')), false);
});
test('new registration requires owner credentials and an explicit expiry policy', () => {
  assert.equal(registrationSchema.safeParse({ contractVersion: 2, name: 'Client', region: 'Karachi', planKey: 'basic', provisioningMode: 'provision', expiryPolicy: 'keep_working' }).success, false);
});
test('deletion requires a reason and an explicit name confirmation', () => {
  assert.equal(deletionSchema.safeParse({ reason: '  ', confirmName: 'Client' }).success, false);
  assert.equal(deletionSchema.safeParse({ reason: 'Duplicate registration' }).success, false);
});
test('blank legacy catalogs supply included plan features while explicit selections are retained', () => {
  assert.deepEqual(planFeatures({ key: 'basic', features: [] }), []);
  assert.deepEqual(planFeatures({ key: 'premium', features: [] }), PREMIUM_FEATURES);
  assert.deepEqual(planFeatures({ key: 'enterprise' }), ENTERPRISE_FEATURES);
  assert.deepEqual(planFeatures({ key: 'premium', features: ['advancedReports'] }), ['advancedReports', 'cloudBackup']);
});
const integration = process.env.MONGODB_URI?.includes('/pandas_license_test_') ? describe : describe.skip;
integration('Synexus transactions and provisioning', () => {
  const actor = new mongoose.Types.ObjectId().toString();
  const pair = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  before(async () => { await mongoose.connect(process.env.MONGODB_URI!); await Promise.all([Business.init(), Installation.init(), Plan.init(), ActivationCode.init(), ManualPayment.init()]); await ensureDefaultPlans(); });
  after(async () => { assert.match(mongoose.connection.name, /^pandas_license_test_/); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const register = (extra: Record<string, unknown> = {}) => registerBusiness(registrationSchema.parse({ contractVersion: 2, name: `Client ${randomUUID()}`, region: 'Karachi',
    planKey: 'basic', provisioningMode: 'provision', expiryPolicy: 'keep_working', owner: { username: `owner-${randomUUID()}`, firstname: 'Owner', mobileno: ['03001234567'], password: 'integration-password-123' }, ...extra }), actor);
  const payment = (amount: number) => paymentSchema.parse({ requestId: randomUUID(), amount, discount: 0, method: amount ? 'bank_transfer' : 'waiver', reference: 'test-reference', reason: 'Integration test', paidAt: new Date().toISOString() });
  function claim(code: string, overrides: Record<string, unknown> = {}) {
    const payload = { protocolVersion: 2, activationCode: code, publicKey: pair.publicKey, deploymentId: randomUUID(), localBusinessId: new mongoose.Types.ObjectId().toString(), mode: 'provision', label: 'test', ...overrides };
    const raw = JSON.stringify(payload), timestamp = String(Date.now()), nonce = randomUUID();
    const signature = sign(null, Buffer.from(`${timestamp}.${nonce}.${createHash('sha256').update(raw).digest('hex')}`), pair.privateKey).toString('base64url');
    const request = new NextRequest('https://example.test/api/v1/installations/activate', { method: 'POST', body: raw, headers: { 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': signature } });
    return { payload, execute: () => claimInstallation(request, raw) };
  }
  test('legacy catalog repair preserves negotiated prices, names, quotas and nonempty feature selections', async () => {
    const original = (await Plan.findOne({ key: 'premium' }))!.toObject();
    try {
      await Plan.updateOne({ key: 'premium' }, { $set: { features: [], name: 'Negotiated Premium', installationPrice: 29000, annualPrice: 13000, userLimit: 5 } });
      await ensureDefaultPlans();
      const repaired = (await Plan.findOne({ key: 'premium' }))!;
      assert.deepEqual([...repaired.features], PREMIUM_FEATURES);
      assert.equal(repaired.name, 'Negotiated Premium'); assert.equal(repaired.installationPrice, 29000);
      assert.equal(repaired.annualPrice, 13000); assert.equal(repaired.userLimit, 5);
      await Plan.updateOne({ key: 'premium' }, { $set: { features: ['advancedReports'] } });
      await ensureDefaultPlans(); assert.deepEqual([...(await Plan.findOne({ key: 'premium' }))!.features], ['advancedReports', 'cloudBackup']);
    } finally { await Plan.replaceOne({ key: 'premium' }, original); }
  });
  test('signed entitlements include all plan features even before a blank legacy catalog is repaired', async () => {
    for (const [planKey, expected] of [['basic', []], ['premium', PREMIUM_FEATURES], ['enterprise', ENTERPRISE_FEATURES]] as const) {
      const created = await register({ planKey }); const installationId = await claim(created.activationCode).execute();
      const original = (await Plan.findOne({ key: planKey }))!.features;
      try {
        await Plan.updateOne({ key: planKey }, { $set: { features: [] } });
        assert.deepEqual((await issueEntitlement(installationId)).entitlement.features, expected);
      } finally { await Plan.updateOne({ key: planKey }, { $set: { features: original } }); }
    }
  });
  test('per-client Atlas destinations are encrypted, private, isolated and unavailable to Basic or suspended agreements', async () => {
    process.env.SESSION_SECRET ||= 'isolated-synexus-backup-encryption-secret';
    const a = await register({ planKey: 'premium' }), b = await register({ planKey: 'enterprise' });
    const uri = 'mongodb+srv://client-user:private-password@client-a.mongodb.net/';
    assert.equal(backupHost(uri), 'client-a.mongodb.net');
    assert.throws(() => backupHost('mongodb://user:password@localhost'), /Atlas/);
    const input = { enabled: true, uri, database: 'client_a', reason: 'Assign dedicated client cluster' };
    const saved = await configureBackup(String(a.business._id), input, actor);
    assert.equal(saved.configured, true); assert.equal('uri' in saved, false);
    const privateRow = await Business.findById(a.business._id).select('+backupUriEncrypted');
    assert.ok(privateRow!.backupUriEncrypted); assert.notEqual(privateRow!.backupUriEncrypted, uri);
    assert.equal('backupUriEncrypted' in (await Business.findById(a.business._id).lean())!, false);
    assert.deepEqual(await machineBackupDestination(a.business._id), { uri, database: 'client_a' });
    await assert.rejects(configureBackup(String(b.business._id), { ...input, database: 'client_b' }, actor), /another client/);
    await configureBackup(String(b.business._id), { ...input, uri: uri.replace('client-a', 'client-b'), database: 'client_b' }, actor);
    assert.equal((await machineBackupDestination(b.business._id)).database, 'client_b');
    const events = await SubscriptionEvent.find({ businessId: a.business._id });
    assert.equal(JSON.stringify(events).includes('private-password'), false);
    await configureBackup(String(a.business._id), { ...input, uri: undefined, enabled: false }, actor);
    await assert.rejects(machineBackupDestination(a.business._id), /Configure/);
    await Business.updateOne({ _id: b.business._id }, { $set: { configuredStatus: 'suspended' } });
    await assert.rejects(machineBackupDestination(b.business._id), /not active/);
    const basic = await register(); await assert.rejects(machineBackupDestination(basic.business._id), /Premium/);
  });
  test('backup credentials are delivered only to the matching authenticated active installation', async () => {
    process.env.SESSION_SECRET ||= 'isolated-synexus-backup-encryption-secret';
    const created = await register({ planKey: 'premium' });
    await configureBackup(String(created.business._id), { enabled: true, uri: 'mongodb+srv://user:password@machine-client.mongodb.net/', database: 'machine_client', reason: 'Machine backup test' }, actor);
    const installationId = await claim(created.activationCode).execute();
    const request = () => {
      const body = '{}', timestamp = String(Date.now()), nonce = randomUUID();
      const signature = sign(null, Buffer.from(`${timestamp}.${nonce}.${createHash('sha256').update(body).digest('hex')}`), pair.privateKey).toString('base64url');
      return new NextRequest('https://example.test/api/v1/installations/backup', { method: 'POST', body, headers: { 'x-installation-id': installationId, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': signature } });
    };
    const response = await installationBackup(request()); assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await response.json()).data.database, 'machine_client');
    assert.equal((await installationBackup(new NextRequest('https://example.test', { method: 'POST', body: '{}', headers: { 'x-installation-id': installationId } }))).status, 401);
    await Installation.updateOne({ _id: installationId }, { $set: { status: 'revoked' } });
    assert.equal((await installationBackup(request())).status, 401);
  });
  test('registration redacts bootstrap hash; activation starts exactly one included support year', async () => {
    const created = await register(); assert.equal('ownerBootstrap' in created.business, false);
    const id = String(created.business._id); assert.equal((await Business.findById(id))!.supportExpiresAt, null);
    const request = claim(created.activationCode); const installationId = await request.execute();
    assert.equal(await request.execute(), installationId);
    const manifest = await provisioningManifest(installationId); const profile = JSON.parse(Buffer.from(manifest.token.split('.')[0], 'base64url').toString());
    assert.match(profile.owner.passwordHash, /^\$2/); assert.equal(profile.owner.password, undefined);
    await completeProvisioning(installationId); const first = await Business.findById(id);
    assert.equal(first!.supportExpiresAt!.getUTCFullYear(), first!.firstActivatedAt!.getUTCFullYear() + 1);
    const through = first!.supportExpiresAt!.toISOString(); await completeProvisioning(installationId);
    assert.equal((await Business.findById(id))!.supportExpiresAt!.toISOString(), through);
    await assert.rejects(provisioningManifest(installationId), /already complete/);
  });
  test('concurrent claims produce one binding; another key cannot resume the consumed code', async () => {
    const created = await register(); const a = claim(created.activationCode), b = claim(created.activationCode);
    const results = await Promise.allSettled([a.execute(), b.execute()]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(await Installation.countDocuments({ businessId: created.business._id }), 1);
    await assert.rejects(claim(created.activationCode).execute(), /already been used/);
  });
  test('reissuing a code invalidates the old unused code', async () => {
    const created = await register(); const next = await withMongoTransaction(session => createActivationCode(created.business._id, actor, session, 'Replace test code'));
    await assert.rejects(claim(created.activationCode).execute(), /invalid|newer/);
    assert.ok(await claim(next.activationCode).execute());
  });
  test('expired codes and unsigned activation requests cannot create installations', async () => {
    const created = await register(); await ActivationCode.updateOne({ businessId: created.business._id }, { $set: { expiresAt: new Date(0) } });
    await assert.rejects(claim(created.activationCode).execute(), /expired/);
    const raw = JSON.stringify(claim(created.activationCode).payload);
    await assert.rejects(claimInstallation(new NextRequest('https://example.test', { method: 'POST', body: raw }), raw), /signature/);
    assert.equal(await Installation.countDocuments({ businessId: created.business._id }), 0);
  });
  test('renewal is idempotent, uses the support price, and retains suspension', async () => {
    const created = await register({ provisioningMode: 'enroll', owner: undefined, supportExpiresAt: '2030-02-28T00:00:00.000Z' });
    const id = String(created.business._id); await Business.updateOne({ _id: id }, { $set: { configuredStatus: 'suspended' } });
    const input = { ...payment(10000), terms: 1 }; await Promise.all([renewSupport(id, input, actor), renewSupport(id, input, actor)]);
    const business = await Business.findById(id); assert.equal(business!.supportExpiresAt!.toISOString(), '2031-02-28T00:00:00.000Z'); assert.equal(business!.configuredStatus, 'suspended');
    assert.equal(await ManualPayment.countDocuments({ businessId: id }), 1);
  });
  test('upgrades charge the installation difference; downgrades stay pending and retain support dates', async () => {
    const created = await register({ provisioningMode: 'enroll', owner: undefined, supportExpiresAt: '2030-02-28T00:00:00.000Z' });
    const id = String(created.business._id); await changePlan(id, { ...payment(15000), planKey: 'premium' }, actor);
    const upgraded = await Business.findById(id); assert.equal(upgraded!.planKey, 'premium'); assert.equal(upgraded!.annualSupportPrice, 15000);
    assert.equal(upgraded!.supportExpiresAt!.toISOString(), '2030-02-28T00:00:00.000Z');
    await changePlan(id, { ...payment(0), planKey: 'basic' }, actor);
    const pending = await Business.findById(id); assert.equal(pending!.planKey, 'premium'); assert.equal(pending!.requestedPlan.planKey, 'basic');
  });
  test('support expiry policies produce distinct ERP access and revoked bindings issue a signed suspension', async () => {
    const created = await register(); const id = String(created.business._id); const installationId = await claim(created.activationCode).execute(); await completeProvisioning(installationId);
    await Business.updateOne({ _id: id }, { $set: { supportExpiresAt: new Date(0), expiryPolicy: 'keep_working' } });
    const ongoing = await issueEntitlement(installationId); assert.equal(ongoing.entitlement.status, 'active'); assert.equal(ongoing.entitlement.supportStatus, 'expired');
    await Business.updateOne({ _id: id }, { $set: { expiryPolicy: 'read_only' } }); assert.equal((await issueEntitlement(installationId)).entitlement.status, 'expired');
    await Installation.updateOne({ _id: installationId }, { $set: { status: 'revoked' } }); assert.equal((await issueEntitlement(installationId, true)).entitlement.status, 'suspended');
  });
  test('deletion confirms the name, revokes access and codes, retains history, and is idempotent', async () => {
    const created = await register(); const id = String(created.business._id);
    const installationId = await claim(created.activationCode).execute(); await completeProvisioning(installationId);
    await changePlan(id, { ...payment(15000), planKey: 'premium' }, actor);
    await changePlan(id, { ...payment(0), planKey: 'basic' }, actor);
    const replacement = await withMongoTransaction(session => createActivationCode(id, actor, session, 'Replacement for deletion test'));
    const before = await Business.findById(id); const input = { confirmName: String(created.business.name), reason: 'Client registration removed' };
    await assert.rejects(deleteBusiness(id, { ...input, confirmName: 'Wrong name' }, actor), /exactly/);
    assert.equal((await Business.findById(id))!.deletedAt, null);
    await deleteBusiness(id, input, actor); await deleteBusiness(id, input, actor);
    const deleted = await Business.findById(id);
    assert.ok(deleted!.deletedAt); assert.equal(deleted!.configuredStatus, 'suspended');
    assert.equal(deleted!.revision, before!.revision + 1); assert.equal(deleted!.requestedPlan, null); assert.equal(deleted!.activeInstallationId, null);
    assert.equal(await Business.countDocuments({ _id: id, deletedAt: null }), 0);
    assert.equal((await Installation.findById(installationId))!.status, 'revoked');
    assert.equal(await ActivationCode.countDocuments({ businessId: id, usedAt: null, invalidatedAt: null }), 0);
    assert.equal(await ManualPayment.countDocuments({ businessId: id }), 2);
    assert.equal(await SubscriptionEvent.countDocuments({ businessId: id, type: 'business_deleted' }), 1);
    assert.equal((await issueEntitlement(installationId, true)).entitlement.status, 'suspended');
    await assert.rejects(claim(replacement.activationCode).execute(), /invalid/);
    await assert.rejects(claim(created.activationCode).execute(), /used/);
    await assert.rejects(withMongoTransaction(session => createActivationCode(id, actor, session, 'Cannot reissue')), /not found/);
    await assert.rejects(changePlan(id, { ...payment(15000), planKey: 'enterprise' }, actor), /deleted/);
    await assert.rejects(renewSupport(id, { ...payment(15000), terms: 1 }, actor), /deleted/);
    await assert.rejects(provisioningManifest(installationId), /not active/);
  });
  test('deleting an unactivated or legacy business also blocks activation and access', async () => {
    const created = await register(); const id = String(created.business._id);
    await deleteBusiness(id, { confirmName: String(created.business.name), reason: 'Duplicate business' }, actor);
    await assert.rejects(claim(created.activationCode).execute(), /invalid/);
    const legacy = await Business.create({ name: 'Legacy client', planKey: 'basic', billingType: 'perpetual' });
    const installation = await Installation.create({ businessId: legacy._id, publicKey: pair.publicKey });
    await deleteBusiness(String(legacy._id), { confirmName: legacy.name, reason: 'Legacy client removed' }, actor);
    assert.equal((await issueEntitlement(String(installation._id), true)).entitlement.status, 'suspended');
  });
});
