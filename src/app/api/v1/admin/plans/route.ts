import { z } from "zod";
import { getAdminSession } from "@/lib/admin-auth";
import { connectDb } from "@/lib/db";
import { Plan } from "@/lib/models";
import { fail, ok } from "@/lib/http";
const schema = z.object({ key: z.enum(["basic", "premium", "enterprise"]), name: z.string().min(2), monthlyPrice: z.number().nonnegative().default(0), installationPrice: z.number().nonnegative(), annualPrice: z.number().nonnegative(), features: z.array(z.string()).default([]), addOns: z.array(z.string()).default([]), userLimit: z.number().int().positive() });
export async function GET() { if (!await getAdminSession()) return fail("Unauthorized", 401); await connectDb(); return ok(await Plan.find().sort({ monthlyPrice: 1 }).lean()); }
export async function PUT(request: Request) { const admin = await getAdminSession(); if (!admin || admin.role === "viewer") return fail("Forbidden", 403); await connectDb(); const input = schema.parse(await request.json()); return ok(await Plan.findOneAndUpdate({ key: input.key }, input, { upsert: true, new: true, runValidators: true })); }
