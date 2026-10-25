import { fail } from "@/lib/http";
export async function POST() { return fail("Online payments are disabled. Contact PANDAS to arrange payment and renewal.", 410); }
