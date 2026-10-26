// Version selection and persistence for the npm workflow. npm owns SemVer
// arithmetic; no install, lifecycle scripts or automatic git tagging is run.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const env = process.env;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const packageVersion = () => JSON.parse(readFileSync("package.json", "utf8")).version;
function setVersion(version) {
  const npm = env.npm_execpath?.endsWith("npm-cli.js") ? env.npm_execpath
    : join(dirname(process.execPath), process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "../lib/node_modules/npm/bin/npm-cli.js");
  execFileSync(process.execPath, [npm, "version", version, "--no-git-tag-version", "--ignore-scripts", "--workspaces=false", "--package-lock=false", "--offline", "--no-update-notifier"], { stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  return packageVersion();
}

function plan() {
  const base = packageVersion();
  const { GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_REPOSITORY: repo } = env;
  const releaseRef = `refs/tags/v${base}`;
  if (ref.startsWith("refs/tags/v") && ref !== releaseRef) throw new Error("The release tag must match package.json version.");
  const publish = event === "workflow_dispatch" ? env.MANUAL_PUBLISH === "true"
    : event === "push" && ref === releaseRef && env.TAG_PUBLISH_ENABLED === "true";
  if (publish && (repo !== "Msalways/hattera" || !["refs/heads/main", releaseRef].includes(ref))) {
    throw new Error("Publish from Msalways/hattera main or the matching version tag.");
  }
  const bump = event === "workflow_dispatch" ? env.VERSION_BUMP || "current" : "current";
  if (!["current", "patch", "minor", "major"].includes(bump)) throw new Error("Choose current, patch, minor or major.");
  if (bump !== "current" && ref !== "refs/heads/main") throw new Error("Choose main for a version bump, or current to publish an existing tag.");
  const version = bump === "current" ? base : setVersion(bump);
  const tag = version.includes("-") ? "next" : "latest";
  appendFileSync(env.GITHUB_OUTPUT, `publish=${publish}\ndist_tag=${tag}\nbase_version=${base}\nversion=${version}\n`);
  console.log(`${base} -> ${version} (${bump}). ${publish ? `Publish as ${tag} after qualification.` : "Verification only; no version commit or publication."}`);
}

function record() {
  if (env.PUBLISH_REQUESTED !== "true" || env.GITHUB_REPOSITORY !== "Msalways/hattera") throw new Error("Version recording requires an authorized publication request.");
  const base = env.BASE_VERSION, version = env.RELEASE_VERSION;
  if (!base || !version || packageVersion() !== base) throw new Error("The source version changed; rerun from the latest source.");
  if (version === base) {
    console.log(`Using the already committed version ${version}.`);
    return;
  }
  if (env.GITHUB_REF !== "refs/heads/main") throw new Error("Version bumps must be recorded on main.");
  const source = env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(source ?? "") || git("rev-parse", "HEAD") !== source) throw new Error("The checkout does not match the qualified source.");
  if (git("ls-remote", "origin", "refs/heads/main").split(/\s+/)[0] !== source) {
    throw new Error("main changed during qualification. Rerun the workflow; nothing was published or overwritten.");
  }
  if (git("ls-remote", "origin", `refs/tags/v${version}`)) throw new Error(`Tag v${version} already exists. Retry that tag with current instead of bumping again.`);
  if (setVersion(version) !== version) throw new Error("The recorded version does not match the qualified package.");
  git("config", "user.name", "github-actions[bot]");
  git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  git("add", "package.json");
  git("commit", "-m", `chore(npm): release ${version}`);
  git("tag", "-a", `v${version}`, "-m", `npm release ${version}`);
  // Respect concurrent changes and branch rules. Both refs update or neither
  // does; GITHUB_TOKEN pushes do not recursively start desktop/tag workflows.
  git("push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/v${version}`);
  console.log(`Recorded ${version} and v${version}; the verified tarball can now be published.`);
}

try {
  if (process.argv[2] === "plan") plan();
  else if (process.argv[2] === "record") record();
  else throw new Error("Usage: node scripts/npm-release.mjs plan|record");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
