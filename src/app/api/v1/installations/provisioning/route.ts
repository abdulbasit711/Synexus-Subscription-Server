import { NextRequest } from "next/server";
import { connectDb } from "@/lib/db";
import { authenticateMachine } from "@/lib/machine-auth";
import { provisioningManifest, completeProvisioning } from "@/lib/provisioning";
import { issueEntitlement } from "@/lib/entitlements";
import { fail, ok } from "@/lib/http";
export async function POST(request: NextRequest) {
  try {
    await connectDb(); const body = await request.text(); const installation = await authenticateMachine(request, body);
    if (!installation || installation.protocolVersion !== 2) return fail("Invalid installation signature", 401);
    const input = JSON.parse(body);
    if (input.action === "complete") { await completeProvisioning(String(installation._id)); return ok(await issueEntitlement(String(installation._id))); }
    if (input.action !== "manifest") return fail("Unknown provisioning action", 400);
    return ok(await provisioningManifest(String(installation._id)));
  } catch (error) { return fail(error instanceof Error ? error.message : "Provisioning failed", 400); }
}
