import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { getSafeRedirectPath } from "@/lib/auth";
import { getAppConfig } from "@/lib/env";

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const config = getAppConfig();
  if (config.isDemo) redirect("/");

  const parameters = await searchParams;
  const nextPath = getSafeRedirectPath(firstValue(parameters.next));
  const hasCallbackError = firstValue(parameters.error) === "callback";

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <section style={{ width: "min(420px, 100%)", border: "1px solid #e4e9ef", borderRadius: 12, background: "white", padding: 32, boxShadow: "0 12px 36px rgba(15, 23, 42, .08)" }}>
        <div style={{ width: 44, height: 44, display: "grid", placeItems: "center", borderRadius: 10, background: "#f4b41a", color: "#10253e", fontWeight: 800 }}>
          CG
        </div>
        <h1 style={{ margin: "20px 0 8px", color: "#132238", fontSize: 26 }}>GM Intelligence Board</h1>
        <p style={{ margin: "0 0 24px", color: "#64748b", fontSize: 13, lineHeight: 1.5 }}>
          Sign in with the account provided by your administrator. Public registration is not available.
        </p>
        {hasCallbackError ? (
          <p role="alert" style={{ padding: 10, borderRadius: 7, background: "#fff0f0", color: "#a92e35", fontSize: 12 }}>
            That sign-in link is invalid or expired. Sign in with your password or request a new invitation.
          </p>
        ) : null}
        <LoginForm nextPath={nextPath} />
      </section>
    </main>
  );
}
