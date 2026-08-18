"use client";

import { type FormEvent, useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

interface LoginFormProps {
  nextPath: string;
}

export function LoginForm({ nextPath }: LoginFormProps) {
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setErrorMessage("");

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");

    try {
      const supabase = createBrowserSupabaseClient();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setErrorMessage("Unable to sign in. Check your credentials and try again.");
        return;
      }
      window.location.assign(nextPath);
    } catch {
      setErrorMessage("Sign-in is temporarily unavailable. Please try again later.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: "grid", gap: 16 }}>
      <label style={{ display: "grid", gap: 6, color: "#354255", fontSize: 13, fontWeight: 700 }}>
        Email
        <input
          required
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          disabled={pending}
          style={{ height: 42, border: "1px solid #d5dde6", borderRadius: 7, padding: "0 12px" }}
        />
      </label>
      <label style={{ display: "grid", gap: 6, color: "#354255", fontSize: 13, fontWeight: 700 }}>
        Password
        <input
          required
          name="password"
          type="password"
          autoComplete="current-password"
          disabled={pending}
          style={{ height: 42, border: "1px solid #d5dde6", borderRadius: 7, padding: "0 12px" }}
        />
      </label>
      {errorMessage ? (
        <p role="alert" style={{ margin: 0, color: "#a92e35", fontSize: 12 }}>
          {errorMessage}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        style={{ height: 42, border: 0, borderRadius: 7, background: "#132a46", color: "white", fontWeight: 700 }}
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
