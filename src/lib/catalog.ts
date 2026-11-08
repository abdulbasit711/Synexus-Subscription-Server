import { Plan } from "./models";

export const PLAN_KEYS = ["basic", "premium", "enterprise"] as const;
export const PREMIUM_FEATURES = ["advancedReports", "productAnalytics", "advancedBarcodeDesigns", "whatsappMessages", "whatsappDailySummary", "aiChatbot"];
export const ENTERPRISE_FEATURES = [...PREMIUM_FEATURES, "cloudBackup", "removeWatermark", "customThermalLogo", "weeklyCustomerReminders"];
export const DEFAULT_PLANS = [
  { key: "basic", name: "Basic", installationPrice: 20000, annualPrice: 10000, monthlyPrice: 0, userLimit: 1, features: [] },
  { key: "premium", name: "Premium", installationPrice: 35000, annualPrice: 15000, monthlyPrice: 0, userLimit: 3, features: PREMIUM_FEATURES },
  { key: "enterprise", name: "Enterprise", installationPrice: 50000, annualPrice: 20000, monthlyPrice: 0, userLimit: 10, features: ENTERPRISE_FEATURES }
];
// Older catalogs stored empty feature arrays even for paid plans. Keep their
// negotiated prices and quotas while supplying the included plan capabilities.
export function planFeatures(plan: { key: string; features?: string[] | null }) {
  return plan.features?.length ? plan.features : DEFAULT_PLANS.find(item => item.key === plan.key)?.features || [];
}
export async function ensureDefaultPlans() {
  for (const plan of DEFAULT_PLANS) {
    await Plan.updateOne({ key: plan.key }, { $setOnInsert: plan }, { upsert: true });
    if (plan.features.length) await Plan.updateOne({ key: plan.key, $or: [{ features: { $exists: false } }, { features: null }, { features: { $size: 0 } }] }, { $set: { features: plan.features } });
  }
}
export function upgradeCharge(current: number, target: number) { return Math.max(0, target - current); }
export function supportActive(expiresAt: Date | string | null | undefined, now = new Date()) {
  return !!expiresAt && new Date(expiresAt).getTime() > now.getTime();
}
