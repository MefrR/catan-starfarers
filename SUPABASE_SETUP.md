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
-- (drop-if-exists makes the whole script safe to re-run.)
drop policy if exists "profiles are public to read" on public.profiles;
create policy "profiles are public to read"
  on public.profiles for select using (true);

-- You may only create/update YOUR OWN profile row.
drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile"
  on public.profiles for insert with check (auth.uid() = id);
drop policy if exists "update own profile" on public.profiles;
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

## Schema v2 — username + game history (run this too)

This adds a **username** to profiles (for friends, added later), and the
**games** / **game_players** tables for win-loss records and history. Stats are
viewable by anyone signed in (your choice). Paste into the SQL editor → Run.

```sql
-- Username (unique, case-insensitive). Nullable until the player picks one.
alter table public.profiles add column if not exists username text;
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

-- One row per finished game (full final table snapshot for history detail).
create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  client_game_id text unique,           -- dedupe: the in-engine game id
  recorder_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  target_vp int not null default 15,
  vs_ai boolean not null default false, -- single-player / had AI rivals
  winner_name text,
  winner_color text,
  players jsonb not null default '[]'::jsonb  -- [{name,color,vp,placement,isAi,userId,stats}]
);

-- One row per HUMAN account in a game — the fast "my games" index.
create table if not exists public.game_players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references public.games (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  result text not null,                 -- 'win' | 'loss'
  placement int not null,               -- 1 = winner
  final_vp int not null default 0
);
create index if not exists game_players_user_idx on public.game_players (user_id);

alter table public.games enable row level security;
alter table public.game_players enable row level security;

-- Anyone signed in can READ games + results (you chose public stats).
-- (drop-if-exists makes this safe to re-run.)
drop policy if exists "games readable" on public.games;
create policy "games readable" on public.games
  for select to authenticated using (true);
drop policy if exists "game_players readable" on public.game_players;
create policy "game_players readable" on public.game_players
  for select to authenticated using (true);

-- Each signed-in client records the game it just finished as the recorder, plus
-- its OWN result row. This covers BOTH single-player and online: in an online
-- game every human client runs this, so the first one inserts the shared game
-- snapshot (client_game_id is unique) and each writes its own game_players row.
drop policy if exists "insert own game" on public.games;
create policy "insert own game" on public.games
  for insert to authenticated with check (auth.uid() = recorder_id);
drop policy if exists "insert own result" on public.game_players;
create policy "insert own result" on public.game_players
  for insert to authenticated with check (auth.uid() = user_id);
```

## Schema v3 — friends (run this too)

Adds the `friendships` table for friend requests and accepted friends. Players
find each other by **username**. Paste into the SQL editor → Run.

```sql
create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users (id) on delete cascade,
  addressee_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending',          -- 'pending' | 'accepted'
  created_at timestamptz not null default now(),
  unique (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
create index if not exists friendships_addressee_idx on public.friendships (addressee_id);
create index if not exists friendships_requester_idx on public.friendships (requester_id);

alter table public.friendships enable row level security;

-- Either party can see the friendship row.
drop policy if exists "see own friendships" on public.friendships;
create policy "see own friendships" on public.friendships for select to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id);
-- You may only create a request AS yourself (the requester).
drop policy if exists "send friend request" on public.friendships;
create policy "send friend request" on public.friendships for insert to authenticated
  with check (auth.uid() = requester_id);
-- The addressee accepts a request (updates its status).
drop policy if exists "respond to request" on public.friendships;
create policy "respond to request" on public.friendships for update to authenticated
  using (auth.uid() = addressee_id);
-- Either party may delete (decline, cancel a sent request, or unfriend).
drop policy if exists "remove friendship" on public.friendships;
create policy "remove friendship" on public.friendships for delete to authenticated
  using (auth.uid() = requester_id or auth.uid() = addressee_id);
```

Phase: **presence/invites** land here when we build them next.
