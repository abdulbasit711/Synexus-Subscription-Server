import { getAdminSession } from '@/lib/admin-auth';
import { backupSchema, configureBackup } from '@/lib/backup';
import { ok, fail } from '@/lib/http';
export async function PUT(request: Request, context: { params: Promise<{ businessId: string }> }) {
  const admin = await getAdminSession(); if (admin?.role !== 'owner') return fail('Owner access required', 403);
  try { const input = backupSchema.parse(await request.json()); const { businessId } = await context.params; return ok(await configureBackup(businessId, input, admin.sub)); }
  catch (error) { return fail(error instanceof Error ? error.message : 'Backup configuration failed'); }
}
