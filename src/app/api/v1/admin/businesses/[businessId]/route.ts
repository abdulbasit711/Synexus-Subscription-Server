import { z } from "zod";
import { getAdminSession } from "@/lib/admin-auth";
import { connectDb } from "@/lib/db";
import { Business, Plan, SubscriptionEvent, Installation, ManualPayment } from "@/lib/models";
import { withMongoTransaction } from "@/lib/transaction";
import { fail, ok } from "@/lib/http";
const schema = z.object({ configuredStatus: z.enum(["active", "suspended", "legacy_unmanaged"]).optional(),
  paidThrough: z.string().datetime().nullable().optional(), negotiatedPrice: z.number().nonnegative().nullable().optional(), agreementNotes: z.string().max(4000).optional(),
  reason: z.string().trim().min(3), contractVersion: z.literal(2).optional(), expiryPolicy: z.enum(["keep_working", "read_only"]).optional(),
  supportExpiresAt: z.string().datetime().nullable().optional(), region: z.string().trim().min(2).optional(), name: z.string().trim().min(2).max(200).optional() });
export async function PATCH(request: Request, context: { params: Promise<{ businessId: string }> }) {
  const admin = await getAdminSession(); if (!admin || admin.role === "viewer") return fail("Forbidden", 403);
  try {
    await connectDb(); const input = schema.parse(await request.json()); const { businessId } = await context.params;
    return ok(await withMongoTransaction(async session => {
      const business = await Business.findById(businessId).session(session); if (!business) throw new Error("Business not found");
      const before = business.toObject();
      if (business.contractVersion !== 2 && input.contractVersion === 2) {
        if (!input.expiryPolicy || input.supportExpiresAt === undefined || !input.region) throw new Error("Explicit support dates, expiry policy and business region are required for migration");
        const plan = await Plan.findOne({ key: business.planKey }).session(session); if (!plan) throw new Error("Configure the plan first");
        business.contractVersion = 2; business.provisioningMode = "enroll";
        business.installationPrice = plan.installationPrice; business.initialInstallationPrice ??= plan.installationPrice; business.annualSupportPrice = plan.annualPrice;
        // Existing negotiated user limits and historical payments are retained.
      }
      if (business.contractVersion === 2 && input.configuredStatus === "legacy_unmanaged") throw new Error("Managed agreements cannot bypass verification");
      if (input.configuredStatus) business.configuredStatus = input.configuredStatus;
      if (input.expiryPolicy) business.expiryPolicy = input.expiryPolicy;
      if (input.region) business.region = input.region;
      if (input.name) business.name = input.name;
      if (input.supportExpiresAt !== undefined) business.supportExpiresAt = input.supportExpiresAt ? new Date(input.supportExpiresAt) : null;
      if (input.paidThrough !== undefined && business.contractVersion !== 2) business.paidThrough = input.paidThrough ? new Date(input.paidThrough) : null;
      if (input.negotiatedPrice !== undefined) business.negotiatedPrice = input.negotiatedPrice;
      if (input.agreementNotes !== undefined) business.agreementNotes = input.agreementNotes;
      business.revision += 1; await business.save({ session });
      await SubscriptionEvent.create([{ businessId, type: "contract_adjusted", actorType: "admin", actorId: admin.sub, reason: input.reason, before, after: business.toObject() }], { session: session || undefined });
      return business;
    }));
  } catch (error) { return fail(error instanceof Error ? error.message : "Update failed"); }
}

export async function GET(_request: Request, context: { params: Promise<{ businessId: string }> }) {
  if (!await getAdminSession()) return fail("Unauthorized", 401);
  await connectDb(); const { businessId } = await context.params;
  const business = await Business.findById(businessId).lean(); if (!business) return fail("Business not found", 404);
  const [installations, payments, events] = await Promise.all([
    Installation.find({ businessId }).select('-publicKey -recentNonces').sort({ createdAt: -1 }).lean(),
    ManualPayment.find({ businessId }).sort({ paidAt: -1 }).lean(),
    SubscriptionEvent.find({ businessId }).select('-before.ownerBootstrap -after.ownerBootstrap').sort({ createdAt: -1 }).limit(100).lean()
  ]);
  return ok({ business, installations, payments, events });
}
