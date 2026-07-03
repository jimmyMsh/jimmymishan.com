import { readFileSync } from "node:fs";
import type { CountryResponse } from "mmdb-lib";
import { Reader } from "mmdb-lib";

export interface GeoLookup {
  country(ip: string): string;
}

const UNKNOWN = "--";

// The IP → country map. A missing or corrupt database degrades to a constant
// "--" lookup rather than throwing, so a dev image without the baked mmdb still
// boots; a per-lookup failure (e.g. an address mmdb-lib can't parse) is "--" too.
export function loadGeo(mmdbPath: string): GeoLookup {
  let reader: Reader<CountryResponse> | null = null;
  try {
    reader = new Reader<CountryResponse>(readFileSync(mmdbPath));
  } catch {
    console.warn(
      `geoip disabled: could not load country database (${mmdbPath})`,
    );
  }

  const db = reader;
  return {
    country(ip: string): string {
      if (db === null) return UNKNOWN;
      try {
        return db.get(ip)?.country?.iso_code ?? UNKNOWN;
      } catch {
        return UNKNOWN;
      }
    },
  };
}
