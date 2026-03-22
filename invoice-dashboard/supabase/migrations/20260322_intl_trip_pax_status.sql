-- Add passenger data upload tracking to international trips
alter table intl_trips
  add column if not exists pax_data_status text not null default 'not_started'
    check (pax_data_status in ('not_started', 'salesperson_notified', 'uploaded'));
