import type { SupabaseClient } from "@supabase/supabase-js";
import type { NetworkOptions } from "./lib/domo-dataset.mjs";

export type GovernedBindingMethod = "endpoint_recipe" | "custom_endpoint" | "domo_dataset";
export interface GovernanceArguments {
  "organization-id": string;
  "binding-id": string;
  "actor-profile-id": string;
  "period-start": string;
  "period-end": string;
  "reference-value": string;
  tolerance: string;
  confirm: string;
}
export interface GovernanceDependencies {
  supabase?: SupabaseClient;
  expectedMethod?: GovernedBindingMethod;
  executionOptions?: NetworkOptions;
}
export interface GovernanceResult {
  approved: boolean;
  delta: string;
  tolerance: string;
  rowCount: number;
  method: GovernedBindingMethod;
}
export function governBinding(
  args: GovernanceArguments,
  dependencies?: GovernanceDependencies,
): Promise<GovernanceResult>;
