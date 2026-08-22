-- Rebind Executive KPIs from v1 → v2 recipes
-- Archives old approved v1 bindings and creates v2 draft replacements
--
-- Organization: 485d1e87-5af9-431a-87b2-243b76ac2007 (LEX Air)
-- Connection:    db763b82-02e2-4d1a-ada9-cf2d8a8a2e4d
-- Location:     5fb20f0d-7cb1-4717-b343-6ff2656ddc13
-- Tenant:       1498628772

begin;

-- ====== completed-revenue v1 → v2 ======

-- electrical-revenue: archive old, create draft
update custom_kpi_location_bindings
set approval_status = 'archived',
    updated_at = now()
where id = '6d52c643-540b-44cb-acb7-102ef3fc1831'
  and approval_status = 'approved';

insert into custom_kpi_location_bindings
  (organization_id, kpi_definition_id, location_id, connection_id, service_titan_tenant_id,
   source_method, endpoint_recipe_id, endpoint_recipe_version, refresh_interval,
   observation_window, parameter_values, approval_status)
values
  ('485d1e87-5af9-431a-87b2-243b76ac2007', '6888d6e7-df70-4095-a144-a79ef3056743',
   '5fb20f0d-7cb1-4717-b343-6ff2656ddc13', 'db763b82-02e2-4d1a-ada9-cf2d8a8a2e4d', '1498628772',
   'endpoint_recipe', 'completed-revenue', 2, '1h',
   'mtd', '{}', 'draft');

-- hvac-revenue: archive old, create draft
update custom_kpi_location_bindings
set approval_status = 'archived',
    updated_at = now()
where id = '7e1dcb17-f7b7-4d2d-a99e-965afa87db01'
  and approval_status = 'approved';

insert into custom_kpi_location_bindings
  (organization_id, kpi_definition_id, location_id, connection_id, service_titan_tenant_id,
   source_method, endpoint_recipe_id, endpoint_recipe_version, refresh_interval,
   observation_window, parameter_values, approval_status)
values
  ('485d1e87-5af9-431a-87b2-243b76ac2007', 'dd703023-9247-443a-98e6-1575be46ded6',
   '5fb20f0d-7cb1-4717-b343-6ff2656ddc13', 'db763b82-02e2-4d1a-ada9-cf2d8a8a2e4d', '1498628772',
   'endpoint_recipe', 'completed-revenue', 2, '1h',
   'mtd', '{}', 'draft');

-- plumbing-revenue: archive old, create draft
update custom_kpi_location_bindings
set approval_status = 'archived',
    updated_at = now()
where id = 'e4e52f71-0183-4fc5-9772-23a63d361afc'
  and approval_status = 'approved';

insert into custom_kpi_location_bindings
  (organization_id, kpi_definition_id, location_id, connection_id, service_titan_tenant_id,
   source_method, endpoint_recipe_id, endpoint_recipe_version, refresh_interval,
   observation_window, parameter_values, approval_status)
values
  ('485d1e87-5af9-431a-87b2-243b76ac2007', '94004490-5096-4416-bc27-370d4fcbca03',
   '5fb20f0d-7cb1-4717-b343-6ff2656ddc13', 'db763b82-02e2-4d1a-ada9-cf2d8a8a2e4d', '1498628772',
   'endpoint_recipe', 'completed-revenue', 2, '1h',
   'mtd', '{}', 'draft');

-- revenue-mtd: archive old, create draft
update custom_kpi_location_bindings
set approval_status = 'archived',
    updated_at = now()
where id = '836bebe8-38e3-4013-817a-1d74614332a9'
  and approval_status = 'approved';

insert into custom_kpi_location_bindings
  (organization_id, kpi_definition_id, location_id, connection_id, service_titan_tenant_id,
   source_method, endpoint_recipe_id, endpoint_recipe_version, refresh_interval,
   observation_window, parameter_values, approval_status)
values
  ('485d1e87-5af9-431a-87b2-243b76ac2007', 'dbbe296e-f4a6-4a95-9b11-00e772f08177',
   '5fb20f0d-7cb1-4717-b343-6ff2656ddc13', 'db763b82-02e2-4d1a-ada9-cf2d8a8a2e4d', '1498628772',
   'endpoint_recipe', 'completed-revenue', 2, '1h',
   'mtd', '{}', 'draft');

-- ytd-revenue: archive old, create draft (note: 4h refresh interval)
update custom_kpi_location_bindings
set approval_status = 'archived',
    updated_at = now()
where id = '933ae8b0-5236-490f-af8b-12c9dbe92ddf'
  and approval_status = 'approved';

insert into custom_kpi_location_bindings
  (organization_id, kpi_definition_id, location_id, connection_id, service_titan_tenant_id,
   source_method, endpoint_recipe_id, endpoint_recipe_version, refresh_interval,
   observation_window, parameter_values, approval_status)
values
  ('485d1e87-5af9-431a-87b2-243b76ac2007', '37a39e95-4553-4ba4-b23d-85723b2c7c9e',
   '5fb20f0d-7cb1-4717-b343-6ff2656ddc13', 'db763b82-02e2-4d1a-ada9-cf2d8a8a2e4d', '1498628772',
   'endpoint_recipe', 'completed-revenue', 2, '4h',
   'ytd', '{}', 'draft');

-- ====== average-invoice-ticket v1 → v2 ======

-- avg-ticket: archive old, create draft
update custom_kpi_location_bindings
set approval_status = 'archived',
    updated_at = now()
where id = 'd75420b1-46bd-4dfd-aa9f-e29c863da9f7'
  and approval_status = 'approved';

insert into custom_kpi_location_bindings
  (organization_id, kpi_definition_id, location_id, connection_id, service_titan_tenant_id,
   source_method, endpoint_recipe_id, endpoint_recipe_version, refresh_interval,
   observation_window, parameter_values, approval_status)
values
  ('485d1e87-5af9-431a-87b2-243b76ac2007', 'db4becfe-2b27-4220-8b15-809d3fe9a150',
   '5fb20f0d-7cb1-4717-b343-6ff2656ddc13', 'db763b82-02e2-4d1a-ada9-cf2d8a8a2e4d', '1498628772',
   'endpoint_recipe', 'average-invoice-ticket', 2, '1h',
   'mtd', '{}', 'draft');

-- hvac-ticket: archive old, create draft
update custom_kpi_location_bindings
set approval_status = 'archived',
    updated_at = now()
where id = '508daa1e-01ac-40cc-90cd-02ccd7097c92'
  and approval_status = 'approved';

insert into custom_kpi_location_bindings
  (organization_id, kpi_definition_id, location_id, connection_id, service_titan_tenant_id,
   source_method, endpoint_recipe_id, endpoint_recipe_version, refresh_interval,
   observation_window, parameter_values, approval_status)
values
  ('485d1e87-5af9-431a-87b2-243b76ac2007', 'ca09f192-c530-4e6c-9a94-29bcbdaf97d6',
   '5fb20f0d-7cb1-4717-b343-6ff2656ddc13', 'db763b82-02e2-4d1a-ada9-cf2d8a8a2e4d', '1498628772',
   'endpoint_recipe', 'average-invoice-ticket', 2, '1h',
   'mtd', '{}', 'draft');

-- ====== sales-close-rate v1 → v2 ======

-- hvac-close: archive old, create draft with soldThreshold
update custom_kpi_location_bindings
set approval_status = 'archived',
    updated_at = now()
where id = '104c5dc3-0dd6-49f0-a838-c56183f39e42'
  and approval_status = 'approved';

insert into custom_kpi_location_bindings
  (organization_id, kpi_definition_id, location_id, connection_id, service_titan_tenant_id,
   source_method, endpoint_recipe_id, endpoint_recipe_version, refresh_interval,
   observation_window, parameter_values, approval_status)
values
  ('485d1e87-5af9-431a-87b2-243b76ac2007', '993e4dc0-2cfb-43a9-bfe9-e3bbe5e6a474',
   '5fb20f0d-7cb1-4717-b343-6ff2656ddc13', 'db763b82-02e2-4d1a-ada9-cf2d8a8a2e4d', '1498628772',
   'endpoint_recipe', 'sales-close-rate', 2, '1h',
   'mtd', '{"soldThreshold": "1.01"}', 'draft');

-- hvac-maintenance-close: archive old, create draft with soldThreshold
update custom_kpi_location_bindings
set approval_status = 'archived',
    updated_at = now()
where id = '05f5583a-3b08-43ba-9d0f-3e39147b6d59'
  and approval_status = 'approved';

insert into custom_kpi_location_bindings
  (organization_id, kpi_definition_id, location_id, connection_id, service_titan_tenant_id,
   source_method, endpoint_recipe_id, endpoint_recipe_version, refresh_interval,
   observation_window, parameter_values, approval_status)
values
  ('485d1e87-5af9-431a-87b2-243b76ac2007', 'e6eb13fd-ed2a-4dad-90a1-fdbc4aa209ba',
   '5fb20f0d-7cb1-4717-b343-6ff2656ddc13', 'db763b82-02e2-4d1a-ada9-cf2d8a8a2e4d', '1498628772',
   'endpoint_recipe', 'sales-close-rate', 2, '1h',
   'mtd', '{"soldThreshold": "1.01"}', 'draft');

-- plumbing-close: archive old, create draft with soldThreshold
update custom_kpi_location_bindings
set approval_status = 'archived',
    updated_at = now()
where id = 'b9253bc1-a27f-4497-b8e0-2969bda25065'
  and approval_status = 'approved';

insert into custom_kpi_location_bindings
  (organization_id, kpi_definition_id, location_id, connection_id, service_titan_tenant_id,
   source_method, endpoint_recipe_id, endpoint_recipe_version, refresh_interval,
   observation_window, parameter_values, approval_status)
values
  ('485d1e87-5af9-431a-87b2-243b76ac2007', 'a492d636-2ed8-4ac4-95f0-edd336b3ee8d',
   '5fb20f0d-7cb1-4717-b343-6ff2656ddc13', 'db763b82-02e2-4d1a-ada9-cf2d8a8a2e4d', '1498628772',
   'endpoint_recipe', 'sales-close-rate', 2, '1h',
   'mtd', '{"soldThreshold": "1.01"}', 'draft');

-- sales-close: archive old, create draft with soldThreshold
update custom_kpi_location_bindings
set approval_status = 'archived',
    updated_at = now()
where id = '98085899-aa20-494b-b976-51014f8659f7'
  and approval_status = 'approved';

insert into custom_kpi_location_bindings
  (organization_id, kpi_definition_id, location_id, connection_id, service_titan_tenant_id,
   source_method, endpoint_recipe_id, endpoint_recipe_version, refresh_interval,
   observation_window, parameter_values, approval_status)
values
  ('485d1e87-5af9-431a-87b2-243b76ac2007', 'b09ced43-5930-4f74-87f8-f2a8822663df',
   '5fb20f0d-7cb1-4717-b343-6ff2656ddc13', 'db763b82-02e2-4d1a-ada9-cf2d8a8a2e4d', '1498628772',
   'endpoint_recipe', 'sales-close-rate', 2, '1h',
   'mtd', '{"soldThreshold": "1.01"}', 'draft');

commit;