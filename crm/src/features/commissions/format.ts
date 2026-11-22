import { formatUsdCents } from '../../../../shared/money';
import { agencyDay } from '../../../../shared/agencyTime';
export const money = formatUsdCents;
export const today = () => agencyDay(new Date());
