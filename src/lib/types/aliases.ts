import type { Database } from "@/lib/types/database";

/**
 * Convenience aliases over the generated Supabase types.
 *
 * Kept in their own file (NOT appended to database.ts) so that regenerating
 * types with `npm run gen:types` can never silently drop them.
 */

export type UserRole = Database["public"]["Enums"]["user_role"];

export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
