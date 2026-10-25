/**
 * Fixed set of CS2 callouts for comparing Gemini models by eye (see scripts/eval-gemini.ts).
 * `mustKeep` / `mustNot` describe what a correct translation must preserve; they are notes for the reviewer and
 * for the offline prompt test, not an automatic quality score.
 */
export interface Cs2Phrase {
  text: string;
  mustKeep: string;
  mustNot?: string;
}

export const CS2_PHRASES: Cs2Phrase[] = [
  { text: "A lot of enemies at A.", mustKeep: "many enemies, site A" },
  { text: "Three enemies at B.", mustKeep: "exactly three, site B" },
  { text: "Two mid.", mustKeep: "two enemies, middle lane" },
  { text: "Rush B!", mustKeep: "fast aggressive push to site B" },
  { text: "Rotate to A.", mustKeep: "move over to site A" },
  { text: "Eco this round.", mustKeep: "low-money round, saving money", mustNot: "ecology / environment" },
  { text: "Save your weapons.", mustKeep: "do not fight, keep the guns this round", mustNot: "rescue" },
  { text: "Don't peek.", mustKeep: "negation: do not step out", mustNot: "an instruction to peek" },
  { text: "Wait for my flash.", mustKeep: "wait for my flashbang" },
  { text: "I'm defusing.", mustKeep: "defusing the bomb" },
  { text: "One enemy behind us.", mustKeep: "exactly one enemy, behind" },
  { text: "Don't push A.", mustKeep: "negation: do not attack A", mustNot: "an instruction to attack A" },
];

/** The first targets to compare. */
export const EVAL_TARGETS = ["en", "zh-TW", "ru"] as const;
