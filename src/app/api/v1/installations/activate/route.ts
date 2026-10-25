import { NextRequest } from "next/server";
import { z } from "zod";
import { connectDb } from "@/lib/db";
import { ActivationCode, Business, Installation } from "@/lib/models";
import { sha256 } from "@/lib/crypto";
import { issueEntitlement } from "@/lib/entitlements";
import { fail, ok } from "@/lib/http";
import { withMongoTransaction } from "@/lib/transaction";

import { claimInstallation } from "@/lib/provisioning";
const schema = z.object({ activationCode: z.string().min(10), publicKey: z.string().includes("BEGIN PUBLIC KEY"), label: z.string().max(100).optional(), fingerprint: z.string().max(200).optional() });
export async function POST(request: NextRequest) {
  try {
    await connectDb(); const raw = await request.text();
    if (JSON.parse(raw).protocolVersion === 2) { const installationId = await claimInstallation(request, raw); return ok({ installationId, ...(await issueEntitlement(installationId)) }, 201); }
    const input = schema.parse(JSON.parse(raw));
    let installationId = "";
    await withMongoTransaction(async (session) => {
        const code = await ActivationCode.findOne({ codeHash: sha256(input.activationCode), usedAt: null, expiresAt: { $gt: new Date() } }).session(session);
        if (!code || code.invalidatedAt) throw new Error("Activation code is invalid, used, or expired");
        const business = await Business.findById(code.businessId).session(session);
        if (business?.contractVersion === 2) throw new Error("Update the ERP to enroll this agreement");
        const existing = await Installation.findOne({ businessId: code.businessId, status: "active" }).session(session);
        if (existing) throw new Error("This business already has an active ERP installation");
        const [installation] = await Installation.create([{ businessId: code.businessId, publicKey: input.publicKey, label: input.label, fingerprint: input.fingerprint }], { session: session || undefined });
        installationId = String(installation._id); code.usedAt = new Date(); code.usedByInstallationId = installation._id; await code.save({ session });
        await Business.updateOne({ _id: code.businessId }, { $set: { activeInstallationId: installation._id } }, { session: session || undefined });
    });
    return ok({ installationId, ...(await issueEntitlement(installationId)) }, 201);
  } catch (error) { return fail(error instanceof Error ? error.message : "Activation failed", 400); }
}
