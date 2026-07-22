import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { Authenticator } from "@aws-amplify/ui-react";
import type { AuthUser } from "aws-amplify/auth";
import { client, type UserProfile } from "./lib/client";
import Dashboard from "./pages/Dashboard";
import AccountsList from "./pages/AccountsList";
import AccountDetail from "./pages/AccountDetail";
import NewLead from "./pages/NewLead";
import Carriers from "./pages/Carriers";
import CarrierDetail from "./pages/CarrierDetail";
import Onboarding from "./pages/Onboarding";
import Settings from "./pages/Settings";

export default function App() {
  return (
    <Authenticator>
      {({ signOut, user }) => (
        <ProfileGate user={user!} signOut={() => signOut?.()} />
      )}
    </Authenticator>
  );
}

function ProfileGate({ user, signOut }: { user: AuthUser; signOut: () => void }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    client.models.UserProfile.list({
      filter: { userId: { eq: user.userId } },
    }).then(({ data }) => {
      setProfile(data[0] ?? null);
      setLoading(false);
    });
  }, [user.userId]);

  if (loading) return <div className="main">Loading…</div>;

  if (!profile || !profile.onboardingComplete) {
    return (
      <Onboarding
        user={user}
        existing={profile}
        onComplete={(p) => setProfile(p)}
      />
    );
  }

  return <Shell profile={profile} signOut={signOut} />;
}

function Shell({ profile, signOut }: { profile: UserProfile; signOut: () => void }) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          HOA <span>CRM</span>
        </div>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/leads">Leads</NavLink>
          <NavLink to="/clients">Clients</NavLink>
          <NavLink to="/carriers">Carriers</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="spacer" />
        <div className="user">
          <div>
            {profile.firstName} {profile.lastName}
          </div>
          <div className="muted small">{profile.role}</div>
          <button onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/leads" element={<AccountsList stage="LEAD" />} />
          <Route path="/leads/new" element={<NewLead />} />
          <Route path="/clients" element={<AccountsList stage="CLIENT" />} />
          <Route path="/accounts/:id" element={<AccountDetail profile={profile} />} />
          <Route path="/carriers" element={<Carriers />} />
          <Route path="/carriers/:id" element={<CarrierDetail />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
