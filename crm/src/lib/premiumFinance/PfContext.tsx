import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { client } from "../client";
import { AGENCY_SETTINGS_ID } from "../agencySettings";

/**
 * Whether the premium-finance module is on, app-wide.
 *
 * Loaded once at shell mount and refreshable — the admin toggle on the
 * Financing page calls `refresh` after a flip so the nav and tabs follow
 * without a reload. Everything visual keys off this; the mutations re-check
 * the flag server-side, because a hidden button is not a gate.
 *
 * Reads fail CLOSED: a load error reports the module off. Rendering lending
 * controls because a settings read failed is the wrong direction to fail on a
 * regulated product.
 */
interface PfState {
  enabled: boolean;
  loaded: boolean;
  refresh: () => Promise<void>;
}

const PfContext = createContext<PfState>({
  enabled: false,
  loaded: false,
  refresh: async () => {},
});

export function PfProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { data } = await client.models.AgencySettings.get({
        id: AGENCY_SETTINGS_ID,
      });
      setEnabled(data?.premiumFinanceEnabled === true);
    } catch {
      setEnabled(false);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <PfContext.Provider value={{ enabled, loaded, refresh }}>
      {children}
    </PfContext.Provider>
  );
}

export const usePremiumFinance = () => useContext(PfContext);
