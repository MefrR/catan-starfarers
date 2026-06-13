# Accounts — Supabase setup

The game's accounts (Google sign-in, profiles, and later win/loss + game
history) live in **Supabase** — a free, always-on hosted Postgres + auth
service. It is independent of the realtime game server, so your name, color and
stats are available even when the game server is asleep.

The client reads two **public** values at build time:

| Env var | Where | Secret? |
|---|---|---|
| `VITE_SUPABASE_URL` | client build | No — safe to ship in the browser |
| `VITE_SUPABASE_ANON_KEY` | client build | No — the anon key is designed to be public; Row-Level Security protects the data |

If these are **unset**, the game still runs exactly as before — sign-in just
doesn't appear. So you can develop single-player without any of this.

> The server-only **service role key** (used later in Phase 2 to write game
> results) must NEVER ship to the browser. Set it only as a server env var
> (`SUPABASE_SERVICE_ROLE_KEY`). Do not commit it.

---

## One-time console steps (you do these — I can't enter your credentials)

1. **Create the project** — https://supabase.com → New project (free tier, no
   card). Note the **Project URL** and **anon public key** from
   *Project Settings → API*.

2. **Enable Google sign-in** — *Authentication → Providers → Google → Enable*.
   You'll need a Google OAuth client:
   - Google Cloud Console → *APIs & Services → Credentials → Create OAuth client
     ID → Web application*.
   - **Authorized redirect URI**: the value Supabase shows you on the Google
     provider page — it looks like
     `https://<your-project-ref>.supabase.co/auth/v1/callback`.
   - Paste the Google **Client ID** + **Client secret** back into Supabase.

3. **Allow your app's redirect URLs** — *Authentication → URL Configuration*:
   - **Site URL**: your main deployed origin (e.g. `https://play.designroom.studio`).
   - **Redirect URLs**: add every origin you sign in from, e.g.
     `http://localhost:5173`, your Render URL, and your Vercel URL.

4. **Run the schema** — *SQL Editor → New query* → paste the block below → Run.

5. **Set the env vars** where you build the client:
   - **Local dev**: create `client/.env.local` with the two `VITE_…` values.
   - **Render / Vercel**: add them in the dashboard's Environment Variables.

---

## Schema (paste into the Supabase SQL editor)

```sql
-- Profiles: one row per signed-in user, created automatically on signup.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Commander',
  favorite_color text not null default 'blue',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Anyone may read a profile (names/colors show up in rooms for everyone).
create policy "profiles are public to read"
  on public.profiles for select using (true);

-- You may only create/update YOUR OWN profile row.
create policy "insert own profile"
  on public.profiles for insert with check (auth.uid() = id);
create policy "update own profile"
  on public.profiles for update using (auth.uid() = id);

-- Auto-create a profile when a new auth user signs up, seeding the display
-- name from their Google profile name when present.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(new.email, '@', 1),
      'Commander'
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

Phase 2 (game history) adds `games` + `game_players` tables — documented here
when we build it.
