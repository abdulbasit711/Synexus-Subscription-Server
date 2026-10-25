import { getAdminSession } from "@/lib/admin-auth";
import { connectDb } from "@/lib/db";
import { Business } from "@/lib/models";
import { createActivationCode } from "@/lib/activation-codes";
import { withMongoTransaction } from "@/lib/transaction";
import { fail, ok } from "@/lib/http";
export async function POST(request: Request, context: { params: Promise<{ businessId: string }> }) {
  const admin = await getAdminSession(); if (!admin || admin.role === "viewer") return fail("Forbidden", 403);
  try {
    const { reason } = await request.json(); if (String(reason || "").trim().length < 3) return fail("A reason is required");
    await connectDb(); const { businessId } = await context.params;
    const business = await Business.findById(businessId); if (!business) return fail("Business not found", 404);
    if (business.activeInstallationId) return fail("Use installation transfer for an already claimed installation", 409);
    return ok(await withMongoTransaction(session => createActivationCode(businessId, admin.sub, session, reason)), 201);
  } catch (error) { return fail(error instanceof Error ? error.message : "Code generation failed"); }
}
