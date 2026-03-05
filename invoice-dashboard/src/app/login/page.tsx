"use client";

import Image from "next/image";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"login" | "forgot">("login");
  const [resetSent, setResetSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const supabase = createClient();

    if (mode === "forgot") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/login/reset`,
      });
      setLoading(false);
      if (error) {
        setError(error.message);
      } else {
        setResetSent(true);
      }
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      const role =
        data.user?.app_metadata?.role ??
        data.user?.user_metadata?.role;
      window.location.href = role === "pilot" ? "/pilot" : "/";
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center px-4">
      {/* Hero section */}
      <div className="mb-8 text-center">
        <Image
          src="/logo1.png"
          alt="Baker Aviation Aircraft"
          width={960}
          height={280}
          className="mx-auto max-w-md w-full drop-shadow-2xl rounded-2xl"
          priority
          unoptimized
        />
        <div className="mt-4">
          <Image
            src="/logo2.png"
            alt="Baker Aviation"
            width={200}
            height={63}
            className="mx-auto brightness-0 invert"
            priority
            unoptimized
          />
        </div>
      </div>

      {/* Login card */}
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-sm">
        <h1 className="text-lg font-bold text-slate-900 mb-1">
          {mode === "forgot" ? "Reset password" : "Sign in"}
        </h1>
        <p className="text-sm text-gray-500 mb-6">
          {mode === "forgot"
            ? "Enter your email and we'll send a reset link."
            : "Enter your credentials to continue."}
        </p>

        {mode === "forgot" && resetSent ? (
          <div className="space-y-4">
            <div className="rounded-lg bg-green-50 border border-green-200 p-4">
              <p className="text-sm text-green-800 font-medium">Check your email</p>
              <p className="text-xs text-green-700 mt-1">
                We sent a password reset link to <span className="font-medium">{email}</span>.
              </p>
            </div>
            <button
              type="button"
              onClick={() => { setMode("login"); setResetSent(false); setError(""); }}
              className="text-sm text-slate-600 hover:text-slate-900 font-medium"
            >
              ← Back to sign in
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@baker-aviation.com"
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-transparent placeholder:text-gray-400"
              />
            </div>
            {mode === "login" && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium text-gray-700">Password</label>
                  <button
                    type="button"
                    onClick={() => { setMode("forgot"); setError(""); }}
                    className="text-xs text-slate-500 hover:text-slate-800"
                  >
                    Forgot password?
                  </button>
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-transparent"
                />
              </div>
            )}
            {error && (
              <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              className="bg-slate-900 text-white rounded-lg px-4 py-2.5 text-sm font-medium hover:bg-slate-700 disabled:opacity-50 transition-colors mt-1"
            >
              {loading
                ? mode === "forgot" ? "Sending…" : "Signing in…"
                : mode === "forgot" ? "Send reset link" : "Sign in"}
            </button>
            {mode === "forgot" && (
              <button
                type="button"
                onClick={() => { setMode("login"); setError(""); }}
                className="text-sm text-slate-500 hover:text-slate-800 text-center"
              >
                ← Back to sign in
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
