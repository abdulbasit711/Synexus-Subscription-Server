// Test-only adapter: never imported by the Next application.
import http from 'node:http';
import mongoose from 'mongoose';
import { NextRequest } from 'next/server';
import { connectDb } from '../lib/db';
import { registrationSchema, registerBusiness, paymentSchema, changePlan, renewSupport } from '../lib/management';
import { createActivationCode } from '../lib/activation-codes';
import { withMongoTransaction } from '../lib/transaction';
import { Business, Installation, Plan, ActivationCode } from '../lib/models';
import { POST as activate } from '../app/api/v1/installations/activate/route';
import { POST as provisioning } from '../app/api/v1/installations/provisioning/route';
import { POST as refresh } from '../app/api/v1/entitlements/refresh/route';
import { z } from 'zod';
if (process.env.NODE_ENV !== 'test' || !process.env.MONGODB_URI?.includes('/pandas_license_test_')) throw new Error('Test adapter requires an isolated test database');
async function main() {
await connectDb(); await Promise.all([Business.init(), Installation.init(), Plan.init(), ActivationCode.init()]);
const actor = new mongoose.Types.ObjectId().toString(); let dropNextActivation = false, corruptNext = false, dropManifest = false;
const server = http.createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = Buffer.concat(chunks).toString();
    const input = body ? JSON.parse(body) : {}; const url = new URL(request.url || '/', `http://127.0.0.1:${process.env.TEST_CLOUD_PORT}`);
    let data;
    if (url.pathname === '/__test/register') data = await registerBusiness(registrationSchema.parse(input), actor);
    else if (url.pathname === '/__test/change-plan') data = await changePlan(input.businessId, { ...paymentSchema.parse(input), planKey: input.planKey }, actor);
    else if (url.pathname === '/__test/renew') data = await renewSupport(input.businessId, { ...paymentSchema.parse(input), terms: input.terms || 1 }, actor);
    else if (url.pathname === '/__test/update') data = await Business.findByIdAndUpdate(input.businessId, { $set: input.update, $inc: { revision: 1 } }, { new: true });
    else if (url.pathname === '/__test/code') data = await withMongoTransaction(session => createActivationCode(input.businessId, actor, session, 'Integration test reissue'));
    else if (url.pathname === '/__test/snapshot') data = { business: await Business.findById(input.businessId), installations: await Installation.find({ businessId: input.businessId }).select('-publicKey -recentNonces') };
    else if (url.pathname === '/__test/revoke') { await Installation.updateMany({ businessId: input.businessId }, { $set: { status: 'revoked' } }); data = {}; }
    else if (url.pathname === '/__test/fault') { dropNextActivation = !!input.dropNextActivation; corruptNext = !!input.corruptNext; dropManifest = !!input.dropManifest; data = {}; }
    else {
      const route = ({ '/api/v1/installations/activate': activate, '/api/v1/installations/provisioning': provisioning, '/api/v1/entitlements/refresh': refresh } as Record<string, (r: NextRequest) => Promise<Response>>)[url.pathname];
      if (!route) { response.writeHead(404).end(); return; }
      if (dropManifest && url.pathname.endsWith('/provisioning') && input.action === 'manifest') { dropManifest = false; response.destroy(); return; }
      const result = await route(new NextRequest(url, { method: 'POST', headers: request.headers as Record<string, string>, body }));
      if (dropNextActivation && url.pathname.endsWith('/activate')) { dropNextActivation = false; response.destroy(); return; }
      let payload = await result.json();
      if (corruptNext && payload.data?.token) { corruptNext = false; payload.data.token += 'invalid'; }
      response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data }));
  } catch (error) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ message: error instanceof Error ? error.message : 'Test adapter error' })); }
});
server.listen(Number(process.env.TEST_CLOUD_PORT), '127.0.0.1', () => console.log('TEST_CLOUD_READY'));

}
main().catch(error => { console.error(error); process.exit(1); });
