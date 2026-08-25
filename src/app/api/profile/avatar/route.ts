import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/classes/guards";
import { rateLimit } from "@/lib/classes/rate-limit";
import { parseImageUpload } from "@/lib/media/server";
import {
  AVATARS_BUCKET,
  MAX_AVATAR_BYTES,
  isValidAvatarPath,
} from "@/lib/media/validation";
import { checkSameOrigin, internalError, notFound, rateLimited } from "@/lib/http";

export const dynamic = "force-dynamic";

const AVATAR_RATE = { limit: 10, windowMs: 60 * 60 * 1000 };
const AVATAR_GET_RATE = { limit: 120, windowMs: 60 * 1000 };
const AVATAR_TTL_SECONDS = 3600;

/**
 * Profile avatar (plan F3). Self-only surface: upload/replace/remove/read.
 * Path contract `<uid>/avatar.<ext>` — one current object per user; a
 * re-upload with the same extension overwrites it (atomic server-side), a
 * different extension writes fresh and removes the old AFTER success. No
 * other user can ever obtain the URL while sign-off item #2 stands (roster
 * visibility out of scope).
 */

async function currentAvatarPath(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string | null> {
  const { data } = await supabase
    .from("profiles")
    .select("avatar_path")
    .eq("id", (await supabase.auth.getUser()).data.user?.id ?? "")
    .maybeSingle();
  return (data as { avatar_path: string | null } | null)?.avatar_path ?? null;
}

export async function POST(request: Request) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const supabase = await createClient();
  const userId = await resolveAnyRoleUser(supabase);
  if (!userId) return notFound();

  if (!rateLimit(`avatar:${userId}`, AVATAR_RATE)) {
    return rateLimited("Too many avatar updates. Try again later.");
  }

  const parsed = await parseImageUpload(request, MAX_AVATAR_BYTES);
  if (!parsed.ok) return parsed.response;

  const path = `${userId}/avatar.${parsed.ext}`;
  const admin = createAdminClient();

  const { error: uploadError } = await admin.storage
    .from(AVATARS_BUCKET)
    .upload(path, parsed.buffer, { contentType: parsed.contentType, upsert: true });
  if (uploadError) {
    console.error("avatar upload error:", uploadError);
    return internalError("Could not store the avatar right now.");
  }

  // Self-update rides RLS ("Users update own profile"); avatar_path is NOT a
  // restricted column (protect_profile_restricted_columns guards only role /
  // consent_given_at). The UPDATE is self-scoped by id; a concurrent avatar
  // change racing this write can only orphan an object (sweep covers it).
  const previous = await currentAvatarPath(supabase);
  const { error: updateError } = await supabase
    .from("profiles")
    .update({ avatar_path: path })
    .eq("id", userId);
  if (updateError) {
    if (!previous) {
      await admin.storage.from(AVATARS_BUCKET).remove([path]).catch(() => {});
    }
    console.error("avatar update error:", updateError);
    return internalError("Could not save the avatar right now.");
  }

  if (previous && previous !== path) {
    // Defense in depth on the stored column before touching storage.
    if (isValidAvatarPath(previous, userId)) {
      void admin.storage.from(AVATARS_BUCKET).remove([previous]).catch(() => {});
    }
  }

  return Response.json(
    { ok: true },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export async function DELETE(request: Request) {
  const originError = checkSameOrigin(request);
  if (originError) return originError;

  const supabase = await createClient();
  const userId = await resolveAnyRoleUser(supabase);
  if (!userId) return notFound();

  if (!rateLimit(`avatar:${userId}`, AVATAR_RATE)) {
    return rateLimited("Too many avatar updates. Try again later.");
  }

  const previous = await currentAvatarPath(supabase);

  const { error: updateError } = await supabase
    .from("profiles")
    .update({ avatar_path: null })
    .eq("id", userId);
  if (updateError) {
    console.error("avatar clear error:", updateError);
    return internalError("Could not remove the avatar right now.");
  }

  if (previous) {
    // Defense in depth: never hand a stored column to storage.remove unchecked.
    const admin = createAdminClient();
    if (isValidAvatarPath(previous, userId)) {
      void admin.storage.from(AVATARS_BUCKET).remove([previous]).catch(() => {});
    }
  }

  return Response.json(
    { ok: true },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export async function GET() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return notFound();

  if (!rateLimit(`avatar-get:${user.id}`, AVATAR_GET_RATE)) {
    return rateLimited("Too many requests. Try again shortly.");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("avatar_path")
    .eq("id", user.id)
    .maybeSingle();
  const path = (profile as { avatar_path: string | null } | null)?.avatar_path;
  if (!path) return notFound();

  // Defense in depth: never hand a tampered column to the signer.
  if (!isValidAvatarPath(path, user.id)) {
    console.error("Malformed avatar_path in database:", path);
    return notFound();
  }

  const admin = createAdminClient();
  const { data: signed, error: signError } = await admin.storage
    .from(AVATARS_BUCKET)
    .createSignedUrl(path, AVATAR_TTL_SECONDS);
  if (signError || !signed) {
    console.error("avatar sign error:", signError);
    return notFound();
  }

  return Response.json(
    { url: signed.signedUrl, expiresAt: new Date(Date.now() + AVATAR_TTL_SECONDS * 1000).toISOString() },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** POST/DELETE accept any authenticated role; returns uid or null (404 upstream). */
async function resolveAnyRoleUser(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string | null> {
  const student = await requireUser(supabase, "student");
  if (student.ok) return student.userId;
  const lecturer = await requireUser(supabase, "lecturer");
  if (lecturer.ok) return lecturer.userId;
  return null;
}
