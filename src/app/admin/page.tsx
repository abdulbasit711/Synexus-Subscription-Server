import { getAdminSession } from "@/lib/admin-auth";
import { connectDb } from "@/lib/db";
import { Business, PaymentOrder, Plan } from "@/lib/models";
import { AdminClient } from "./ui";
import { ensureDefaultPlans } from "@/lib/catalog";
export default async function AdminPage() {
  const session = await getAdminSession(); if (!session) return <AdminClient authenticated={false} businesses={[]} plans={[]} payments={[]} />;
  await connectDb(); await ensureDefaultPlans(); const [businesses, plans, payments] = await Promise.all([Business.find().sort({ createdAt: -1 }).lean(), Plan.find().lean(), PaymentOrder.find().sort({ createdAt: -1 }).limit(100).lean()]);
  return <AdminClient authenticated role={session.role} businesses={JSON.parse(JSON.stringify(businesses))} plans={JSON.parse(JSON.stringify(plans))} payments={JSON.parse(JSON.stringify(payments))} />;
}
