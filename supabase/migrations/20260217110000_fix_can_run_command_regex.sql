create or replace function public.can_run_command(policy public.agent_policy, cmd text)
returns boolean
language plpgsql
as $$
begin
  if policy = 'FULL' then
    return true;
  end if;

  if policy = 'DEV' then
    return cmd ~* '^\s*(echo|pwd|ls|dir|cat|type|whoami|date|npm|node|pnpm|yarn|git|python|py|powershell|pwsh)(\s|$)';
  end if;

  return cmd ~* '^\s*(echo|pwd|ls|dir|whoami|date)(\s|$)';
end;
$$;
