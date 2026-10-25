import { z } from "zod";
import { getAdminSession } from "@/lib/admin-auth";
import { connectDb } from "@/lib/db";
import { PLAN_KEYS } from "@/lib/catalog";
import { paymentSchema, changePlan } from "@/lib/management";
import { Business, SubscriptionEvent } from "@/lib/models";
import { withMongoTransaction } from "@/lib/transaction";
import { fail, ok } from "@/lib/http";
export async function POST(request: Request, context: { params: Promise<{ businessId: string }> }) {
  const admin = await getAdminSession(); if (!admin || admin.role === "viewer") return fail("Forbidden", 403);
  try { await connectDb(); const { businessId } = await context.params; return ok(await changePlan(businessId, paymentSchema.extend({ planKey: z.enum(PLAN_KEYS) }).parse(await request.json()), admin.sub)); }
  catch (error) { return fail(error instanceof Error ? error.message : "Plan change failed"); }
}
export async function DELETE(request: Request, context: { params: Promise<{ businessId: string }> }) {
  const admin = await getAdminSession(); if (!admin || admin.role === "viewer") return fail("Forbidden", 403);
  try {
    const { reason } = z.object({ reason: z.string().trim().min(3) }).parse(await request.json()); await connectDb(); const { businessId } = await context.params;
    return ok(await withMongoTransaction(async session => {
      const business = await Business.findById(businessId).session(session); if (!business) throw new Error("Business not found");
      const before = business.requestedPlan; business.requestedPlan = null; business.revision += 1; await business.save({ session });
      await SubscriptionEvent.create([{ businessId, type: "downgrade_cancelled", actorType: "admin", actorId: admin.sub, reason, before }], { session: session || undefined }); return business;
    }));
  } catch (error) { return fail(error instanceof Error ? error.message : "Cancellation failed"); }
}
