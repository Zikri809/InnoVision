"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { register } from "@/lib/auth/register";
import type { UserRole } from "@/lib/types/aliases";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function RegisterPage() {
  const router = useRouter();

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Display-only for the picker; the server action always registers "student".
  const [role, setRole] = useState<UserRole>("student");
  const [inviteCode, setInviteCode] = useState("");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!consent) {
      setError("You must provide biometric consent to register.");
      return;
    }

    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    if (role === "lecturer" && !inviteCode.trim()) {
      setError("A lecturer invite code is required to register as a lecturer.");
      return;
    }

    setLoading(true);

    const { session, error } = await register({
      email,
      password,
      fullName: fullName || undefined,
      inviteCode: role === "lecturer" ? inviteCode : undefined,
    });

    if (error) {
      setError(error);
      setLoading(false);
      return;
    }

    if (session) {
      router.push("/dashboard");
      router.refresh();
    } else {
      // Email confirmation required — redirect to login with a message
      router.push("/login?message=check-email");
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      {/* decorative blobs */}
      <div aria-hidden className="pointer-events-none absolute -left-10 top-20 h-32 w-32 rounded-[42%_58%_60%_40%/50%_45%_55%_50%] bg-orange-200/50" />
      <div aria-hidden className="pointer-events-none absolute -right-8 bottom-24 h-28 w-28 rounded-[60%_40%_45%_55%/50%_60%_40%_55%] bg-blue-200/50" />

      <div className="w-full max-w-md">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2.5">
          <span className="grid h-11 w-11 -rotate-4 place-items-center rounded-2xl bg-primary font-heading text-xl font-bold text-primary-foreground shadow-[0_4px_0_var(--primary-deep)]">
            IV
          </span>
          <span className="font-heading text-2xl font-semibold">InnoVision</span>
        </Link>

        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Create your account</CardTitle>
            <CardDescription>
              Join InnoVision — wave your way through quizzes
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="full-name">Full name (optional)</Label>
                <Input
                  id="full-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  placeholder="Jane Doe"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  inputMode="email"
                  spellCheck={false}
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="At least 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                />
              </div>
              <div className="space-y-2.5">
                <Label>I am a…</Label>
                <RadioGroup
                  value={role}
                  onValueChange={(v) => setRole(v as UserRole)}
                  className="flex gap-6"
                >
                  <div className="flex items-center space-x-2.5">
                    <RadioGroupItem value="student" id="role-student" />
                    <Label htmlFor="role-student" className="cursor-pointer">
                      Student
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2.5">
                    <RadioGroupItem value="lecturer" id="role-lecturer" />
                    <Label htmlFor="role-lecturer" className="cursor-pointer">
                      Lecturer
                    </Label>
                  </div>
                </RadioGroup>
              </div>
              {role === "lecturer" && (
                <div className="space-y-2">
                  <Label htmlFor="invite-code">Lecturer invite code</Label>
                  <Input
                    id="invite-code"
                    type="text"
                    placeholder="Provided by your administrator"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    autoComplete="off"
                  />
                  <p className="text-xs font-semibold text-muted-foreground">
                    Lecturer registration requires a valid invite code. Students
                    do not need one.
                  </p>
                </div>
              )}
              <div className="flex items-start space-x-3 rounded-2xl border-[3px] border-border bg-orange-50/60 p-4">
                <Checkbox
                  id="consent"
                  checked={consent}
                  onCheckedChange={(v) => setConsent(v === true)}
                  className="mt-0.5"
                />
                <div className="space-y-1.5 leading-none">
                  <Label
                    htmlFor="consent"
                    className="cursor-pointer text-sm font-extrabold"
                  >
                    Biometric consent
                  </Label>
                  <p className="text-xs font-semibold leading-relaxed text-muted-foreground">
                    I understand InnoVision uses my webcam for face verification
                    and gesture-based answering. Face embeddings are stored but
                    face images are never saved. I can revoke consent at any time.
                  </p>
                </div>
              </div>
              <div aria-live="polite">
                {error && (
                  <p className="rounded-xl border-[3px] border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive" role="alert">
                    {error}
                  </p>
                )}
              </div>
            </CardContent>
            <CardFooter className="flex flex-col gap-4">
              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={loading || !consent}
              >
                {loading ? "Creating account…" : "Create account"}
              </Button>
              <p className="text-sm font-semibold text-muted-foreground">
                Already have an account?{" "}
                <Link
                  href="/login"
                  className="font-extrabold text-primary hover:underline"
                >
                  Sign in
                </Link>
              </p>
            </CardFooter>
          </form>
        </Card>
      </div>
    </div>
  );
}
