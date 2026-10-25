import type { ClientSession } from "mongoose";
import { ActivationCode, Business, SubscriptionEvent } from "./models";
import { randomCode, sha256 } from "./crypto";
import { addDays } from "./time";

// Call inside the same transaction as registration/transfer/reissue.
export async function createActivationCode(businessId: unknown, actorId: string, session: ClientSession | null, reason: string) {
  const options = { session: session || undefined };
  const business = await Business.findByIdAndUpdate(businessId, { $inc: { activationGeneration: 1 } }, { ...options, new: true });
  if (!business) throw new Error("Business not found");
  await ActivationCode.updateMany({ businessId, usedAt: null, invalidatedAt: null }, { $set: { invalidatedAt: new Date() } }, options);
  const activationCode = randomCode(), expiresAt = addDays(new Date(), 7);
  await ActivationCode.create([{ businessId, codeHash: sha256(activationCode), generation: business.activationGeneration, expiresAt, createdBy: actorId }], options);
  await SubscriptionEvent.create([{ businessId, type: "activation_code_issued", actorType: "admin", actorId, reason }], options);
  return { activationCode, expiresAt };
}
