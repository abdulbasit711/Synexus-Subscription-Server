import { NextRequest } from 'next/server';
import { connectDb } from '@/lib/db';
import { authenticateMachine } from '@/lib/machine-auth';
import { machineBackupDestination } from '@/lib/backup';
import { issueEntitlement } from '@/lib/entitlements';
import { ok, fail } from '@/lib/http';
export async function POST(request: NextRequest) {
  try {
    await connectDb(); const body = await request.text(); const installation = await authenticateMachine(request, body);
    if (!installation || installation.protocolVersion !== 2) return fail('Invalid installation signature', 401);
    const { entitlement } = await issueEntitlement(String(installation._id));
    if (entitlement.status !== 'active') return fail('Business is read-only', 403);
    const response = ok(await machineBackupDestination(installation.businessId));
    response.headers.set('Cache-Control', 'no-store'); return response;
  } catch { return fail('Backup destination unavailable. Check this client’s backup settings in Synexus', 400); }
}
