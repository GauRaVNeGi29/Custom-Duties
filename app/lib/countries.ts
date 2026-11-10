// ISO 3166-1 alpha-2 country codes, names and aliases.
// Lets the CSV use either codes ("US", "GB") or names ("USA", "UK", "Germany").

const CODES = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
  "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG " +
  "UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");

export const COUNTRY_CODES: readonly string[] = CODES;

const displayNames = new Intl.DisplayNames(["en"], { type: "region" });

/** Short names Setu Store uses in its sheets; also used when exporting. */
const PREFERRED_NAME: Record<string, string> = {
  US: "USA",
  GB: "UK",
  AE: "UAE",
};

/** Extra spellings accepted on import. Keys are normalised (lowercase, letters only). */
const ALIASES: Record<string, string> = {
  usa: "US", us: "US", unitedstates: "US", unitedstatesofamerica: "US", america: "US",
  uk: "GB", gb: "GB", greatbritain: "GB", unitedkingdom: "GB", england: "GB", britain: "GB",
  uae: "AE", unitedarabemirates: "AE",
  holland: "NL", thenetherlands: "NL",
  southkorea: "KR", korea: "KR",
  russia: "RU", vietnam: "VN", turkey: "TR", turkiye: "TR",
  czechia: "CZ", czechrepublic: "CZ",
};

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");

const BY_NAME = new Map<string, string>();
for (const code of CODES) {
  BY_NAME.set(norm(code), code);
  const name = displayNames.of(code);
  if (name) BY_NAME.set(norm(name), code);
}
for (const [alias, code] of Object.entries(ALIASES)) BY_NAME.set(alias, code);

/** "USA" | "us" | "United States" -> "US". Returns null when not recognised. */
export function toCountryCode(input: string | null | undefined): string | null {
  if (!input) return null;
  return BY_NAME.get(norm(input.trim())) ?? null;
}

/** Customer-facing English name, e.g. "United States". */
export function countryName(code: string): string {
  return displayNames.of(code) ?? code;
}

/** Name used in CSV exports, matching Setu Store's own sheets ("USA", "UK", "Germany"). */
export function exportCountryName(code: string): string {
  return PREFERRED_NAME[code] ?? countryName(code);
}

/** Origins the app accepts. India only in v1; add codes here to open more origins. */
export const SUPPORTED_ORIGINS: readonly string[] = ["IN"];
