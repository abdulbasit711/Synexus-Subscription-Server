import { getAdminSession } from '@/lib/admin-auth';
import { backupSchema, configureBackup, viewBackupDestination } from '@/lib/backup';
import { ok, fail } from '@/lib/http';
export async function GET(_request: Request, context: { params: Promise<{ businessId: string }> }) {
  const admin = await getAdminSession(); if (admin?.role !== 'owner') return fail('Owner access required', 403);
  try {
    const { businessId } = await context.params;
    const response = ok(await viewBackupDestination(businessId, admin.sub));
    response.headers.set('Cache-Control', 'no-store'); return response;
  } catch { return fail('Unable to reveal the saved Atlas connection. Check this client’s backup configuration.', 400); }
}
export async function PUT(request: Request, context: { params: Promise<{ businessId: string }> }) {
  const admin = await getAdminSession(); if (admin?.role !== 'owner') return fail('Owner access required', 403);
  try { const input = backupSchema.parse(await request.json()); const { businessId } = await context.params; return ok(await configureBackup(businessId, input, admin.sub)); }
  catch (error) { return fail(error instanceof Error ? error.message : 'Backup configuration failed'); }
}
