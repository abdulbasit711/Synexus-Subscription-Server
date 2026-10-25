import { NextRequest } from "next/server";
import { Installation, MachineNonce } from "./models";
import { verifyMachineSignature } from "./crypto";

export async function authenticateMachine(request: NextRequest, body: string, allowRevoked = false) {
  const installationId = request.headers.get("x-installation-id") || "";
  const installation = await Installation.findById(installationId);
  if (!installation || (!allowRevoked && installation.status !== "active")) return null;
  const valid = verifyMachineSignature({
    publicKey: installation.publicKey, body,
    timestamp: request.headers.get("x-timestamp") || "",
    nonce: request.headers.get("x-nonce") || "",
    signature: request.headers.get("x-signature") || ""
  });
  if (!valid) return null;
  const nonce = request.headers.get("x-nonce") || "";
  if (!/^[a-f\d-]{36}$/i.test(nonce)) return null;
  try { await MachineNonce.create({ installationId: installation._id, nonce, expiresAt: new Date(Date.now() + 10 * 60000) }); }
  catch (error) { if ((error as { code?: number }).code === 11000) return null; throw error; }
  return installation;
}
