import { z } from "zod";
import bcrypt from "bcryptjs";
import { Business, Plan, ManualPayment, SubscriptionEvent } from "./models";
import { PLAN_KEYS, ensureDefaultPlans, upgradeCharge } from "./catalog";
import { calculatePaidThrough } from "./contracts";
import { createActivationCode } from "./activation-codes";
import { withMongoTransaction } from "./transaction";
import type { ClientSession } from "mongoose";

export const registrationSchema = z.object({
  contractVersion: z.literal(2), name: z.string().trim().min(2).max(200), region: z.string().trim().min(2).max(200),
  externalReference: z.string().max(200).default(""), planKey: z.enum(PLAN_KEYS),
  provisioningMode: z.enum(["provision", "enroll"]), expiryPolicy: z.enum(["keep_working", "read_only"]),
  supportExpiresAt: z.string().datetime().nullable().optional(), agreementNotes: z.string().max(4000).default(""),
  owner: z.object({ username: z.string().trim().toLowerCase().min(2).max(100), firstname: z.string().trim().min(1).max(100),
    lastname: z.string().trim().max(100).default(""), email: z.union([z.email(), z.literal("")]).default(""),
    mobileno: z.array(z.string().trim().min(1).max(30)).min(1), password: z.string().min(12).max(72) }).optional()
}).superRefine((value, ctx) => {
  if (value.provisioningMode === "provision" && !value.owner) ctx.addIssue({ code: "custom", message: "Owner profile and initial password are required", path: ["owner"] });
  if (value.provisioningMode === "enroll" && value.supportExpiresAt === undefined) ctx.addIssue({ code: "custom", message: "Existing support end date must be explicitly reviewed (or set to null)", path: ["supportExpiresAt"] });
});
export async function registerBusiness(input: z.infer<typeof registrationSchema>, actorId: string) {
  await ensureDefaultPlans();
  const owner = input.owner ? { ...input.owner, password: undefined, passwordHash: await bcrypt.hash(input.owner.password, 10) } : undefined;
  return withMongoTransaction(async session => {
    const plan = await Plan.findOne({ key: input.planKey, active: true }).session(session);
    if (!plan) throw new Error("Plan is not available");
    const [business] = await Business.create([{
      ...input, owner: undefined, ownerBootstrap: owner, billingType: "perpetual", configuredStatus: "active",
      supportExpiresAt: input.provisioningMode === "enroll" && input.supportExpiresAt ? new Date(input.supportExpiresAt) : null,
      installationPrice: plan.installationPrice, initialInstallationPrice: plan.installationPrice, annualSupportPrice: plan.annualPrice, userLimit: plan.userLimit
    }], { session: session || undefined });
    await SubscriptionEvent.create([{ businessId: business._id, type: "business_registered", actorType: "admin", actorId,
      after: { name: business.name, planKey: business.planKey, expiryPolicy: business.expiryPolicy, provisioningMode: business.provisioningMode, installationPrice: business.installationPrice } }], { session: session || undefined });
    return { business: publicBusiness(business), ...(await createActivationCode(business._id, actorId, session, "Client registration")) };
  });
}
export function publicBusiness(value: { toObject?: () => unknown } | unknown) {
  const row = (value && typeof value === "object" && "toObject" in value && typeof value.toObject === "function" ? value.toObject() : value) as Record<string, unknown>;
  const { ownerBootstrap: _secret, ...safe } = row;
  return safe;
}
export const paymentSchema = z.object({
  requestId: z.string().uuid(), amount: z.number().nonnegative(), discount: z.number().nonnegative().default(0),
  method: z.enum(["cash", "bank_transfer", "other", "waiver"]), reference: z.string().max(200).default(""),
  reason: z.string().trim().min(3).max(2000), paidAt: z.string().datetime()
});
export type PaymentInput = z.infer<typeof paymentSchema>;
export async function recordPayment(businessId: unknown, purpose: string, expectedAmount: number, input: PaymentInput, actorId: string, session: ClientSession | null) {
  if (Math.abs(input.amount + input.discount - expectedAmount) > 0.005) throw new Error(`Payment plus discount must equal PKR ${expectedAmount}`);
  if (input.method === "waiver" && input.amount !== 0) throw new Error("A waiver must have a zero payment amount");
  const [payment] = await ManualPayment.create([{ ...input, paidAt: new Date(input.paidAt), businessId, purpose, expectedAmount, actorId }], { session: session || undefined });
  return payment;
}
export async function renewSupport(businessId: string, input: PaymentInput & { terms: number }, actorId: string) {
  return withMongoTransaction(async session => {
    const business = await Business.findById(businessId).session(session);
    if (!business || business.contractVersion !== 2) throw new Error("Review and migrate this agreement before renewing support");
    if (await ManualPayment.exists({ businessId, requestId: input.requestId }).session(session)) return publicBusiness(business);
    if (!business.firstActivatedAt && business.provisioningMode === "provision") throw new Error("First support year starts at activation; it is already included");
    const before = business.supportExpiresAt;
    await recordPayment(businessId, "support", business.annualSupportPrice * input.terms, input, actorId, session);
    business.supportExpiresAt = calculatePaidThrough(before, new Date(input.paidAt), "annual", input.terms);
    business.revision += 1;
    // Renewal never changes configuredStatus: suspension requires an explicit administrative action.
    await business.save({ session });
    await SubscriptionEvent.create([{ businessId, type: "support_renewed", actorType: "admin", actorId, reason: input.reason,
      before: { supportExpiresAt: before }, after: { supportExpiresAt: business.supportExpiresAt }, metadata: { requestId: input.requestId, terms: input.terms } }], { session: session || undefined });
    return publicBusiness(business);
  });
}
export async function changePlan(businessId: string, input: PaymentInput & { planKey: typeof PLAN_KEYS[number] }, actorId: string) {
  return withMongoTransaction(async session => {
    const business = await Business.findById(businessId).session(session);
    if (!business || business.contractVersion !== 2) throw new Error("Review and migrate this agreement before changing plans");
    if (await ManualPayment.exists({ businessId, requestId: input.requestId }).session(session)) return publicBusiness(business);
    if (business.requestedPlan) throw new Error("A downgrade is already pending; cancel it before requesting another change");
    const target = await Plan.findOne({ key: input.planKey, active: true }).session(session);
    if (!target || target.key === business.planKey) throw new Error("Choose a different available plan");
    const lower = PLAN_KEYS.indexOf(target.key as never) < PLAN_KEYS.indexOf(business.planKey as never);
    const charge = lower ? 0 : upgradeCharge(business.installationPrice, target.installationPrice);
    await recordPayment(businessId, "upgrade", charge, input, actorId, session);
    const before = { planKey: business.planKey, userLimit: business.userLimit };
    if (lower) {
      business.requestedPlan = { id: input.requestId, planKey: target.key, userLimit: target.userLimit,
        installationPrice: target.installationPrice, annualSupportPrice: target.annualPrice, features: target.features, requestedAt: new Date(), reason: input.reason };
    } else {
      business.planKey = target.key; business.userLimit = target.userLimit;
      business.installationPrice = target.installationPrice; business.annualSupportPrice = target.annualPrice;
      business.grantedFeatures = []; business.grantedAddOns = []; business.revision += 1;
    }
    await business.save({ session });
    await SubscriptionEvent.create([{ businessId, type: lower ? "downgrade_requested" : "plan_upgraded", actorType: "admin", actorId, reason: input.reason,
      before, after: { planKey: business.planKey, requestedPlan: business.requestedPlan, charge } }], { session: session || undefined });
    return publicBusiness(business);
  });
}
