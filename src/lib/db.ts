import mongoose, { type Connection } from "mongoose";
import { Plan, Installation, ActivationCode, ManualPayment, MachineNonce } from './models';

// Next route bundles can share globals without sharing a Mongoose connection.
// Cache against the actual connection, and never reuse a disconnected promise.
const globalMongo = globalThis as typeof globalThis & {
  __pandasMongoConnections?: WeakMap<Connection, Promise<typeof mongoose>>;
};
const connections = globalMongo.__pandasMongoConnections ||= new WeakMap<Connection, Promise<typeof mongoose>>();

export class DatabaseUnavailableError extends Error {
  readonly statusCode = 503;
  constructor(cause: unknown) {
    super("Database unavailable. Please retry shortly; if this continues, check the Synexus MongoDB connection and Atlas network access.", { cause });
    this.name = "DatabaseUnavailableError";
  }
}

export async function connectDb() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  const connection = mongoose.connection;
  if (connection.readyState === 0) connections.delete(connection);
  let pending = connections.get(connection);
  if (!pending) {
    pending = (async () => {
      await mongoose.connect(process.env.MONGODB_URI!, { maxPoolSize: 10, serverSelectionTimeoutMS: 10_000 });
      // In Mongoose 8 connect() may return immediately when another call is
      // already connecting. Wait for that connection before opening sessions.
      await connection.asPromise();
      await Promise.all([Plan.init(), Installation.init(), ActivationCode.init(), ManualPayment.init(), MachineNonce.init()]);
      if (connection.readyState !== 1) throw new Error("MongoDB connection is not ready");
      return mongoose;
    })().catch(error => {
      connections.delete(connection);
      throw new DatabaseUnavailableError(error);
    });
    connections.set(connection, pending);
  }
  const connected = await pending;
  if (connection.readyState !== 1) {
    connections.delete(connection);
    throw new DatabaseUnavailableError(new Error("MongoDB connection was interrupted"));
  }
  return connected;
}
