-- set_updated_at() is a trigger helper, but as a SECURITY DEFINER function in
-- the public schema it was also reachable as /rest/v1/rpc/set_updated_at by the
-- anon and authenticated roles. It needs neither: the trigger fires as the
-- table owner regardless, so drop the elevated rights and take EXECUTE away
-- from everyone.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from public;
revoke execute on function public.set_updated_at() from anon;
revoke execute on function public.set_updated_at() from authenticated;
