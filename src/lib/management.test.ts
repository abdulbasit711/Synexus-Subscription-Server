import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { NextRequest } from 'next/server';
import { upgradeCharge, supportActive, ensureDefaultPlans } from './catalog';
import { registrationSchema, registerBusiness, paymentSchema, renewSupport, changePlan } from './management';
import { Business, Installation, Plan, ActivationCode, ManualPayment } from './models';
import { claimInstallation, completeProvisioning, provisioningManifest } from './provisioning';
import { issueEntitlement } from './entitlements';
import { createActivationCode } from './activation-codes';
import { withMongoTransaction } from './transaction';

test('upgrade price differences and support boundaries', () => {
  assert.equal(upgradeCharge(20000, 35000), 15000); assert.equal(upgradeCharge(20000, 50000), 30000);
  assert.equal(upgradeCharge(35000, 50000), 15000); assert.equal(upgradeCharge(50000, 20000), 0);
  assert.equal(supportActive('2026-10-25T00:00:00Z', new Date('2026-10-25T00:00:00Z')), false);
});
test('new registration requires owner credentials and an explicit expiry policy', () => {
  assert.equal(registrationSchema.safeParse({ contractVersion: 2, name: 'Client', region: 'Karachi', planKey: 'basic', provisioningMode: 'provision', expiryPolicy: 'keep_working' }).success, false);
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
});
