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
    <div className="min-h-screen flex">
      {/* Left: hero image panel */}
      <div className="hidden lg:flex lg:w-1/2 relative bg-slate-900">
        {/* Replace /login-hero.jpg with your own photo — drop it in public/ */}
        <div className="absolute inset-0 bg-[url('/login-hero.jpg')] bg-cover bg-center" />
        <div className="absolute inset-0 bg-gradient-to-br from-slate-900/80 via-slate-900/60 to-slate-900/80" />
        <div className="relative z-10 flex flex-col justify-end p-12 text-white">
          <Image src="/logo.png" alt="Baker Aviation" width={220} height={60} className="mb-6 brightness-0 invert" />
          <p className="text-lg font-light text-white/80 max-w-md leading-relaxed">
            Flight operations, invoice management, and fleet intelligence — all in one place.
          </p>
        </div>
      </div>

      {/* Right: login form */}
      <div className="flex-1 flex items-center justify-center bg-gray-50 px-6">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="lg:hidden mb-8">
            <Image src="/logo.png" alt="Baker Aviation" width={180} height={50} />
          </div>

          <h1 className="text-2xl font-bold text-slate-900 mb-1">
            {mode === "forgot" ? "Reset password" : "Welcome back"}
          </h1>
          <p className="text-sm text-gray-500 mb-8">
            {mode === "forgot"
              ? "Enter your email and we'll send a reset link."
              : "Sign in to your Baker Aviation account."}
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
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
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
                    <label className="block text-sm font-medium text-gray-700">
                      Password
                    </label>
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
    </div>
  );
}
