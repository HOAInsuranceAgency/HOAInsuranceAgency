import { useEffect, useState } from 'react';
import { agencyDay } from '../../../shared/leadActionGuidance';

/** Date-based follow-ups wake even when the Leads tab stays open overnight. */
export function useAgencyDay() {
  const [today, setToday] = useState(() => agencyDay(new Date().toISOString()));
  useEffect(() => {
    const update = () => setToday(agencyDay(new Date().toISOString()));
    const timer = window.setInterval(update, 30_000);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
    };
  }, []);
  return today;
}
