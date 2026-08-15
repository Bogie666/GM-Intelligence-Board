import type { LocationConfig, Metric } from "./types";

export const locations: LocationConfig[] = [
  { id: "sierra-abq", tenantId: "sierra", brand: "Sierra Home Services", location: "Albuquerque", timezone: "America/Denver", accent: "#f4b41a", accentDark: "#15355f", initials: "SH", syncLabel: "Demo data · refreshed 8:42 AM", serviceTitanStatus: "demo", metricScale: 1 },
  { id: "asi-san-diego", tenantId: "asi", brand: "ASI Hastings", location: "San Diego", timezone: "America/Los_Angeles", accent: "#c41820", accentDark: "#1a2e44", initials: "AH", syncLabel: "Demo data · refreshed 8:39 AM", serviceTitanStatus: "demo", metricScale: 0.74 },
  { id: "swan-denver", tenantId: "swan", brand: "Swan Plumbing, Heating & Air", location: "Denver", timezone: "America/Denver", accent: "#00a3e0", accentDark: "#172f50", initials: "SW", syncLabel: "Demo data · refreshed 8:46 AM", serviceTitanStatus: "demo", metricScale: 0.61 },
];

const action = (title: string, detail: string) => ({ title, detail });

const baseMetrics: Metric[] = [
  { id:"revenue-mtd", section:"executive", title:"Revenue MTD", actual:3551550, goal:4017538, prior:3296000, kind:"currency", source:"ServiceTitan", subtitle:"88.4% of monthly budget", sparkline:[72,75,79,78,83,86,88], playbook:[action("Daily revenue huddle","Review prior-day actuals, remaining gap, and capacity by trade."),action("Recover the largest division gap","Assign one owner to volume, conversion, and average ticket actions.")] },
  { id:"pace", section:"executive", title:"Projected Month-End", actual:3923000, goal:4017538, prior:3810000, kind:"currency", source:"Derived", subtitle:"97.6% forecast attainment", warningAt:95, sparkline:[88,90,92,93,95,96,98], playbook:[action("Protect scheduled revenue","Review cancellations, open capacity, and sold work not yet completed."),action("Close the final gap","Translate the forecast gap into jobs per remaining workday.")] },
  { id:"ebitda", section:"executive", title:"Gross Margin", actual:47.8, goal:50, prior:46.2, kind:"percent", source:"Budget", subtitle:"2.2 pts below target", warningAt:96, sparkline:[44,45,46,46,47,48,48], playbook:[action("Audit discounting","Review jobs with the highest discount-to-revenue ratio."),action("Inspect labor efficiency","Separate pricing leakage from labor and material variance.")] },
  { id:"booking-rate", section:"executive", title:"Call Booking Rate", actual:70, goal:72, prior:68.4, kind:"percent", source:"ServiceTitan", subtitle:"1,988 booked of 2,840 inbound", warningAt:95, sparkline:[66,68,67,69,71,70,70], playbook:[action("Listen to unbooked calls","Review ten high-intent calls by reason and CSR."),action("Protect same-day capacity","Make open appointment slots visible to the booking team.")] },
  { id:"sales-close", section:"executive", title:"Sales Close Rate", actual:35.2, goal:42, prior:33.1, kind:"percent", source:"ServiceTitan", subtitle:"220 sold of 625 opportunities", sparkline:[30,32,34,33,35,36,35], playbook:[action("Coach by lead type","Separate Tech Lead, NCE, and Team Visit close rates."),action("48-hour follow-up","Assign every unsold opportunity an owner and due date.")] },
  { id:"avg-ticket", section:"executive", title:"Service Avg Ticket", actual:746, goal:725, prior:698, kind:"currency", source:"ServiceTitan", subtitle:"103% of target", sparkline:[680,695,704,710,730,738,746], playbook:[action("Recognize the right behavior","Share compliant jobs where options improved customer value."),action("Protect quality","Monitor recalls and discounts alongside average ticket.")] },
  { id:"membership-net", section:"executive", title:"Membership Net Growth", actual:-5, goal:25, prior:8, kind:"number", source:"ServiceTitan", subtitle:"165 sold · 170 cancels/expirations", sparkline:[18,14,10,7,3,-1,-5], playbook:[action("Launch cancellation saves","Route cancellation requests to a trained save specialist."),action("Fix the top cancellation reason","Segment price, service, move, and payment failures.")] },
  { id:"open-capacity", section:"executive", title:"Open Capacity · Next 3 Days", actual:42, goal:18, prior:36, kind:"number", source:"ServiceTitan", subtitle:"Available technician slots", direction:"lower", sparkline:[28,31,33,38,44,46,42], playbook:[action("Fill tomorrow first","Prioritize outbound and reschedules against near-term openings."),action("Align marketing spend","Shift demand generation toward the trades with capacity.")] },

  { id:"hvac-revenue", section:"revenue", title:"HVAC Revenue", actual:3485438, goal:3447539, prior:3210440, kind:"currency", source:"ServiceTitan", subtitle:"101.1% of MTD budget", sparkline:[91,93,96,99,100,101,101] },
  { id:"plumbing-revenue", section:"revenue", title:"Plumbing Revenue", actual:295483, goal:404999, prior:312000, kind:"currency", source:"ServiceTitan", subtitle:"$109,516 behind MTD budget", sparkline:[81,79,78,76,75,74,73] },
  { id:"electrical-revenue", section:"revenue", title:"Electrical Revenue", actual:0, prior:0, kind:"currency", source:"ServiceTitan", subtitle:"No budget or mapped division", sparkline:[0,0,0,0,0,0,0] },
  { id:"ytd-revenue", section:"revenue", title:"Revenue YTD", actual:14358006, goal:14610912, prior:13172000, kind:"currency", source:"ServiceTitan", subtitle:"98.3% of YTD budget", warningAt:98, sparkline:[92,94,95,96,97,98,98] },
  { id:"pipeline", section:"revenue", title:"Committed Pipeline", actual:1184000, goal:1350000, prior:1050000, kind:"currency", source:"Derived", subtitle:"Won estimates · not yet invoiced", sparkline:[71,74,78,80,82,86,88] },
  { id:"annual-forecast", section:"revenue", title:"Annual Forecast", actual:43074019, goal:51860182, prior:42100000, kind:"currency", source:"Derived", subtitle:"83.1% of annual budget", sparkline:[78,80,81,82,82,83,83] },

  { id:"inbound-calls", section:"calls", title:"Inbound Calls", actual:2840, goal:3300, prior:2710, kind:"number", source:"Call System", subtitle:"All departments · MTD", sparkline:[108,115,120,124,129,127,129] },
  { id:"calls-booked", section:"calls", title:"Calls Booked", actual:1988, goal:2376, prior:1854, kind:"number", source:"ServiceTitan", subtitle:"Converted to appointments", sparkline:[62,64,66,68,70,71,70] },
  { id:"calls-not-booked", section:"calls", title:"Not Booked", actual:852, goal:660, prior:856, kind:"number", source:"ServiceTitan", subtitle:"30% of inbound calls", direction:"lower", sparkline:[34,33,32,31,29,29,30] },
  { id:"digital-visits", section:"calls", title:"Digital Visits", actual:18420, goal:20000, prior:17620, kind:"number", source:"GA4", subtitle:"Requires GA4 connection", sparkline:[72,76,80,84,88,90,92] },
  { id:"digital-bookings", section:"calls", title:"Digital Bookings", actual:553, goal:921, prior:488, kind:"number", source:"Custom", subtitle:"Form + scheduler + chat events", sparkline:[48,51,54,56,58,59,60] },
  { id:"digital-conversion", section:"calls", title:"Digital Conversion", actual:3.0, goal:5, prior:2.8, kind:"percent", source:"Derived", subtitle:"Bookings ÷ qualified visits", sparkline:[2.4,2.5,2.7,2.8,2.9,3,3] },

  { id:"hvac-service-appts", section:"appointments", title:"HVAC Service Appointments", actual:1616, goal:3089, prior:1548, kind:"number", source:"ServiceTitan", subtitle:"52.3% of MTD target", sparkline:[46,47,49,50,51,52,52] },
  { id:"plumbing-appts", section:"appointments", title:"Plumbing Appointments", actual:345, goal:589, prior:331, kind:"number", source:"ServiceTitan", subtitle:"58.6% of MTD target", sparkline:[51,52,54,55,57,58,59] },
  { id:"hvac-sales-appts", section:"appointments", title:"HVAC Sales Opportunities", actual:527, goal:545, prior:501, kind:"number", source:"ServiceTitan", subtitle:"96.7% of MTD target", warningAt:95, sparkline:[88,90,92,94,95,96,97] },
  { id:"old-equipment", section:"appointments", title:"10+ Year Equipment Calls", actual:485, goal:620, prior:452, kind:"number", source:"ServiceTitan", subtitle:"Equipment data completeness: 82%", sparkline:[68,70,72,74,76,77,78] },
  { id:"capacity-util", section:"appointments", title:"Capacity Utilization", actual:81.3, goal:90, prior:78.2, kind:"percent", source:"Derived", subtitle:"Booked hours ÷ available hours", sparkline:[74,75,77,79,80,82,81] },

  { id:"hvac-close", section:"sales", title:"HVAC Close Rate", actual:33, goal:42, prior:31, kind:"percent", source:"ServiceTitan", subtitle:"174 sold of 527 opportunities", sparkline:[28,29,30,31,32,33,33] },
  { id:"hvac-maintenance-close", section:"sales", title:"HVAC Maintenance Close Rate", actual:58, goal:62, prior:56, kind:"percent", source:"ServiceTitan", subtitle:"Qualified maintenance opportunities sold", sparkline:[53,54,55,56,57,58,58] },
  { id:"plumbing-close", section:"sales", title:"Plumbing Close Rate", actual:47, goal:45, prior:43, kind:"percent", source:"ServiceTitan", subtitle:"46 sold of 98 opportunities", sparkline:[39,41,42,43,45,46,47] },
  { id:"hvac-ticket", section:"sales", title:"HVAC Sold Avg Ticket", actual:18663, goal:17500, prior:17840, kind:"currency", source:"ServiceTitan", subtitle:"Across sold replacement opportunities", sparkline:[16900,17200,17600,17900,18100,18400,18663] },
  { id:"revenue-per-opportunity", section:"sales", title:"Revenue per Opportunity", actual:6322, goal:7200, prior:5980, kind:"currency", source:"Derived", subtitle:"Sold revenue ÷ all opportunities", sparkline:[5400,5600,5800,5900,6100,6200,6322] },
  { id:"unsold-followup", section:"sales", title:"Unsold Follow-Up Compliance", actual:61, goal:95, prior:54, kind:"percent", source:"Custom", subtitle:"Requires CRM activity mapping", sparkline:[46,48,51,54,57,59,61] },

  { id:"active-members", section:"membership", title:"Active Members", actual:8658, goal:8750, prior:8663, kind:"number", source:"ServiceTitan", subtitle:"Active recurring memberships", warningAt:98, sparkline:[8663,8672,8681,8678,8670,8664,8658] },
  { id:"new-members", section:"membership", title:"New Memberships", actual:165, goal:200, prior:151, kind:"number", source:"ServiceTitan", subtitle:"Sold MTD", sparkline:[62,68,71,75,78,81,83] },
  { id:"member-cancels", section:"membership", title:"Cancellations + Expirations", actual:170, goal:120, prior:143, kind:"number", source:"ServiceTitan", subtitle:"Includes failed renewals", direction:"lower", sparkline:[112,120,127,138,149,159,170] },
  { id:"club-conversion", section:"membership", title:"Club Conversion", actual:11.9, goal:20, prior:10.4, kind:"percent", source:"ServiceTitan", subtitle:"Sales ÷ eligible opportunities", sparkline:[8,9,9,10,11,12,12] },
  { id:"recurring-revenue", section:"membership", title:"Monthly Recurring Revenue", actual:171428, goal:180000, prior:169901, kind:"currency", source:"Derived", subtitle:"Active agreements · normalized MRR", warningAt:95, sparkline:[162000,164000,166000,168000,169000,170000,171428] },
];

export function getMetrics(location: LocationConfig): Metric[] {
  return baseMetrics.map((metric) => {
    const isRate = metric.kind === "percent" || metric.kind === "ratio";
    const scale = isRate ? 1 + (location.metricScale - 1) * 0.08 : location.metricScale;
    return {
      ...metric,
      actual: Number((metric.actual * scale).toFixed(isRate ? 1 : 0)),
      goal: metric.goal === undefined ? undefined : Number((metric.goal * (isRate ? 1 : location.metricScale)).toFixed(isRate ? 1 : 0)),
      prior: metric.prior === undefined ? undefined : Number((metric.prior * scale).toFixed(isRate ? 1 : 0)),
      sparkline: metric.sparkline.map((n) => Number((n * (isRate ? 1 : location.metricScale)).toFixed(1))),
    };
  });
}

export const sectionMeta = {
  executive: { label: "Executive Pulse", description: "The eight numbers a GM should act on today." },
  revenue: { label: "Revenue & Forecast", description: "Actual, budget, pipeline, and projected performance." },
  calls: { label: "Calls & Digital", description: "Demand volume, booking effectiveness, and digital conversion." },
  appointments: { label: "Appointments & Capacity", description: "Booked demand, call mix, equipment opportunity, and capacity." },
  sales: { label: "Sales & Close Rates", description: "Opportunity conversion, ticket economics, and follow-up discipline." },
  membership: { label: "Membership", description: "Growth, retention, recurring revenue, and field conversion." },
} as const;
