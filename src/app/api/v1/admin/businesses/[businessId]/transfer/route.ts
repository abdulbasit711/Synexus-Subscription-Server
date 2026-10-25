import { z } from "zod";
import { getAdminSession } from "@/lib/admin-auth";
import { connectDb } from "@/lib/db";
import { Business, Installation, SubscriptionEvent } from "@/lib/models";
import { createActivationCode } from "@/lib/activation-codes";
import { withMongoTransaction } from "@/lib/transaction";
import { fail, ok } from "@/lib/http";
export async function POST(request: Request, context: { params: Promise<{ businessId: string }> }) {
  const admin = await getAdminSession(); if (!admin || admin.role !== "owner") return fail("Owner access required", 403);
  try {
    const input = z.object({ reason: z.string().trim().min(3), mode: z.enum(["enroll", "provision"]).default("enroll") }).parse(await request.json());
    await connectDb(); const { businessId } = await context.params;
    return ok(await withMongoTransaction(async session => {
      const business = await Business.findById(businessId).select("+ownerBootstrap").session(session); if (!business) throw new Error("Business not found");
      if (input.mode === "provision" && !business.ownerBootstrap?.passwordHash) throw new Error("No bootstrap owner exists; transfer with the restored business database");
      await Installation.updateMany({ businessId, status: "active" }, { $set: { status: "revoked" } }, { session: session || undefined });
      business.activeInstallationId = null; business.provisioningMode = input.mode; business.revision += 1; await business.save({ session });
      await SubscriptionEvent.create([{ businessId, type: "installation_transfer", actorType: "admin", actorId: admin.sub, reason: input.reason }], { session: session || undefined });
      return createActivationCode(businessId, admin.sub, session, input.reason);
    }), 201);
  } catch (error) { return fail(error instanceof Error ? error.message : "Transfer failed"); }
}
