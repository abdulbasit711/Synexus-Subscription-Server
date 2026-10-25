import { NextRequest } from "next/server";
import { z } from "zod";
import { connectDb } from "@/lib/db";
import { authenticateMachine } from "@/lib/machine-auth";
import { issueEntitlement } from "@/lib/entitlements";
import { Business, Installation, SubscriptionEvent } from "@/lib/models";
import { withMongoTransaction } from "@/lib/transaction";
import { fail, ok } from "@/lib/http";
const reportSchema = z.object({ localBusinessId: z.string(), activeUserCount: z.number().int().nonnegative(), appliedRevision: z.number().int().nonnegative(),
  erpVersion: z.string().max(100), syncResult: z.string().max(500), lastError: z.string().max(500).optional(), readyForPlanId: z.string().uuid().nullable().optional() });
export async function POST(request: NextRequest) {
  try {
    await connectDb(); const body = await request.text(); const installation = await authenticateMachine(request, body, true);
    if (!installation) return fail("Invalid installation signature", 401);
    if (installation.status === 'revoked') return ok(await issueEntitlement(String(installation._id), true));
    if (installation.protocolVersion === 2) {
      const report = reportSchema.parse(JSON.parse(body));
      if (report.localBusinessId !== installation.localBusinessId) return fail("Business binding mismatch", 403);
      await withMongoTransaction(async session => {
        const binding = await Installation.findById(installation._id).session(session);
        if (!binding || binding.status !== "active") throw new Error("Installation has been revoked");
        binding.telemetry = report; binding.lastSeenAt = new Date(); await binding.save({ session });
        const business = await Business.findById(binding.businessId).session(session);
        if (!business) throw new Error("Business not found");
        const pending = business.requestedPlan;
        if (pending && report.readyForPlanId === pending.id && report.activeUserCount <= pending.userLimit) {
          business.planKey = pending.planKey; business.userLimit = pending.userLimit;
          business.installationPrice = pending.installationPrice; business.annualSupportPrice = pending.annualSupportPrice;
          business.grantedFeatures = []; business.grantedAddOns = []; business.requestedPlan = null; business.revision += 1;
          await business.save({ session });
          await SubscriptionEvent.create([{ businessId: business._id, type: "downgrade_committed", actorType: "system", actorId: String(binding._id), reason: pending.reason,
            after: { planKey: business.planKey, userLimit: business.userLimit }, metadata: { requestId: pending.id, activeUserCount: report.activeUserCount } }], { session: session || undefined });
        }
      });
    }
    return ok(await issueEntitlement(String(installation._id)));
  } catch (error) { return fail(error instanceof Error ? error.message : "Refresh failed", 400); }
}
