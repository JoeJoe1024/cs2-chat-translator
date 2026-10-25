/** Built-in quick phrases. The wording lives in the UI dictionaries (`quick.def.<id>`), so it follows the UI language. */
export const PHRASE_CATEGORIES = ["common", "spot", "offense", "defense", "eco", "social"] as const;
export type PhraseCategory = (typeof PHRASE_CATEGORIES)[number];

export interface DefaultPhrase {
  id: string;
  /** Group the phrase belongs to besides "common". */
  cat: Exclude<PhraseCategory, "common">;
  /** Shown first, under "common". */
  common?: boolean;
}

export const DEFAULT_PHRASES: readonly DefaultPhrase[] = [
  { id: "d01", cat: "spot" },
  { id: "d02", cat: "spot" },
  { id: "d03", cat: "spot", common: true },
  { id: "d04", cat: "spot" },
  { id: "d05", cat: "spot" },
  { id: "d06", cat: "spot" },
  { id: "d07", cat: "offense", common: true },
  { id: "d08", cat: "offense", common: true },
  { id: "d09", cat: "offense" },
  { id: "d10", cat: "offense" },
  { id: "d11", cat: "offense" },
  { id: "d12", cat: "offense" },
  { id: "d13", cat: "defense", common: true },
  { id: "d14", cat: "defense" },
  { id: "d15", cat: "defense" },
  { id: "d16", cat: "defense", common: true },
  { id: "d17", cat: "defense" },
  { id: "d18", cat: "defense" },
  { id: "d19", cat: "eco" },
  { id: "d20", cat: "eco" },
  { id: "d21", cat: "eco", common: true },
  { id: "d22", cat: "social", common: true },
  { id: "d23", cat: "social" },
  { id: "d24", cat: "social", common: true },
];

/** Ids of the first release's eight built-ins; lists saved back then keep working and are replaced on "restore". */
export const LEGACY_PHRASES: Record<string, Exclude<PhraseCategory, "common">> = {
  def1: "offense",
  def2: "spot",
  def3: "defense",
  def4: "eco",
  def5: "defense",
  def6: "social",
  def7: "social",
  def8: "social",
};

const BY_ID = new Map(DEFAULT_PHRASES.map((p) => [p.id, p]));

export const isBuiltInPhraseId = (id: string): boolean => BY_ID.has(id) || id in LEGACY_PHRASES;

/** Where a phrase shows up. Phrases the user wrote themselves (and old built-ins) are always under "common". */
export function categoriesOf(id: string): PhraseCategory[] {
  const d = BY_ID.get(id);
  if (d) return d.common ? ["common", d.cat] : [d.cat];
  const legacy = LEGACY_PHRASES[id];
  return legacy ? ["common", legacy] : ["common"];
}
