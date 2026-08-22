-- Fix business_unit_mappings on v2 draft bindings
-- Copy from corresponding archived v1 binding for each department-scoped KPI

begin;

-- electrical-revenue (completed-revenue v2)
update custom_kpi_location_bindings
set business_unit_mappings = '{"includedBusinessUnitIds": ["161649735", "161649737", "161649736", "161649747", "457", "453", "455", "161649734"]}',
    updated_at = now()
where id = '90948a4e-d2b8-44ef-a8dc-5fdfa796449d'
  and approval_status = 'draft';

-- hvac-revenue (completed-revenue v2)
update custom_kpi_location_bindings
set business_unit_mappings = '{"includedBusinessUnitIds": ["124928171", "124928174", "154687321", "154691820", "7695", "8085", "7949", "7698", "124928941", "124928938", "154681497", "154684495", "7831", "6534", "8087", "6540", "154681094", "8204", "7832", "161649738", "161649740", "161649739"]}',
    updated_at = now()
where id = '54d9dd90-e1ef-46da-958c-80d6da7ffa95'
  and approval_status = 'draft';

-- plumbing-revenue (completed-revenue v2)
update custom_kpi_location_bindings
set business_unit_mappings = '{"includedBusinessUnitIds": ["161649720", "124692394", "161649719", "161649721", "161649722", "124468396", "124467371"]}',
    updated_at = now()
where id = '93c8cc1f-c0f7-4fdb-80d3-108f3971b8ae'
  and approval_status = 'draft';

-- hvac-ticket (average-invoice-ticket v2) — same BUs as hvac-revenue
update custom_kpi_location_bindings
set business_unit_mappings = '{"includedBusinessUnitIds": ["124928171", "124928174", "154687321", "154691820", "7695", "8085", "7949", "7698", "124928941", "124928938", "154681497", "154684495", "7831", "6534", "8087", "6540", "154681094", "8204", "7832", "161649738", "161649740", "161649739"]}',
    updated_at = now()
where id = 'cc279bda-8142-43ad-8174-580cbd8186ff'
  and approval_status = 'draft';

-- hvac-close (sales-close-rate v2)
update custom_kpi_location_bindings
set business_unit_mappings = '{"includedBusinessUnitIds": ["124928171", "124928174", "154687321", "154691820", "7695", "8085", "7949", "7698"]}',
    updated_at = now()
where id = 'bf423eda-0fc9-4c74-bb0d-2276cb218f60'
  and approval_status = 'draft';

-- hvac-maintenance-close (sales-close-rate v2)
update custom_kpi_location_bindings
set business_unit_mappings = '{"includedBusinessUnitIds": ["124928941", "124928938", "154681497", "154684495", "7831", "6534", "8087", "6540"]}',
    updated_at = now()
where id = '693c605f-2310-49e4-b2d9-c2ca03d220c8'
  and approval_status = 'draft';

-- plumbing-close (sales-close-rate v2)
update custom_kpi_location_bindings
set business_unit_mappings = '{"includedBusinessUnitIds": ["161649720", "124692394", "161649719", "161649721", "161649722", "124468396", "124467371"]}',
    updated_at = now()
where id = '57a603b6-7ca0-4d78-83f2-04f432f5ebcc'
  and approval_status = 'draft';

-- sales-close (sales-close-rate v2) — company-wide, leave empty

-- revenue-mtd (completed-revenue v2) — company-wide, leave empty

-- ytd-revenue (completed-revenue v2) — company-wide, leave empty

-- avg-ticket (average-invoice-ticket v2) — company-wide, leave empty

commit;