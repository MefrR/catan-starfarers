import { createClient, type SupabaseClient, type Session } from "@supabase/supabase-js";
import type { PlayerColor } from "@starfarers/shared";

/**
 * Accounts layer (Supabase). Sign-in, the current session, and the player's
 * profile (display name, favorite color, username) live here. Everything
 * degrades gracefully when Supabase isn't configured: `isAuthConfigured` is
 * false, the sign-in UI hides itself, and single-player keeps working untouched.
 *
 * The URL + anon key are PUBLIC by design (Row-Level Security guards the data);
 * they're injected at build time via VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.
 */

const URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "";
const ANON = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? "";

/** True only when both build-time keys are present. */
export const isAuthConfigured = URL.length > 0 && ANON.length > 0;

/** A player's saved profile. Mirrors the `profiles` table. */
export interface Profile {
  id: string;
  displayName: string;
  favoriteColor: PlayerColor;
  /** Unique handle for friends; null until the player picks one. */
  username: string | null;
}

type AuthListener = (profile: Profile | null) => void;

class Auth {
  private supabase: SupabaseClient | null = null;
  private session: Session | null = null;
  private profile: Profile | null = null;
  private listeners = new Set<AuthListener>();
  private ready: Promise<void>;

  constructor() {
    if (!isAuthConfigured) {
      this.ready = Promise.resolve();
      return;
    }
    this.supabase = createClient(URL, ANON, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    // Resolve the initial session (handles the OAuth redirect landing back here),
    // then keep the cached profile in sync with every future auth change.
    this.ready = this.supabase.auth.getSession().then(async ({ data }) => {
      await this.adopt(data.session);
    });
    this.supabase.auth.onAuthStateChange((_event, session) => {
      void this.adopt(session);
    });
  }

  /** Awaitable: the first session lookup (incl. OAuth redirect) has settled. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  get signedIn(): boolean {
    return !!this.session;
  }

  /** The current profile (null when signed out / unconfigured). */
  currentProfile(): Profile | null {
    return this.profile;
  }

  /** The access token for authenticating to the game server (later phases). */
  accessToken(): string | null {
    return this.session?.access_token ?? null;
  }

  /** The signed-in user's id, or null. */
  userId(): string | null {
    return this.session?.user.id ?? null;
  }

  /** Raw Supabase client for the social/stats layer (null when unconfigured). */
  client(): SupabaseClient | null {
    return this.supabase;
  }

  /** Is a username free? (case-insensitive). False when unconfigured/too short. */
  async isUsernameAvailable(name: string): Promise<boolean> {
    if (!this.supabase) return false;
    const handle = name.trim();
    if (handle.length < 3) return false;
    const { data } = await this.supabase
      .from("profiles")
      .select("id")
      .ilike("username", handle)
      .maybeSingle();
    return !data || (data.id as string) === this.profile?.id; // ours is fine to keep
  }

  /** Subscribe to sign-in / sign-out / profile edits. Fires once immediately. */
  onChange(fn: AuthListener): () => void {
    this.listeners.add(fn);
    fn(this.profile);
    return () => this.listeners.delete(fn);
  }

  /** Begin Google OAuth — redirects away and back to this origin. */
  async signInWithGoogle(): Promise<void> {
    if (!this.supabase) return;
    await this.supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: location.origin },
    });
  }

  async signOut(): Promise<void> {
    if (!this.supabase) return;
    await this.supabase.auth.signOut();
    // adopt(null) fires via onAuthStateChange, clearing the profile + notifying.
  }

  /** Persist profile edits (display name / favorite color / username). */
  async updateProfile(
    patch: Partial<Pick<Profile, "displayName" | "favoriteColor" | "username">>,
  ): Promise<void> {
    if (!this.supabase || !this.profile) return;
    const row: Record<string, string> = {};
    if (patch.displayName !== undefined) row.display_name = patch.displayName;
    if (patch.favoriteColor !== undefined) row.favorite_color = patch.favoriteColor;
    if (patch.username) row.username = patch.username;
    if (Object.keys(row).length === 0) return;
    const { error } = await this.supabase.from("profiles").update(row).eq("id", this.profile.id);
    if (error) throw error;
    this.profile = { ...this.profile, ...patch };
    this.emit();
  }

  /** Adopt a new session: fetch (or wait for the trigger to create) the profile. */
  private async adopt(session: Session | null): Promise<void> {
    this.session = session;
    if (!session || !this.supabase) {
      this.profile = null;
      this.emit();
      return;
    }
    this.profile = await this.fetchProfile(session.user.id, session);
    this.emit();
  }

  /** Read the profile row; retry briefly in case the signup trigger is mid-flight. */
  private async fetchProfile(id: string, session: Session): Promise<Profile> {
    const fallbackName =
      (session.user.user_metadata?.full_name as string | undefined) ??
      (session.user.user_metadata?.name as string | undefined) ??
      session.user.email?.split("@")[0] ??
      "Commander";
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data } = await this.supabase!.from("profiles")
        .select("id, display_name, favorite_color, username")
        .eq("id", id)
        .maybeSingle();
      if (data) {
        return {
          id: data.id as string,
          displayName: (data.display_name as string) || fallbackName,
          favoriteColor: ((data.favorite_color as string) || "blue") as PlayerColor,
          username: (data.username as string | null) ?? null,
        };
      }
      await new Promise((r) => setTimeout(r, 400)); // trigger may not have run yet
    }
    // No row yet — return a sensible default; the next edit will create it.
    return { id, displayName: fallbackName, favoriteColor: "blue", username: null };
  }

  private emit(): void {
    for (const l of this.listeners) l(this.profile);
  }
}

export const auth = new Auth();
