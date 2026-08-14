# KPI Data-Source Matrix

## Availability summary

| KPI family | Preferred source | Feasibility | Main limitation / decision |
|---|---|---:|---|
| Completed revenue | ServiceTitan jobs/invoices | High | Revenue recognition, adjustments, taxes, and excluded business units must be defined |
| Revenue by trade/division | ServiceTitan + BU mapping | High | Each tenant uses different business-unit vocabulary |
| Budgets and targets | CSV / ERP / planning tool | Medium | Standard ServiceTitan APIs are not a dependable portfolio budget source |
| Actual + committed pipeline | ServiceTitan invoices + won estimates + scheduled jobs | High | Must define sold estimate join, period window, and completed-job exclusion |
| Month/year forecast | Derived | Medium | Requires governed model, remaining workdays, seasonality, capacity, and pipeline |
| Appointments | ServiceTitan | High | Status, cancellation, recall, and department mappings vary |
| Capacity utilization | ServiceTitan + schedule/employee config | Medium | Available hours and non-working time must be configured |
| Sales opportunities / close rate | ServiceTitan estimates/jobs | High | "Opportunity," "sold," lead type, and credit rules differ by tenant |
| Average ticket / RPA | ServiceTitan | High | Decide invoiced vs sold revenue and denominator eligibility |
| Membership active/new/canceled | ServiceTitan memberships | High | Tier names, statuses, billing failures, pauses, and duplicate names vary |
| Club conversion | ServiceTitan | Medium | Eligible opportunity denominator is tenant-specific |
| Inbound calls | ServiceTitan Call Center or phone system | Medium | API entitlement and phone-routing topology vary |
| Call booking rate | Call records + bookings | Medium | Deduplication, abandoned calls, spam, transfers, and call-to-job matching matter |
| Digital visits | GA4 | High with connector | GA4 property access and qualified-session definition required |
| Digital bookings | Booking scheduler, forms, chat, ST | Medium | Cross-system identity and duplicate conversion events are the hardest issue |
| Digital conversion rate | Derived from GA4 + booking events | Medium | Numerator and denominator must share channel/date attribution |
| Equipment age | ServiceTitan equipment | Quality-dependent | Missing install dates or incomplete equipment records can bias results materially |
| Review pace / rating | Google Business Profile or review platform | High with connector | Location mapping and API access required |

## Required tenant setup decisions

### Financial

- completed vs invoiced vs collected revenue
- gross vs net of discounts, taxes, refunds, financing fees
- division rollups and excluded units
- budget version and monthly distribution
- workday calendar and forecast methodology

### Calls

- inbound eligible calls
- abandoned, spam, duplicate, transfer, and after-hours treatment
- booked definition and booking window
- attribution when one call produces multiple jobs

### Sales

- opportunity denominator
- sold status and revenue amount
- lead type mapping (Tech Lead, NCE, Team Visit, marketing lead)
- primary vs split credit
- cancellation and rescission handling

### Membership

- active, suspended, canceled, expired, and failed-payment definitions
- eligible conversion opportunities
- recurring revenue normalization
- duplicate or renamed membership tiers

## Digital warning

"Digital visits" and "digital bookings" should not be represented as ServiceTitan-native KPIs. Visits belong in analytics; bookings often exist across website forms, embedded scheduler, chat, phone, and ServiceTitan. The correct implementation creates a canonical booking event with source IDs and deduplication rules.

Until connected, the dashboard must show these as **Unavailable / integration required**, not zero. Zero is a valid operational value; unavailable is a data state.
