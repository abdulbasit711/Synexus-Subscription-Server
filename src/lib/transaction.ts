import { type ClientSession } from "mongoose";
import { connectDb } from "./db";

const uri = String(process.env.MONGODB_URI || "");
export const mongoTransactionsEnabled = process.env.MONGODB_TRANSACTIONS
  ? process.env.MONGODB_TRANSACTIONS !== "false"
  : !(/(?:localhost|127\.0\.0\.1)/i.test(uri) && !/[?&]replicaSet=/i.test(uri));

let warned = false;
export async function withMongoTransaction<T>(work: (session: ClientSession | null) => Promise<T>) {
  if (!mongoTransactionsEnabled) {
    if (process.env.NODE_ENV === "production") throw new Error("MongoDB transactions must be enabled in production; use Atlas or a replica set");
    if (!warned) {
      console.warn("MongoDB transactions are disabled for local standalone development. Use Atlas or a replica set in production.");
      warned = true;
    }
    await connectDb();
    return work(null);
  }

  const connected = await connectDb();
  const session = await connected.connection.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => { result = await work(session); });
    return result;
  } finally {
    await session.endSession();
  }
}
