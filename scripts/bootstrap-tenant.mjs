#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";

const HELP = `Usage:
  BOOTSTRAP_USER_PASSWORD='...' \\
  NEXT_PUBLIC_SUPABASE_URL='https://PROJECT.supabase.co' \\
  SUPABASE_SERVICE_ROLE_KEY='...' \\
  GM_PLATFORM_OWNER_PROFILE_ID='optional-profile-uuid' \\
  node scripts/bootstrap-tenant.mjs \\
    --email owner@example.com \\
    --display-name 'Pilot Owner' \\
    --organization-slug pilot-company \\
    --organization-name 'Pilot Company' \\
    --confirm pilot-company

The password and service-role key are accepted only through environment variables so they do
not appear in shell history or process arguments. The script never prints either value.`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message) {
  console.error(`Bootstrap failed: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const allowed = new Set([
    "email",
    "display-name",
    "organization-slug",
    "organization-name",
    "confirm",
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown option: --${name}`);
    if (values[name] !== undefined) throw new Error(`duplicate option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    values[name] = value;
    index += 1;
  }
  return values;
}

function requiredText(value, label, maximum) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maximum) throw new Error(`${label} is too long`);
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${label} contains control characters`);
  return normalized;
}

function validateUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not a valid URL");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Supabase URL must use HTTPS (HTTP is accepted only for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Supabase URL must not contain credentials, query parameters, or a fragment");
  }
  return url.origin;
}

function validateServiceRoleKey(key) {
  if (!key || key.length < 20 || /\s/.test(key)) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing or malformed");
  }
  if (key.startsWith("sb_secret_")) return key;
  const parts = key.split(".");
  if (parts.length !== 3) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not a service-role key");
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload.role !== "service_role") {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not a service-role key");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("not a service-role")) throw error;
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is malformed");
  }
  return key;
}

function validateInputs(args) {
  const email = requiredText(args.email, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("email is invalid");
  const displayName = requiredText(args["display-name"], "display name", 120);
  const organizationSlug = requiredText(
    args["organization-slug"],
    "organization slug",
    64,
  ).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(organizationSlug)) {
    throw new Error("organization slug must be 3-64 lowercase letters, numbers, or hyphens");
  }
  const organizationName = requiredText(args["organization-name"], "organization name", 160);
  if (args.confirm !== organizationSlug) {
    throw new Error("--confirm must exactly match the normalized organization slug");
  }
  const password = process.env.BOOTSTRAP_USER_PASSWORD;
  if (!password || password.length < 12 || password.length > 128 || /^\s+$/.test(password)) {
    throw new Error("BOOTSTRAP_USER_PASSWORD must contain 12-128 characters");
  }
  return { email, displayName, organizationSlug, organizationName, password };
}

async function findAuthUserByEmail(client, email) {
  const matches = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Auth user lookup failed${formatErrorCode(error)}`);
    for (const user of data.users) {
      if (user.email?.trim().toLowerCase() === email) matches.push(user);
    }
    if (data.users.length < 1000) break;
  }
  if (matches.length > 1) throw new Error("multiple Auth users have the requested email");
  return matches[0] ?? null;
}

function formatErrorCode(error) {
  const details = [];
  if (typeof error?.status === "number") details.push(`status ${error.status}`);
  if (typeof error?.code === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(error.code)) {
    details.push(`code ${error.code}`);
  }
  return details.length ? ` (${details.join(", ")})` : "";
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(HELP);
      return;
    }
  } catch (error) {
    fail(error.message);
    console.error(HELP);
    return;
  }

  let input;
  let supabaseUrl;
  let serviceRoleKey;
  try {
    input = validateInputs(args);
    supabaseUrl = validateUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    serviceRoleKey = validateServiceRoleKey(process.env.SUPABASE_SERVICE_ROLE_KEY);
  } catch (error) {
    fail(error.message);
    return;
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  let authUser;
  let authUserCreated = false;
  try {
    authUser = await findAuthUserByEmail(client, input.email);
    if (!authUser) {
      const { error: authorizationError } = await client.rpc("authorize_pilot_auth_email", {
        p_email: input.email,
      });
      if (authorizationError) {
        throw new Error(`pilot Auth-email authorization failed${formatErrorCode(authorizationError)}`);
      }
      const { data, error } = await client.auth.admin.createUser({
        email: input.email,
        password: input.password,
        email_confirm: true,
        user_metadata: { display_name: input.displayName },
      });
      if (error) {
        // A concurrent retry may have created the user after our lookup.
        authUser = await findAuthUserByEmail(client, input.email);
        if (!authUser) throw new Error(`Auth user creation failed${formatErrorCode(error)}`);
      } else {
        authUser = data.user;
        authUserCreated = true;
      }
    }

    if (!authUser?.id) throw new Error("Auth API returned no user ID");

    const { data, error } = await client.rpc("bootstrap_tenant_owner", {
      p_user_id: authUser.id,
      p_email: input.email,
      p_display_name: input.displayName,
      p_organization_slug: input.organizationSlug,
      p_organization_name: input.organizationName,
    });
    if (error) throw new Error(`tenant bootstrap transaction failed${formatErrorCode(error)}`);
    if (!Array.isArray(data) || data.length !== 1) {
      throw new Error("tenant bootstrap transaction returned an unexpected result");
    }

    const result = data[0];
    authUserCreated = false;
    const platformOwnerProfileId = process.env.GM_PLATFORM_OWNER_PROFILE_ID?.trim();
    if (platformOwnerProfileId) {
      if (!UUID_PATTERN.test(platformOwnerProfileId)) {
        throw new Error("GM_PLATFORM_OWNER_PROFILE_ID is malformed; tenant bootstrap succeeded but operator-wide access was not refreshed");
      }
      const { data: tenantCount, error: platformGrantError } = await client.rpc("grant_owner_access_to_all_tenants", {
        p_profile_id: platformOwnerProfileId,
      });
      if (platformGrantError) {
        throw new Error(`tenant bootstrap succeeded but operator-wide access refresh failed${formatErrorCode(platformGrantError)}`);
      }
      console.log(`Platform owner access verified across ${tenantCount} active tenant(s).`);
    }
    console.log(result.created ? "Tenant bootstrap created." : "Tenant bootstrap already complete.");
    console.log(`Profile ID: ${result.profile_id}`);
    console.log(`Organization ID: ${result.organization_id}`);
    console.log(`Membership ID: ${result.membership_id}`);
    console.log(`Organization slug: ${input.organizationSlug}`);
  } catch (error) {
    if (authUserCreated && authUser?.id) {
      const { error: cleanupError } = await client.auth.admin.deleteUser(authUser.id, false);
      if (cleanupError) {
        fail(
          `${error.message}; compensating Auth-user removal also failed${formatErrorCode(cleanupError)}. ` +
            `Remove orphan Auth user ID ${authUser.id} before retrying.`,
        );
        return;
      }
    }
    fail(error.message);
  }
}

await main();
