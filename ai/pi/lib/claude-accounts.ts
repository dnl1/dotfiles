import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ACCOUNT_CHANGED = "claude-account-changed";
export const ACCOUNT_NAMES = ["trabalho", "pessoal"] as const;
// Marks the --usage-fallback model's position in the rotation. Accounts after it are reserves.
export const FALLBACK_LINK = "fallback";
export const OVERRIDES = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
];
export type ProfileName = typeof ACCOUNT_NAMES[number];
export type Profile = { name: string; directory?: string; expectedEmail?: string };
export type Account = { authenticated: boolean; email: string; plan: string; error?: string };

export function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 160) : "";
}

function expand(path: string): string {
  return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

export function accountConfig(): { profiles: Profile[]; rotation: Profile[]; reserve: Profile[] } {
  const path = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "claude-accounts.json");
  const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const profiles = ACCOUNT_NAMES.map((name) => ({
    name,
    directory: config[name]?.directory === null || (name === "trabalho" && config[name]?.directory === undefined)
      ? undefined : expand(config[name]?.directory ?? join(homedir(), ".claude-pessoal")),
    expectedEmail: clean(config[name]?.expectedEmail) || undefined,
  }));
  const names: unknown = config.rotation ?? [];
  if (!Array.isArray(names) || names.some((name) => name !== FALLBACK_LINK && !ACCOUNT_NAMES.includes(name)) ||
      new Set(names).size !== names.length) {
    throw new Error("Invalid rotation in claude-accounts.json.");
  }
  const split = names.indexOf(FALLBACK_LINK);
  if (split >= 0 && (split === 0 || split === names.length - 1)) throw new Error("In the rotation, \"fallback\" must sit between two subscriptions.");
  const pick = (list: string[]) => list.map((name) => profiles.find((profile) => profile.name === name)!);
  const rotation = pick(split < 0 ? names : names.slice(0, split));
  const reserve = pick(split < 0 ? [] : names.slice(split + 1));
  const chain = [...rotation, ...reserve];
  if (chain.length > 1 && (new Set(chain.map(directoryKey)).size !== chain.length ||
      chain.some((profile) => !profile.expectedEmail) ||
      new Set(chain.map((profile) => profile.expectedEmail!.toLowerCase())).size !== chain.length)) {
    throw new Error("Rotation requires distinct directories and email addresses for each subscription.");
  }
  return { profiles, rotation, reserve };
}

export function profiles(): Profile[] { return accountConfig().profiles; }

export function directoryKey(profile: Pick<Profile, "directory">): string {
  return profile.directory ?? join(homedir(), ".claude");
}

export function activeProfile(): Profile {
  const directory = process.env.CLAUDE_CONFIG_DIR ? expand(process.env.CLAUDE_CONFIG_DIR) : undefined;
  return profiles().find((profile) => directoryKey(profile) === directoryKey({ directory })) ?? { name: "external", directory };
}

export function restoreDirectory(previous: string | undefined): void {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
}

export async function identify(pi: ExtensionAPI, profile: Profile): Promise<Account> {
  try {
    const envArgs = profile.directory ? [`CLAUDE_CONFIG_DIR=${profile.directory}`] : ["-u", "CLAUDE_CONFIG_DIR"];
    const result = await pi.exec("env", [...envArgs, "claude", "auth", "status", "--json"], { timeout: 5_000 });
    const status = JSON.parse(result.stdout);
    const account = { authenticated: result.code === 0 && status.loggedIn === true, email: clean(status.email), plan: clean(status.subscriptionType) };
    if (account.authenticated && (status.authMethod !== "claude.ai" || (status.apiProvider && status.apiProvider !== "firstParty"))) {
      return { ...account, authenticated: false, error: "API authentication instead of a Claude subscription" };
    }
    if (account.authenticated && profile.expectedEmail && account.email.toLowerCase() !== profile.expectedEmail.toLowerCase()) {
      return { ...account, authenticated: false, error: `email does not match the configuration (${account.email})` };
    }
    return account;
  } catch {
    return { authenticated: false, email: "", plan: "", error: "login not verified" };
  }
}
