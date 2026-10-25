import { z } from "zod";
import { getAdminSession } from "@/lib/admin-auth";
import { connectDb } from "@/lib/db";
import { Business, Plan, SubscriptionEvent } from "@/lib/models";
import { fail, ok } from "@/lib/http";
import { registrationSchema, registerBusiness } from "@/lib/management";
const schema = z.object({
  name: z.string().min(2), externalReference: z.string().optional(), planKey: z.enum(["basic", "premium", "enterprise"]),
  billingType: z.enum(["monthly", "annual", "perpetual", "complimentary"]), paidThrough: z.string().datetime().nullable().optional(),
  negotiatedPrice: z.number().nonnegative().nullable().optional(), productEdition: z.string().default("current"),
  grantedFeatures: z.array(z.string()).default([]), grantedAddOns: z.array(z.string()).default([]), userLimit: z.number().int().positive().default(1), agreementNotes: z.string().default("")
});
export async function GET() {
  const admin = await getAdminSession(); if (!admin) return fail("Unauthorized", 401);
  await connectDb(); return ok(await Business.find().sort({ createdAt: -1 }).lean());
}
export async function POST(request: Request) {
  const admin = await getAdminSession(); if (!admin || admin.role === "viewer") return fail("Forbidden", 403);
  try {
    await connectDb(); const raw = await request.json();
    if (raw.contractVersion === 2) return ok(await registerBusiness(registrationSchema.parse(raw), admin.sub), 201);
    const input = schema.parse(raw); const plan = await Plan.findOne({ key: input.planKey });
    if (!plan) return fail("Plan must be configured first", 409);
    const business = await Business.create({ ...input, paidThrough: input.paidThrough ? new Date(input.paidThrough) : null, configuredStatus: "active" });
    await SubscriptionEvent.create({ businessId: business._id, type: "business_created", actorType: "admin", actorId: admin.sub, after: business.toObject() });
    return ok(business, 201);
  } catch (error) { return fail(error instanceof Error ? error.message : "Creation failed", 400); }
}
