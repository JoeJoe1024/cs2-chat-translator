/**
 * Built-in CS2 chat vocabulary. One dictionary only: the matching logic lives in `glossary.ts`, user edits live in
 * the settings (`dictionary`), and both the server and the settings page read this same list.
 *
 * Every entry has an English meaning (`en`, used to explain the term to a general translator) and, where the wording is
 * standard enough to be safe, ready-made phrases per target language (`tr`). A target without a phrase simply falls
 * back to the normal translation service, and users can add their own wording for any language.
 */

export interface BuiltinEntry {
  id: string;
  /** Lower-case phrases that trigger the entry; matched as whole words, case-insensitively, longest phrase first. */
  terms: string[];
  /** Meaning in English; also what a general translator receives when the term sits inside a longer sentence. */
  en: string;
  /** Ready-made local translations by target language code. */
  tr: Partial<Record<"zh-TW" | "zh-CN" | "ja" | "ko" | "de" | "fr" | "es" | "ru" | "pt", string>>;
  /**
   * More than one plausible meaning (e.g. NC, NP, SAVE, FORCE). Only translated when it is the whole message, never
   * expanded inside a longer sentence, unless the user chose their own wording.
   */
  ambiguous?: boolean;
  /**
   * Show an English translation even when the target language is English. Off for shorthand every English reader
   * already knows (GG, WP, TY…), on for terms newcomers may not (ECO, FORCE, MB…).
   */
  showInEnglish?: boolean;
}

export const BUILTIN_ENTRIES: readonly BuiltinEntry[] = [
  {
    id: "gg",
    terms: ["gg"],
    en: "good game",
    tr: { "zh-TW": "好局", "zh-CN": "好局", ja: "いい試合", ko: "좋은 게임", de: "gutes Spiel", fr: "bien joué", es: "buen juego", ru: "хорошая игра", pt: "bom jogo" },
  },
  {
    id: "ggwp",
    terms: ["ggwp"],
    en: "good game, well played",
    tr: {
      "zh-TW": "好局，打得好",
      "zh-CN": "好局，打得好",
      ja: "いい試合、ナイスプレー",
      ko: "좋은 게임, 잘했어요",
      de: "gutes Spiel, gut gespielt",
      fr: "bien joué, bonne partie",
      es: "buen juego, bien jugado",
      ru: "хорошая игра, хорошо сыграно",
      pt: "bom jogo, bem jogado",
    },
  },
  {
    id: "wp",
    terms: ["wp"],
    en: "well played",
    tr: { "zh-TW": "打得好", "zh-CN": "打得好", ja: "ナイスプレー", ko: "잘했어요", de: "gut gespielt", fr: "bien joué", es: "bien jugado", ru: "хорошо сыграно", pt: "bem jogado" },
  },
  {
    id: "glhf",
    terms: ["glhf"],
    en: "good luck, have fun",
    tr: {
      "zh-TW": "祝好運，玩得開心",
      "zh-CN": "祝好运，玩得开心",
      ja: "頑張って、楽しもう",
      ko: "행운을 빌어요, 즐겁게 해요",
      de: "viel Glück und viel Spaß",
      fr: "bonne chance et amuse-toi bien",
      es: "buena suerte y diviértete",
      ru: "удачи и приятной игры",
      pt: "boa sorte e divirta-se",
    },
  },
  {
    id: "gl",
    terms: ["gl"],
    en: "good luck",
    tr: { "zh-TW": "祝好運", "zh-CN": "祝好运", ja: "頑張って", ko: "행운을 빌어요", de: "viel Glück", fr: "bonne chance", es: "buena suerte", ru: "удачи", pt: "boa sorte" },
  },
  {
    id: "hf",
    terms: ["hf"],
    en: "have fun",
    tr: { "zh-TW": "玩得開心", "zh-CN": "玩得开心", ja: "楽しんで", ko: "즐겁게 하세요", de: "viel Spaß", fr: "amuse-toi bien", es: "diviértete", ru: "приятной игры", pt: "divirta-se" },
  },
  {
    id: "nt",
    terms: ["nt"],
    en: "nice try",
    tr: { "zh-TW": "不錯的嘗試", "zh-CN": "不错的尝试", ja: "惜しい", ko: "좋은 시도였어요", de: "netter Versuch", fr: "bien tenté", es: "buen intento", ru: "хорошая попытка", pt: "boa tentativa" },
  },
  {
    id: "ns",
    terms: ["ns"],
    en: "nice shot",
    tr: { "zh-TW": "漂亮的一槍", "zh-CN": "漂亮的一枪", ja: "ナイスショット", ko: "나이스 샷", de: "guter Schuss", fr: "beau tir", es: "buen tiro", ru: "отличный выстрел", pt: "bom tiro" },
  },
  {
    id: "nc",
    terms: ["nc"],
    en: "nice one",
    ambiguous: true,
    tr: { "zh-TW": "漂亮", "zh-CN": "漂亮", ja: "ナイス", ko: "나이스", de: "gut gemacht", fr: "joli coup", es: "bien hecho", ru: "отлично", pt: "boa" },
  },
  {
    id: "afk",
    terms: ["afk"],
    en: "away from keyboard",
    tr: { "zh-TW": "暫時離開", "zh-CN": "暂时离开", ja: "離席中", ko: "자리 비움", de: "nicht am Rechner", fr: "absent du clavier", es: "lejos del teclado", ru: "отошёл от клавиатуры", pt: "longe do teclado" },
  },
  {
    id: "ez",
    terms: ["ez"],
    en: "too easy",
    tr: { "zh-TW": "太簡單了", "zh-CN": "太简单了", ja: "楽勝", ko: "너무 쉽네", de: "zu einfach", fr: "trop facile", es: "demasiado fácil", ru: "слишком легко", pt: "fácil demais" },
  },
  {
    id: "mb",
    terms: ["mb"],
    en: "my bad",
    showInEnglish: true,
    tr: { "zh-TW": "我的錯", "zh-CN": "我的错", ja: "ごめん、私のミス", ko: "내 실수예요", de: "mein Fehler", fr: "ma faute", es: "mi culpa", ru: "моя вина", pt: "minha culpa" },
  },
  {
    id: "thanks",
    terms: ["ty", "thx", "thanks", "thank you", "thank u"],
    en: "thank you",
    tr: { "zh-TW": "謝謝", "zh-CN": "谢谢", ja: "ありがとう", ko: "고마워요", de: "danke", fr: "merci", es: "gracias", ru: "спасибо", pt: "obrigado" },
  },
  {
    id: "np",
    terms: ["np"],
    en: "no problem",
    ambiguous: true,
    showInEnglish: true,
    tr: { "zh-TW": "沒問題", "zh-CN": "没问题", ja: "問題ないよ", ko: "문제없어요", de: "kein Problem", fr: "pas de problème", es: "no hay problema", ru: "без проблем", pt: "sem problema" },
  },
  {
    id: "sorry",
    terms: ["sorry", "sry"],
    en: "sorry",
    tr: { "zh-TW": "抱歉", "zh-CN": "抱歉", ja: "ごめん", ko: "미안해요", de: "Entschuldigung", fr: "désolé", es: "perdón", ru: "извини", pt: "desculpe" },
  },
  {
    id: "eco",
    terms: ["eco", "eco round"],
    en: "economy round",
    showInEnglish: true,
    tr: {
      "zh-TW": "經濟局（不買裝備）",
      "zh-CN": "经济局（不买装备）",
      ja: "エコラウンド（購入を控える）",
      ko: "에코 라운드(구매 안 함)",
      de: "Eco-Runde (kaum kaufen)",
      fr: "round éco (on n'achète pas)",
      es: "ronda eco (no comprar)",
      ru: "эко-раунд (не покупаем)",
      pt: "rodada eco (sem comprar)",
    },
  },
  {
    id: "force-buy",
    terms: ["force buy", "forcebuy", "force-buy"],
    en: "force buy",
    showInEnglish: true,
    tr: { "zh-TW": "強起（全力購買）", "zh-CN": "强起（全力购买）", ja: "フォースバイ", ko: "포스 바이", de: "Force-Buy", es: "compra forzada", ru: "форс-бай" },
  },
  {
    id: "force",
    terms: ["force"],
    en: "force buy",
    ambiguous: true,
    showInEnglish: true,
    tr: { "zh-TW": "強起（全力購買）", "zh-CN": "强起（全力购买）", ja: "フォースバイ", ko: "포스 바이", de: "Force-Buy", es: "compra forzada", ru: "форс-бай" },
  },
  {
    id: "save",
    terms: ["save"],
    en: "save (do not buy)",
    ambiguous: true,
    showInEnglish: true,
    tr: { "zh-TW": "保槍（這局不買）", "zh-CN": "保枪（这局不买）", ja: "セーブ（購入しない）", ko: "세이브(구매 안 함)" },
  },
  {
    id: "rush-a",
    terms: ["rush a"],
    en: "rush A",
    showInEnglish: true,
    tr: { "zh-TW": "衝 A 點", "zh-CN": "冲 A 点", ja: "Aに突っ込む", ko: "A 러시", de: "Rush A", fr: "rush A", es: "rush A", ru: "раш на A", pt: "rush A" },
  },
  {
    id: "rush-b",
    terms: ["rush b"],
    en: "rush B",
    showInEnglish: true,
    tr: { "zh-TW": "衝 B 點", "zh-CN": "冲 B 点", ja: "Bに突っ込む", ko: "B 러시", de: "Rush B", fr: "rush B", es: "rush B", ru: "раш на B", pt: "rush B" },
  },
  {
    id: "rush-mid",
    terms: ["rush mid"],
    en: "rush mid",
    showInEnglish: true,
    tr: { "zh-TW": "衝中路", "zh-CN": "冲中路", ja: "ミッドに突っ込む", ko: "미드 러시", de: "Rush Mid", fr: "rush mid", es: "rush mid", ru: "раш на мид", pt: "rush mid" },
  },
  {
    id: "hello",
    terms: ["hi", "hello", "hey"],
    en: "hello",
    tr: { "zh-TW": "你好", "zh-CN": "你好", ja: "こんにちは", ko: "안녕하세요", de: "hallo", fr: "salut", es: "hola", ru: "привет", pt: "olá" },
  },
  {
    id: "bye",
    terms: ["bye", "goodbye"],
    en: "bye",
    tr: { "zh-TW": "再見", "zh-CN": "再见", ja: "じゃあね", ko: "안녕히 가세요", de: "tschüss", fr: "au revoir", es: "adiós", ru: "пока", pt: "tchau" },
  },
  {
    id: "please",
    terms: ["pls", "plz", "please"],
    en: "please",
    tr: { "zh-TW": "拜託", "zh-CN": "拜托", ja: "お願い", ko: "제발", de: "bitte", fr: "s'il vous plaît", es: "por favor", ru: "пожалуйста", pt: "por favor" },
  },
  {
    id: "brb",
    terms: ["brb"],
    en: "be right back",
    tr: { "zh-TW": "馬上回來", "zh-CN": "马上回来", ja: "すぐ戻る", ko: "곧 올게요", de: "bin gleich zurück", fr: "je reviens", es: "ahora vuelvo", ru: "скоро вернусь", pt: "já volto" },
  },
  {
    id: "idk",
    terms: ["idk"],
    en: "I don't know",
    tr: { "zh-TW": "我不知道", "zh-CN": "我不知道", ja: "わからない", ko: "모르겠어요", de: "ich weiß nicht", fr: "je ne sais pas", es: "no lo sé", ru: "не знаю", pt: "não sei" },
  },
];
