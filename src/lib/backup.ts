import { z } from 'zod';
import { Business, SubscriptionEvent } from './models';
import { encryptSecret, decryptSecret } from './secret-box';
import { withMongoTransaction } from './transaction';

export const backupSchema = z.object({ enabled: z.boolean(), uri: z.string().trim().max(4000).optional(),
  database: z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/, 'Use a database name with letters, numbers, underscores or hyphens'), reason: z.string().trim().min(3).max(2000) });
export function backupHost(uri: string) {
  try {
    const value = new URL(uri);
    if (value.protocol !== 'mongodb+srv:' || !value.username || !value.password || !value.hostname.endsWith('.mongodb.net') || value.port || value.hash) throw new Error();
    return value.hostname.toLowerCase();
  } catch { throw new Error('Enter this client’s Atlas mongodb+srv connection with its database username and password'); }
}
export async function configureBackup(businessId: string, input: z.infer<typeof backupSchema>, actorId: string) {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('Configure a strong SESSION_SECRET before saving backup credentials');
  return withMongoTransaction(async session => {
    const business = await Business.findById(businessId).select('+backupUriEncrypted').session(session);
    if (!business || business.deletedAt) throw new Error('Business not found or deleted');
    if (input.uri) { business.backupHost = backupHost(input.uri); business.backupUriEncrypted = encryptSecret(input.uri); }
    if (input.enabled && !business.backupUriEncrypted) throw new Error('Enter this client’s Atlas connection first');
    // Separate Atlas clusters prevent one client from consuming another's free-tier storage.
    if (business.backupHost && await Business.exists({ _id: { $ne: business._id }, deletedAt: null, backupHost: business.backupHost }).session(session)) throw new Error('This Atlas cluster is assigned to another client. Use a separate client cluster');
    business.backupEnabled = input.enabled; business.backupDatabase = input.database;
    await business.save({ session });
    await SubscriptionEvent.create([{ businessId, type: 'backup_destination_configured', actorType: 'admin', actorId, reason: input.reason,
      after: { enabled: business.backupEnabled, host: business.backupHost, database: business.backupDatabase } }], { session: session || undefined });
    return { enabled: business.backupEnabled, host: business.backupHost, database: business.backupDatabase, configured: !!business.backupUriEncrypted };
  });
}
export async function machineBackupDestination(businessId: unknown) {
  const business = await Business.findById(businessId).select('+backupUriEncrypted');
  if (!business || business.deletedAt || business.configuredStatus === 'suspended') throw new Error('Business is not active');
  if (!['premium', 'enterprise'].includes(business.planKey)) throw new Error('Cloud backup requires Premium or Enterprise');
  if (!business.backupEnabled || !business.backupUriEncrypted || !business.backupDatabase) throw new Error('Configure this client’s backup destination in Synexus');
  return { uri: decryptSecret(business.backupUriEncrypted), database: business.backupDatabase };
}
