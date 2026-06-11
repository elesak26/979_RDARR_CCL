import { useState, useEffect } from 'react';
import { api } from '../api/client';
import type { User } from '../types';

// Returns a map of bu_code → display_name for all Responder users.
// Falls back to the bu_code itself if the name isn't found.
export function useBuNames(): (buCode: string) => string {
  const [nameMap, setNameMap] = useState<Record<string, string>>({});

  useEffect(() => {
    api.get<User[]>('/users').then(users => {
      const map: Record<string, string> = {};
      for (const u of users) {
        if (u.primary_unit_code) map[u.primary_unit_code] = u.display_name;
      }
      setNameMap(map);
    }).catch(() => {});
  }, []);

  return (buCode: string) => nameMap[buCode] ?? buCode;
}
