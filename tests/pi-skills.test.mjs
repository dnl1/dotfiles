import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const sourceDir = fileURLToPath(new URL("../ai/claude/skills/", import.meta.url));
const piDir = fileURLToPath(new URL("../ai/pi/", import.meta.url));
const adopted = ["codebase-design", "diagnosing-bugs", "grilling", "tdd", "writing-pull-requests"];
// Copied unchanged from upstream; UPSTREAM.txt records the source and a content digest.
const vendored = ["security-audit"];
const names = [...adopted, ...vendored];
const englishExamples = {
  "codebase-design": "rethink this architecture",
  "diagnosing-bugs": "investigate this error",
  grilling: "challenge my assumptions",
  tdd: "write the test before the fix",
  "writing-pull-requests": "open the PR",
};
let sdk;
let sdkUnavailable;
try {
  const agentDir = join(homedir(), ".pi/agent");
  const version = readFileSync(join(agentDir, "install/current-version"), "utf8").trim();
  const host = process.env.PI_SDK_DIR || join(agentDir, "install/releases", version, "node_modules/@earendil-works/pi-coding-agent");
  sdk = await import(pathToFileURL(join(host, "dist/index.js")).href);
} catch (error) {
  sdkUnavailable = "Pi SDK unavailable: " + error.message;
}

for (const name of adopted) {
  test(`${name} has valid, automatic, bounded metadata in the real Pi parser`, { skip: sdkUnavailable }, () => {
    const result = sdk.loadSkillsFromDir({ dir: join(sourceDir, name), source: "user" });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.skills.length, 1);
    const skill = result.skills[0];
    assert.equal(skill.name, name);
    assert.equal(skill.disableModelInvocation, false);
    assert(skill.description.length <= 1024);
    assert.match(skill.description, /Not for/);
    assert(skill.description.includes(englishExamples[name]));
  });
}

for (const name of vendored) {
  test(`${name} loads automatically in the real Pi parser`, { skip: sdkUnavailable }, () => {
    const result = sdk.loadSkillsFromDir({ dir: join(sourceDir, name), source: "user" });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, name);
    assert.equal(result.skills[0].disableModelInvocation, false);
    assert(result.skills[0].description.length <= 1024);
  });

  test(`${name} still matches the upstream copy recorded in UPSTREAM.txt`, () => {
    const dir = join(sourceDir, name);
    const recorded = readFileSync(join(dir, "UPSTREAM.txt"), "utf8").match(/^Content digest: ([0-9a-f]{64})$/m)?.[1];
    assert(recorded, "UPSTREAM.txt has no content digest");
    // Same as: find . -type f ! -name UPSTREAM.txt | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256
    const files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && !(entry.name === "UPSTREAM.txt" && entry.parentPath === dir))
      .map(entry => "./" + join(entry.parentPath, entry.name).slice(dir.length + 1))
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const listing = files.map(file => `${createHash("sha256").update(readFileSync(join(dir, file))).digest("hex")}  ${file}\n`).join("");
    assert.equal(createHash("sha256").update(listing).digest("hex"), recorded);
  });
}

test("canonical skill catalog has no duplicate names", { skip: sdkUnavailable }, () => {
  const result = sdk.loadSkillsFromDir({ dir: sourceDir, source: "user" });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.skills.map(skill => skill.name).sort(), [...names].sort());
});

test("skill prompt contains descriptions without injecting full workflows", { skip: sdkUnavailable }, () => {
  const { skills } = sdk.loadSkillsFromDir({ dir: sourceDir, source: "user" });
  const prompt = sdk.formatSkillsForPrompt(skills);
  for (const name of names) assert(prompt.includes(`<name>${name}</name>`));
  assert(prompt.includes("investigate this error"));
  assert(!prompt.includes("## Phase 1"));
  assert(!prompt.includes("## Rules of the loop"));
});

test("an explicit plugin path and a Pi symlink do not duplicate a skill", { skip: sdkUnavailable }, t => {
  const temp = mkdtempSync(join(tmpdir(), "pi-skill-links-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const linked = join(temp, "linked-skill");
  const canonical = join(sourceDir, "writing-pull-requests");
  symlinkSync(canonical, linked, "dir");
  const result = sdk.loadSkills({ cwd: temp, agentDir: join(temp, "empty-agent"), skillPaths: [linked, canonical], includeDefaults: false });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.skills.length, 1);
});

test("frontend plugin is discoverable without scanning superseded plugin caches", () => {
  const settings = JSON.parse(readFileSync(join(piDir, "settings.base.json"), "utf8"));
  assert(settings.skills.includes("~/.claude/plugins/marketplaces/claude-plugins-official/plugins/frontend-design/skills/frontend-design"));
  assert(settings.skills.every(path => !path.includes("plugins/cache")));
});

test("routing guidance stays outside the managed ai-memory block", () => {
  const instructions = readFileSync(join(piDir, "AGENTS.md"), "utf8");
  assert.equal(instructions.split("## Skill selection").length - 1, 1);
  assert(instructions.indexOf("## Skill selection") < instructions.indexOf("<!-- ai-memory:start -->"));
  for (const name of names) assert(instructions.includes(`\`${name}\``));
  assert(instructions.includes("Mentioning \"API\", \"backend\" or \"audit\" alone"));
  assert(instructions.includes("required connector available"));
});

test("TDD does not require an unavailable Skill tool or code-review skill", () => {
  const skill = readFileSync(join(sourceDir, "tdd/SKILL.md"), "utf8");
  assert(!skill.includes("call the Skill tool"));
  assert(skill.includes("use `read` on its SKILL.md in Pi"));
  assert(skill.includes("consult `code-review` only if that skill is available"));
});

test("local Markdown references in the adopted skill instructions exist", () => {
  for (const name of names) {
    const body = readFileSync(join(sourceDir, name, "SKILL.md"), "utf8");
    for (const [, reference] of body.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]+)?\)/g)) {
      if (/^https?:/.test(reference)) continue;
      assert(existsSync(join(sourceDir, name, reference)), `${name}: missing ${reference}`);
    }
  }
});

test("manual routing cases are well formed, including near misses", () => {
  const cases = JSON.parse(readFileSync(join(piDir, "skill-routing-cases.json"), "utf8"));
  assert.equal(cases.length, 21);
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  for (const item of cases) {
    assert(item.prompt.length > 40);
    assert(Array.isArray(item.expected));
    assert(Array.isArray(item.avoid));
    for (const name of [...item.expected, ...(item.expectedAny || [])]) assert(!item.avoid.includes(name));
  }
});
