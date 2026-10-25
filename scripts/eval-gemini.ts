/**
 * Compares Gemini models on the fixed CS2 phrase set. Needs YOUR key in the environment; nothing is saved anywhere
 * and nothing runs unless you start it (it makes paid API calls: phrases x targets x models).
 *
 *   set GEMINI_API_KEY=...        (PowerShell: $env:GEMINI_API_KEY="...")
 *   npx tsx scripts/eval-gemini.ts [model ...]      default: gemini-3.1-flash-lite gemini-3.5-flash-lite
 *
 * It prints each translation with latency and the token counts Google reports, for a human to read against the
 * `mustKeep` / `mustNot` notes in tests/fixtures/cs2Phrases.ts. There is deliberately no automatic quality score.
 */
import { GeminiEngine } from "../src/translation/gemini";
import { CS2_PHRASES, EVAL_TARGETS } from "../tests/fixtures/cs2Phrases";

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("Set GEMINI_API_KEY first. Nothing was sent.");
  process.exit(1);
}
const models = process.argv.slice(2).length ? process.argv.slice(2) : ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"];

for (const model of models) {
  let inTok = 0;
  let outTok = 0;
  const times: number[] = [];
  const counting: typeof fetch = async (url, init) => {
    const res = await fetch(url, init);
    try {
      const u = ((await res.clone().json()) as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } }).usageMetadata;
      inTok += u?.promptTokenCount ?? 0;
      outTok += (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0);
    } catch {
      /* usage is optional */
    }
    return res;
  };
  const engine = new GeminiEngine({ getApiKey: () => key, getModel: () => model, fetchImpl: counting });
  console.log(`\n=== ${model} ===`);
  for (const target of EVAL_TARGETS) {
    console.log(`-- ${target}`);
    for (const p of CS2_PHRASES) {
      const t0 = Date.now();
      try {
        const r = await engine.translate({ text: p.text, target, signal: AbortSignal.timeout(20_000) });
        const ms = Date.now() - t0;
        times.push(ms);
        console.log(`${p.text.padEnd(26)} -> ${r.text}   [${ms} ms]   (keep: ${p.mustKeep}${p.mustNot ? `; not: ${p.mustNot}` : ""})`);
      } catch (err) {
        console.log(`${p.text.padEnd(26)} -> ERROR ${(err as Error).message}`);
      }
    }
  }
  times.sort((a, b) => a - b);
  console.log(`median ${times[Math.floor(times.length / 2)] ?? "-"} ms, tokens in ${inTok} / out ${outTok} for ${times.length} calls`);
}
