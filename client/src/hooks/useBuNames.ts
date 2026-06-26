import { useState, useEffect } from 'react';
import { api } from '../api/client';
import type { User } from '../types';

// Returns a map of bu_code → display_name for Responder users only.
// Falls back to the bu_code itself if the name isn't found.
export function useBuNames(): (buCode: string) => string {
  const [nameMap, setNameMap] = useState<Record<string, string>>({});

  useEffect(() => {
    api.get<User[]>('/users').then(users => {
      const map: Record<string, string> = {};
      for (const u of users) {
        if (u.role === 'Responder' && u.primary_unit_code) map[u.primary_unit_code] = u.display_name;
      }
      setNameMap(map);
    }).catch(() => {});
  }, []);

  const ALIASES: Record<string, string> = {
    '961':           'Grp. Financial & Liquidity Risk Mgmt.',
    '961-IRRBB':     'Grp. Fin. & Liquidity Risk Mgmt. (IRRBB)',
    '961-Liquidity': 'Grp. Fin. & Liquidity Risk Mgmt. (Liquidity)',
    '961-Market':    'Grp. Fin. & Liquidity Risk Mgmt. (Market)',
    '006': 'Finance Reporting (006-956)',
    '956': 'Finance Reporting (006-956)',
  };
  return (buCode: string) => nameMap[buCode] ?? ALIASES[buCode] ?? buCode;
}
