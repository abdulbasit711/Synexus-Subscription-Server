import mongoose from "mongoose";
import { Plan, Installation, ActivationCode, ManualPayment, MachineNonce } from './models';

const globalMongo = globalThis as typeof globalThis & { __pandasMongo?: Promise<typeof mongoose> };

export async function connectDb() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  globalMongo.__pandasMongo ||= (async () => {
    await mongoose.connect(process.env.MONGODB_URI!, { maxPoolSize: 10, serverSelectionTimeoutMS: 10_000 });
    await Promise.all([Plan.init(), Installation.init(), ActivationCode.init(), ManualPayment.init(), MachineNonce.init()]);
    return mongoose;
  })().catch(error => { delete globalMongo.__pandasMongo; throw error; });
  return globalMongo.__pandasMongo;
}
