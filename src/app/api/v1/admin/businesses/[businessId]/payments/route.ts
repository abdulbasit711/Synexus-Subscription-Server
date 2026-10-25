import { z } from "zod";
import { getAdminSession } from "@/lib/admin-auth";
import { connectDb } from "@/lib/db";
import { Business, ManualPayment, SubscriptionEvent } from "@/lib/models";
import { paymentSchema, recordPayment } from "@/lib/management";
import { withMongoTransaction } from "@/lib/transaction";
import { fail, ok } from "@/lib/http";
export async function POST(request: Request, context: { params: Promise<{ businessId: string }> }) {
  const admin = await getAdminSession(); if (!admin || admin.role === "viewer") return fail("Forbidden", 403);
  try {
    await connectDb(); const input = paymentSchema.extend({ purpose: z.literal("installation") }).parse(await request.json()); const { businessId } = await context.params;
    return ok(await withMongoTransaction(async session => {
      const duplicate = await ManualPayment.findOne({ businessId, requestId: input.requestId }).session(session); if (duplicate) return duplicate;
      const business = await Business.findById(businessId).session(session); if (!business || business.contractVersion !== 2) throw new Error("Business agreement requires review");
      if (await ManualPayment.exists({ businessId, purpose: "installation" }).session(session)) throw new Error("Installation payment is already recorded");
      const payment = await recordPayment(businessId, "installation", business.initialInstallationPrice ?? business.installationPrice, input, admin.sub, session);
      await SubscriptionEvent.create([{ businessId, type: "installation_payment_recorded", actorType: "admin", actorId: admin.sub, reason: input.reason, metadata: { paymentId: payment._id } }], { session: session || undefined }); return payment;
    }), 201);
  } catch (error) { return fail(error instanceof Error ? error.message : "Payment recording failed"); }
}
