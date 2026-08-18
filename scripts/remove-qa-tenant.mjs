#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";

const HELP = `Usage:
  NEXT_PUBLIC_SUPABASE_URL='https://PROJECT.supabase.co' \\
  SUPABASE_SERVICE_ROLE_KEY='...' \\
  GM_PLATFORM_OWNER_PROFILE_ID='platform-owner-profile-uuid' \\
  GM_DEFAULT_PORTFOLIO_ID='portfolio-uuid' \\
  node scripts/remove-qa-tenant.mjs \\
    --email qa-owner@example.com \\
    --organization-slug qa-disposable-pilot \\
    --organization-id 00000000-0000-0000-0000-000000000000 \\
    --user-id 00000000-0000-0000-0000-000000000000 \\
    --confirm 'qa-disposable-pilot:00000000-0000-0000-0000-000000000000:00000000-0000-0000-0000-000000000000'

This script only removes an empty qa-* tenant with exactly one active owner. The exact slug,
organization ID, user ID, email lookup, and confirmation token must all agree. The database
teardown commits before the Auth user is removed and is safe to resume if Auth removal fails.`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message) {
  console.error(`QA tenant removal failed: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const allowed = new Set([
    "email",
    "organization-slug",
    "organization-id",
    "user-id",
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
  const email = args.email?.trim().toLowerCase();
  const slug = args["organization-slug"]?.trim().toLowerCase();
  const organizationId = args["organization-id"]?.trim().toLowerCase();
  const userId = args["user-id"]?.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("email is invalid");
  }
  if (!slug || !/^qa-[a-z0-9][a-z0-9-]{0,59}[a-z0-9]$/.test(slug)) {
    throw new Error("organization slug must be an exact lowercase qa-* slug");
  }
  if (!UUID.test(organizationId ?? "")) throw new Error("organization ID is invalid");
  if (!UUID.test(userId ?? "")) throw new Error("user ID is invalid");
  const expectedConfirmation = `${slug}:${organizationId}:${userId}`;
  if (args.confirm !== expectedConfirmation) {
    throw new Error("--confirm must exactly equal <slug>:<organization-id>:<user-id>");
  }
  return { email, slug, organizationId, userId };
}

function formatErrorCode(error) {
  const details = [];
  if (typeof error?.status === "number") details.push(`status ${error.status}`);
  if (typeof error?.code === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(error.code)) {
    details.push(`code ${error.code}`);
  }
  return details.length ? ` (${details.join(", ")})` : "";
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

async function assertOrphanIsSafeToResume(client, input) {
  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("id")
    .eq("id", input.userId)
    .maybeSingle();
  if (profileError) throw new Error(`profile safety check failed${formatErrorCode(profileError)}`);

  const { data: memberships, error: membershipError } = await client
    .from("organization_memberships")
    .select("id")
    .eq("profile_id", input.userId)
    .limit(1);
  if (membershipError) {
    throw new Error(`membership safety check failed${formatErrorCode(membershipError)}`);
  }
  if (profile || memberships.length !== 0) {
    throw new Error("expected QA organization is absent but profile or membership rows still exist");
  }
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
  let platformOwnerProfileId;
  let defaultPortfolioId;
  try {
    input = validateInputs(args);
    supabaseUrl = validateUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    serviceRoleKey = validateServiceRoleKey(process.env.SUPABASE_SERVICE_ROLE_KEY);
    platformOwnerProfileId = process.env.GM_PLATFORM_OWNER_PROFILE_ID?.trim();
    defaultPortfolioId = process.env.GM_DEFAULT_PORTFOLIO_ID?.trim();
    if (!UUID.test(platformOwnerProfileId ?? "")) throw new Error("GM_PLATFORM_OWNER_PROFILE_ID is missing or malformed");
    if (!UUID.test(defaultPortfolioId ?? "")) throw new Error("GM_DEFAULT_PORTFOLIO_ID is missing or malformed");
  } catch (error) {
    fail(error.message);
    return;
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  try {
    const authUser = await findAuthUserByEmail(client, input.email);
    if (!authUser) throw new Error("no Auth user matches the supplied email");
    if (authUser.id.toLowerCase() !== input.userId) {
      throw new Error("Auth user email and supplied user ID do not match");
    }

    const { data: organization, error: organizationError } = await client
      .from("organizations")
      .select("id, slug")
      .eq("id", input.organizationId)
      .maybeSingle();
    if (organizationError) {
      throw new Error(`organization safety check failed${formatErrorCode(organizationError)}`);
    }

    if (organization) {
      if (organization.slug !== input.slug) {
        throw new Error("organization ID and supplied QA slug do not match");
      }
      const { data, error } = await client.rpc("remove_empty_qa_brand_from_portfolio", {
        p_portfolio_id: defaultPortfolioId,
        p_organization_id: input.organizationId,
        p_qa_user_id: input.userId,
        p_platform_owner_profile_id: platformOwnerProfileId,
        p_expected_slug: input.slug,
        p_reason: `Remove disposable QA brand ${input.slug}`,
      });
      if (error) throw new Error(`atomic portfolio QA teardown refused${formatErrorCode(error)}`);
      if (data !== true) throw new Error("atomic portfolio QA teardown returned an unexpected result");
      console.log("Empty QA tenant database rows removed.");
    } else {
      // Resume only the narrow failure window after DB teardown committed and before Auth
      // deletion succeeded. No remaining profile/membership may be present.
      await assertOrphanIsSafeToResume(client, input);
      console.log("QA tenant database rows were already removed; resuming Auth cleanup.");
    }

    const { error: authDeleteError } = await client.auth.admin.deleteUser(input.userId, false);
    if (authDeleteError) {
      throw new Error(
        `Auth user removal failed${formatErrorCode(authDeleteError)}; rerun the same command to resume`,
      );
    }
    console.log(`QA Auth user removed: ${input.userId}`);
    console.log(`QA organization slug removed: ${input.slug}`);
  } catch (error) {
    fail(error.message);
  }
}

await main();
