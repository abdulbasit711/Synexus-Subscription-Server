import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getAdminSession } from '@/lib/admin-auth';
import { connectDb } from '@/lib/db';
import { Business, Installation, SubscriptionEvent } from '@/lib/models';
import { withMongoTransaction } from '@/lib/transaction';
import { ok, fail } from '@/lib/http';
const schema = z.object({ username: z.string().trim().toLowerCase().min(2).max(100), reason: z.string().trim().min(3), password: z.string().min(12).max(72).optional() });
export async function PATCH(request: Request, context: { params: Promise<{ businessId: string }> }) {
  const admin = await getAdminSession(); if (!admin || admin.role === 'viewer') return fail('Forbidden', 403);
  try {
    await connectDb(); const input = schema.parse(await request.json()); const { businessId } = await context.params;
    const passwordHash = input.password ? await bcrypt.hash(input.password, 10) : null;
    await withMongoTransaction(async session => {
      const business = await Business.findById(businessId).select('+ownerBootstrap').session(session);
      if (!business?.ownerBootstrap || business.provisioningMode !== 'provision') throw new Error('No pending owner bootstrap profile exists');
      if (await Installation.exists({ businessId, provisioningCompleteAt: { $ne: null } }).session(session)) throw new Error('Provisioning is complete; existing local credentials are managed by the owner');
      business.ownerBootstrap = { ...business.ownerBootstrap, username: input.username, ...(passwordHash ? { passwordHash } : {}) };
      business.markModified('ownerBootstrap'); await business.save({ session });
      await SubscriptionEvent.create([{ businessId, type: 'bootstrap_profile_corrected', actorType: 'admin', actorId: admin.sub, reason: input.reason, after: { username: input.username } }], { session: session || undefined });
    });
    return ok({ updated: true });
  } catch (error) { return fail(error instanceof Error ? error.message : 'Profile correction failed'); }
}
