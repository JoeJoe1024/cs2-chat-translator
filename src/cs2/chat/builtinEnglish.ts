import type { TokenMap } from "./templates";

/**
 * English chat templates, read from `resource/csgo_english.txt` inside the CS2 install's pak01_dir.vpk
 * (verified 2026-10-24 on a local install). Used ONLY when the game files cannot be read, so the
 * app still understands English chat; every other language requires the game files.
 */
export const BUILTIN_ENGLISH_TOKENS: TokenMap = {
  Cstrike_Chat_CT_Loc: " [CT] \u0003%s1\u0004﹫%s3\u0001: %s2",
  Cstrike_Chat_T_Loc: " [T] \u0003%s1\u0004﹫%s3\u0001: %s2",
  Cstrike_Chat_CT_Dead: " [CT] \u0003%s1 \b[DEAD]\u0001: %s2",
  Cstrike_Chat_T_Dead: " [T] \u0003%s1 \b[DEAD]\u0001: %s2",
  Cstrike_Chat_CT: " [CT] \u0003%s1: \u0001%s2",
  Cstrike_Chat_T: " [T] \u0003%s1: \u0001%s2",
  Cstrike_Chat_All: " \u0001[ALL] \u0003%s1\u0001: %s2",
  Cstrike_Chat_AllDead: " \u0001[ALL] \u0003%s1 \b[DEAD]\u0001: %s2",
  Cstrike_Chat_AllSpec: " \u0001[ALL] \u0001%s1 \b[SPEC]\u0001: %s2",
  Cstrike_Chat_Spec: " \u0001%s1 \b[SPEC]\u0001: %s2",
};
