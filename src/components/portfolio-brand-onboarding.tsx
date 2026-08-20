"use client";

import { useActionState, useId, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  createPortfolioBrandOrganizationAction,
  type PortfolioActionState,
} from "@/app/portfolio/actions";

const INITIAL: PortfolioActionState = { status: "idle", message: "" };
// HTML pattern attributes compile with the RegExp v flag in modern Chromium,
// where an unescaped hyphen inside a character class is a syntax error.
const SLUG_PATTERN = "[a-z0-9][a-z0-9\\-]{1,62}[a-z0-9]";

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className="button primary" type="submit" disabled={pending || disabled}>
      {pending ? "Creating organization…" : "Create organization"}
    </button>
  );
}

/**
 * Owner-only brand onboarding. This panel is rendered exclusively when the
 * server confirmed `is_portfolio_owner()`; the server action and the database
 * RPC each re-verify that authorization independently, so this component is
 * presentation only.
 */
export function PortfolioBrandOnboarding() {
  const [state, action] = useActionState(createPortfolioBrandOrganizationAction, INITIAL);
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [confirm, setConfirm] = useState("");
  const formId = useId();
  const confirmed = slug.length >= 3 && slug === confirm;

  return (
    <section className="production-panel" aria-labelledby={`${formId}-title`}>
      <div className="production-panel-heading">
        <div>
          <span>Portfolio owner administration</span>
          <h2 id={`${formId}-title`}>Add a brand organization</h2>
        </div>
        <button
          type="button"
          className="production-secondary-button"
          aria-expanded={open}
          aria-controls={`${formId}-body`}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Close" : "New organization"}
        </button>
      </div>
      {open ? (
        <div id={`${formId}-body`}>
          <p className="production-boundary-note">
            Creating an organization provisions a new brand tenant boundary: its own locations, ServiceTitan
            connections, credentials, KPI configuration, and access roles. Every active portfolio member receives
            role-mapped access, and the brand is attached to this portfolio automatically. Organizations use
            lifecycle status transitions and cannot be deleted from the application.
          </p>
          <form action={action} className="production-form-grid">
            <label>
              Brand name
              <input
                name="organizationName"
                required
                minLength={2}
                maxLength={160}
                autoComplete="off"
                aria-invalid={state.fieldErrors?.organizationName ? true : undefined}
              />
            </label>
            <label>
              Workspace URL key
              <input
                name="organizationSlug"
                required
                minLength={3}
                maxLength={64}
                pattern={SLUG_PATTERN}
                autoComplete="off"
                spellCheck={false}
                value={slug}
                onChange={(event) => setSlug(event.target.value.toLowerCase())}
                aria-invalid={state.fieldErrors?.organizationSlug ? true : undefined}
              />
            </label>
            <label className="span-two">
              Retype the workspace URL key to confirm
              <input
                name="confirmSlug"
                required
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value.toLowerCase())}
                aria-invalid={state.fieldErrors?.confirmSlug ? true : undefined}
              />
              <small>Use lowercase letters, numbers, and hyphens — for example service-wizards. The key is permanent once saved links exist.</small>
            </label>
            <div className="production-form-footer">
              <span>You will be taken to the new organization&apos;s Admin Center to add locations and connections.</span>
              <SubmitButton disabled={!confirmed} />
            </div>
          </form>
          {state.status !== "idle" ? (
            <div className={`production-notice ${state.status}`} role={state.status === "error" ? "alert" : "status"}>
              {state.message}
              {state.fieldErrors ? (
                <ul>
                  {Object.entries(state.fieldErrors).map(([field, message]) => (
                    <li key={field}><strong>{field}:</strong> {message}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
