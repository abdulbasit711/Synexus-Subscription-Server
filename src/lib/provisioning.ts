import { Business, Installation, SubscriptionEvent } from "./models";
import { signEntitlement, sha256, verifyMachineSignature } from "./crypto";
import { calculatePaidThrough } from "./contracts";
import { withMongoTransaction } from "./transaction";
import { ActivationCode } from "./models";
import type { NextRequest } from "next/server";
import { z } from "zod";

export const activationSchema = z.object({ protocolVersion: z.literal(2), activationCode: z.string().min(10).max(200),
  publicKey: z.string().includes("BEGIN PUBLIC KEY").max(1000), deploymentId: z.string().uuid(),
  localBusinessId: z.string().regex(/^[a-f\d]{24}$/i), mode: z.enum(["provision", "enroll"]), label: z.string().max(100).default("ERP"),
  expectedBusinessId: z.string().optional(), existingBusinessName: z.string().max(200).optional() });
export async function claimInstallation(request: NextRequest, raw: string) {
  const input = activationSchema.parse(JSON.parse(raw));
  if (!verifyMachineSignature({ publicKey: input.publicKey, body: raw, timestamp: request.headers.get("x-timestamp") || "", nonce: request.headers.get("x-nonce") || "", signature: request.headers.get("x-signature") || "" })) throw new Error("Invalid activation signature");
  return withMongoTransaction(async session => {
    const code = await ActivationCode.findOne({ codeHash: sha256(input.activationCode) }).session(session);
    if (!code) throw new Error("Activation code is invalid, used, or expired");
    if (code.usedAt) {
      const existing = await Installation.findById(code.usedByInstallationId).session(session);
      if (existing?.protocolVersion === 2 && existing.status === "active" && existing.publicKey === input.publicKey && existing.deploymentId === input.deploymentId && existing.localBusinessId === input.localBusinessId) return String(existing._id);
      throw new Error("Activation code has already been used");
    }
    if (code.invalidatedAt || code.expiresAt <= new Date()) throw new Error("Activation code is invalid, used, or expired");
    const business = await Business.findById(code.businessId).session(session);
    if (!business || business.contractVersion !== 2 || !business.expiryPolicy) throw new Error("This client agreement requires review in Synexus before enrollment");
    if (input.expectedBusinessId && String(business._id) !== input.expectedBusinessId) throw new Error("This code belongs to a different cloud client");
    if (input.mode === 'enroll' && !input.expectedBusinessId && business.name.trim().toLowerCase().replace(/\s+/g, ' ') !== input.existingBusinessName?.trim().toLowerCase().replace(/\s+/g, ' ')) throw new Error("Business name does not match the cloud registration; correct it in Synexus before enrollment");
    if (business.provisioningMode !== input.mode) throw new Error("This code is for a different setup mode");
    if (business.activationGeneration !== code.generation) throw new Error("A newer activation code has been issued");
    if (await Installation.exists({ businessId: business._id, status: "active" }).session(session)) throw new Error("This business already has an active installation; use installation transfer");
    const [installation] = await Installation.create([{ businessId: business._id, publicKey: input.publicKey, label: input.label,
      protocolVersion: 2, deploymentId: input.deploymentId, localBusinessId: input.localBusinessId }], { session: session || undefined });
    code.usedAt = new Date(); code.usedByInstallationId = installation._id; await code.save({ session });
    business.activeInstallationId = installation._id; await business.save({ session });
    await SubscriptionEvent.create([{ businessId: business._id, type: "installation_claimed", actorType: "system", actorId: String(installation._id), metadata: { deploymentId: input.deploymentId, mode: input.mode } }], { session: session || undefined });
    return String(installation._id);
  });
}
export async function provisioningManifest(installationId: string) {
  const installation = await Installation.findById(installationId);
  if (!installation || installation.status !== "active") throw new Error("Installation is not active");
  const business = await Business.findById(installation.businessId).select("+ownerBootstrap");
  if (!business || business.contractVersion !== 2) throw new Error("Agreement requires review");
  if (installation.provisioningCompleteAt) throw new Error("Provisioning is already complete");
  if (business.provisioningMode === "provision" && !business.ownerBootstrap?.passwordHash) throw new Error("Provisioning profile is unavailable; contact PANDAS");
  return { token: signEntitlement({ kind: "provisioning", version: 2, installationId, businessId: String(business._id), deploymentId: installation.deploymentId,
    localBusinessId: installation.localBusinessId, mode: business.provisioningMode, name: business.name, region: business.region,
    owner: business.provisioningMode === "provision" ? business.ownerBootstrap : null, issuedAt: new Date().toISOString() }) };
}
export async function completeProvisioning(installationId: string) {
  await withMongoTransaction(async session => {
    const installation = await Installation.findById(installationId).session(session);
    if (!installation || installation.status !== "active") throw new Error("Installation is not active");
    if (installation.provisioningCompleteAt) return;
    const business = await Business.findById(installation.businessId).session(session);
    if (!business || business.contractVersion !== 2) throw new Error("Agreement requires review");
    const now = new Date();
    if (!business.firstActivatedAt) {
      business.firstActivatedAt = now;
      if (business.provisioningMode === "provision") business.supportExpiresAt = calculatePaidThrough(null, now, "annual");
      business.revision += 1;
    }
    installation.provisioningCompleteAt = now;
    await installation.save({ session }); await business.save({ session });
    await SubscriptionEvent.create([{ businessId: business._id, type: "provisioning_completed", actorType: "system", actorId: installationId,
      after: { supportExpiresAt: business.supportExpiresAt, localBusinessId: installation.localBusinessId } }], { session: session || undefined });
  });
}
