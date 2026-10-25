import { addDays } from "./time";
import { Business, Entitlement, Installation, Plan } from "./models";
import { deriveStatus } from "./contracts";
import { signEntitlement } from "./crypto";
import { supportActive } from "./catalog";

export async function issueEntitlement(installationId: string, allowRevoked = false) {
  const installation = await Installation.findById(installationId);
  if (!installation || (!allowRevoked && installation.status !== "active")) throw new Error("Installation is not active");
  const business = await Business.findById(installation.businessId);
  if (!business) throw new Error("Business not found");
  const plan = await Plan.findOne({ key: business.planKey });
  const now = new Date();
  if (business.contractVersion === 2) {
    const supported = supportActive(business.supportExpiresAt, now);
    const status = installation.status === "revoked" || business.configuredStatus === "suspended" ? "suspended"
      : business.expiryPolicy === "read_only" && !supported ? "expired" : "active";
    const payload = {
      version: 2, revision: business.revision, businessId: String(business._id), installationId: String(installation._id),
      deploymentId: installation.deploymentId, localBusinessId: installation.localBusinessId, businessName: business.name,
      planKey: business.planKey, userLimit: business.userLimit, features: business.grantedFeatures.length ? business.grantedFeatures : plan?.features || [],
      addOns: business.grantedAddOns, status, accessStatus: status === "active" ? "active" : "read_only",
      supportStatus: supported ? "active" : "expired", supportExpiresAt: business.supportExpiresAt?.toISOString() || null,
      expiryPolicy: business.expiryPolicy, annualSupportPrice: business.annualSupportPrice, installationPrice: business.installationPrice,
      requestedPlan: business.requestedPlan ? { id: business.requestedPlan.id, planKey: business.requestedPlan.planKey, userLimit: business.requestedPlan.userLimit } : null,
      currency: "PKR", issuedAt: now.toISOString(), offlineValidUntil: addDays(now, 30).toISOString()
    };
    const token = signEntitlement(payload);
    await Entitlement.create({ businessId: business._id, installationId: installation._id, token, status, issuedAt: now, offlineValidUntil: addDays(now, 30) });
    installation.lastSeenAt = now; await installation.save();
    return { token, entitlement: payload };
  }
  const status = deriveStatus({ billingType: business.billingType as never, configuredStatus: business.configuredStatus as never, paidThrough: business.paidThrough });
  const perpetual = business.billingType === "perpetual";
  const offlineValidUntil = perpetual ? null : addDays(now, 3);
  const payload = {
    version: 1, businessId: String(business._id), installationId: String(installation._id), businessName: business.name,
    planKey: business.planKey, billingType: business.billingType, status, paidThrough: business.paidThrough?.toISOString() || null,
    price: business.negotiatedPrice ?? (business.billingType === "annual" ? plan?.annualPrice : plan?.monthlyPrice) ?? null,
    currency: "PKR", features: business.grantedFeatures.length ? business.grantedFeatures : plan?.features || [],
    addOns: business.grantedAddOns, userLimit: business.userLimit || plan?.userLimit || 1, productEdition: business.productEdition,
    issuedAt: now.toISOString(), offlineValidUntil: offlineValidUntil?.toISOString() || null
  };
  const token = signEntitlement(payload);
  await Entitlement.create({ businessId: business._id, installationId: installation._id, token, status, issuedAt: now, offlineValidUntil });
  installation.lastSeenAt = now; await installation.save();
  return { token, entitlement: payload };
}
