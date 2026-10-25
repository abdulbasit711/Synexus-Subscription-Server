import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import mongoose from 'mongoose';
import { connectDb } from './db';
import { Business, SubscriptionEvent } from './models';
import { withMongoTransaction } from './transaction';

const integration = process.env.MONGODB_URI?.includes('/pandas_license_test_') ? describe : describe.skip;
integration('serverless database connection lifecycle', () => {
  const legacyGlobal = globalThis as typeof globalThis & { __pandasMongo?: Promise<typeof mongoose> };
  after(async () => {
    delete legacyGlobal.__pandasMongo;
    if (mongoose.connection.readyState === 1) {
      assert.match(mongoose.connection.name, /^pandas_license_test_/);
      await mongoose.connection.dropDatabase();
    }
    await mongoose.disconnect();
  });

  test('a cached promise from another mongoose instance cannot mark this connection ready', async () => {
    legacyGlobal.__pandasMongo = Promise.resolve(new mongoose.Mongoose() as typeof mongoose);
    const connected = await connectDb();
    assert.ok(connected === mongoose, 'must connect the mongoose instance owning the route models');
    assert.equal(Business.db.readyState, 1);
  });

  test('concurrent calls after disconnect wait for the current connection', async () => {
    await mongoose.disconnect();
    const connections = await Promise.all([connectDb(), connectDb(), connectDb()]);
    assert.ok(connections.every(value => value === mongoose));
    assert.equal(Business.db.readyState, 1);
    assert.equal(new Set(connections.map(value => value.connection.getClient())).size, 1);
  });

  test('suspension and reactivation start sessions on the connected models after disconnect', async () => {
    await connectDb();
    assert.equal(Business.db.readyState, 1);
    await Business.init(); await SubscriptionEvent.init();
    const business = await Business.create({ name: 'Connection lifecycle fixture', planKey: 'basic', billingType: 'perpetual',
      contractVersion: 2, expiryPolicy: 'keep_working', supportExpiresAt: new Date('2030-01-01T00:00:00Z') });
    for (const status of ['suspended', 'active']) {
      await mongoose.disconnect();
      await withMongoTransaction(async session => {
        assert.ok(session, 'management changes must remain transactional');
        const row = await Business.findById(business._id).session(session);
        assert.ok(row);
        row.configuredStatus = status; row.revision += 1; await row.save({ session });
        await SubscriptionEvent.create([{ businessId: row._id, type: 'contract_adjusted', actorType: 'admin',
          actorId: 'connection-test', reason: `Test ${status}`, after: { configuredStatus: status } }], { session });
      });
      const saved = await Business.findById(business._id);
      assert.equal(saved!.configuredStatus, status);
      assert.equal(saved!.supportExpiresAt!.toISOString(), '2030-01-01T00:00:00.000Z');
    }
    assert.equal(await SubscriptionEvent.countDocuments({ businessId: business._id }), 2);
  });
});
