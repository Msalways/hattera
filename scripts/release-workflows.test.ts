import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const load = (name: string) => parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));
const npm = load("npm-package.yml"), render = load("render-deploy.yml");
const releaseStep = npm.jobs["pack-and-prove"].steps.find((step: { id?: string }) => step.id === "release");
const renderStep = render.jobs.deploy.steps.find((step: { run?: string }) => step.run);
const releaseScript = fileURLToPath(new URL("./npm-release.mjs", import.meta.url));

// Execute the actual workflow scripts with private files and a mocked network.
function run(script: string, environment: Record<string, string>, stub = "", version = "1.2.3") {
  const home = mkdtempSync(join(tmpdir(), "hattera-workflow-"));
  try {
    writeFileSync(join(home, "package.json"), JSON.stringify({ version }));
    const output = join(home, "outputs");
    writeFileSync(output, "");
    const source = script.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/);
    if (!script.startsWith("node scripts/npm-release.mjs")) expect(source).not.toBeNull();
    const args = script.startsWith("node scripts/npm-release.mjs") ? [releaseScript, "plan"] : ["--input-type=module", "-e", stub + "\n" + source![1]];
    const result = spawnSync(process.execPath, args, {
      cwd: home, encoding: "utf8", timeout: 30_000, windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, npm_config_cache: join(home, "npm-cache"), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: output, ...environment },
    });
    expect(result.error).toBeUndefined();
    return { ...result, output: readFileSync(output, "utf8"), version: JSON.parse(readFileSync(join(home, "package.json"), "utf8")).version };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const context = { GITHUB_REPOSITORY: "Msalways/hattera", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch" };

describe("npm publication workflow", () => {
  it.each([
    [{}, false],
    [{ MANUAL_PUBLISH: "true" }, true],
    [{ GITHUB_REF: "refs/tags/v1.2.3", MANUAL_PUBLISH: "false", TAG_PUBLISH_ENABLED: "true" }, false],
    [{ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.2.3", TAG_PUBLISH_ENABLED: "true" }, true],
    [{ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.2.3", TAG_PUBLISH_ENABLED: "false" }, false],
    [{ GITHUB_EVENT_NAME: "pull_request", MANUAL_PUBLISH: "true" }, false],
  ])("selects publication for %j", (env, expected) => {
    const result = run(releaseStep.run, { ...context, ...env });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain(`publish=${expected}\n`);
    expect(result.output).toContain("dist_tag=latest\n");
  });

  it.each([
    { GITHUB_REPOSITORY: "another/fork", MANUAL_PUBLISH: "true" },
    { GITHUB_REF: "refs/heads/experiment", MANUAL_PUBLISH: "true" },
    { GITHUB_REF: "refs/tags/v9.9.9" },
  ])("refuses a mismatched release request: %j", (env) => {
    const result = run(releaseStep.run, { ...context, ...env });
    expect(result.status).toBe(1);
    expect(result.output).toBe("");
  });

  it("publishes prereleases under next", () => {
    const result = run(releaseStep.run, context, "", "1.2.3-beta.1");
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain("dist_tag=next\n");
  });

  it.each([
    ["patch", "1.2.4"], ["minor", "1.3.0"], ["major", "2.0.0"], ["current", "1.2.3"],
  ])("applies %s to the package before building: %s", (bump, version) => {
    const result = run(releaseStep.run, { ...context, VERSION_BUMP: bump });
    expect(result.status, result.stderr).toBe(0);
    expect(result.version).toBe(version);
    expect(result.output).toContain(`version=${version}\n`);
    expect(result.output).toContain("publish=false\n");
    expect(result.output).toContain("base_version=1.2.3\n");
  });

  it("uses npm SemVer rules for prerelease promotion", () => {
    const result = run(releaseStep.run, { ...context, VERSION_BUMP: "major" }, "", "2.0.0-beta.1");
    expect(result.status, result.stderr).toBe(0);
    expect(result.version).toBe("2.0.0");
  });

  it.each(["from-git", "--help", "invalid"])("rejects unsupported bump %s", (bump) => {
    const result = run(releaseStep.run, { ...context, VERSION_BUMP: bump });
    expect(result.status).toBe(1);
    expect(result.version).toBe("1.2.3");
  });

  it("requires current when retrying a version tag", () => {
    const result = run(releaseStep.run, { ...context, GITHUB_REF: "refs/tags/v1.2.3", VERSION_BUMP: "patch" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("current");
    expect(result.version).toBe("1.2.3");
  });

  it("keeps every installation job ahead of publishing and scopes the credential to publishing", () => {
    expect(npm.on.workflow_dispatch.inputs.publish.default).toBe(false);
    expect(npm.on.workflow_dispatch.inputs.version_bump).toMatchObject({ type: "choice", default: "patch", options: ["patch", "minor", "major", "current"] });
    const publish = npm.jobs["publish-npm"];
    expect(publish.needs).toEqual(["pack-and-prove", "install-and-prove", "record-version"]);
    expect(publish.if).toBe("needs.pack-and-prove.outputs.publish == 'true'");
    expect(publish.permissions["id-token"]).toBe("write");
    const step = publish.steps.find((step: { name?: string }) => step.name === "Publish to npm");
    expect(step.env.NODE_AUTH_TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
    expect(step.run).toContain('--tag "$NPM_DIST_TAG"');
    expect(JSON.stringify(npm.jobs["pack-and-prove"])).not.toContain("secrets.NPM_TOKEN");
    expect(JSON.stringify(npm.jobs["install-and-prove"])).not.toContain("secrets.NPM_TOKEN");
    const release = load("release.yml");
    const dispatch = release.jobs.assemble.steps.find((step: { name?: string }) => step.name === "Publish (only when asked to)");
    expect(dispatch.run).toContain('--field "publish=$NPM_PUBLISH"');
    expect(dispatch.run).toContain("--field version_bump=current");
    expect(dispatch.env.NPM_PUBLISH).toBe("${{ vars.HATTERA_NPM_PUBLISH_ENABLED == 'true' }}");
  });

  it("records a version only after qualification and keeps repository write access out of builds", () => {
    const record = npm.jobs["record-version"];
    expect(record.needs).toEqual(["pack-and-prove", "install-and-prove"]);
    expect(record.if).toBe("needs.pack-and-prove.outputs.publish == 'true'");
    expect(record.permissions.contents).toBe("write");
    expect(npm.permissions.contents).toBe("read");
    expect(npm.jobs["pack-and-prove"].permissions).toBeUndefined();
    expect(npm.jobs["install-and-prove"].permissions).toBeUndefined();
    expect(npm.concurrency["cancel-in-progress"]).toBe(false);
    expect(npm.jobs["pack-and-prove"].outputs.version).toBe("${{ steps.release.outputs.version }}");
  });
});

describe("npm version commit and tag", () => {
  function fixture(check: (repo: string, remote: string, source: string, env: NodeJS.ProcessEnv) => void) {
    const home = mkdtempSync(join(tmpdir(), "hattera-version-git-"));
    const repo = join(home, "work with spaces"), remote = join(home, "remote.git");
    mkdirSync(repo);
    writeFileSync(join(home, ".gitconfig"), "");
    writeFileSync(join(home, ".npmrc"), "");
    const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1", npm_config_userconfig: join(home, ".npmrc"), npm_config_cache: join(home, "npm-cache"),
      ...context, PUBLISH_REQUESTED: "true", BASE_VERSION: "1.2.3", RELEASE_VERSION: "1.2.4" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      git("init", "--bare", remote);
      git("init", "-b", "main");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.invalid");
      writeFileSync(join(repo, "package.json"), JSON.stringify({ version: "1.2.3", scripts: { preversion: "exit 1" } }, null, 2) + "\n");
      git("add", "package.json"); git("commit", "-m", "Initial fixture");
      git("remote", "add", "origin", remote); git("push", "origin", "main");
      const source = git("rev-parse", "HEAD");
      check(repo, remote, source, { ...env, GITHUB_SHA: source });
    } finally { rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  }

  it("commits the qualified version and atomically tags that exact commit", () => fixture((repo, remote, source, env) => {
    const result = spawnSync(process.execPath, [releaseScript, "record"], { cwd: repo, env, encoding: "utf8", timeout: 20_000, windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    const git = (...args: string[]) => execFileSync("git", ["--git-dir", remote, ...args], { encoding: "utf8" }).trim();
    const head = git("rev-parse", "main");
    expect(head).not.toBe(source);
    expect(git("rev-parse", "refs/tags/v1.2.4^{}")).toBe(head);
    expect(JSON.parse(git("show", "main:package.json")).version).toBe("1.2.4");
    expect(git("diff", "--name-only", source, head)).toBe("package.json");
  }));

  it("refuses a main update made while the artifact was being tested", () => fixture((repo, remote, source, env) => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("commit", "--allow-empty", "-m", "Concurrent change"); git("push", "origin", "main");
    const changed = git("rev-parse", "HEAD");
    git("checkout", "--detach", source);
    const result = spawnSync(process.execPath, [releaseScript, "record"], { cwd: repo, env, encoding: "utf8", timeout: 20_000, windowsHide: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("main changed during qualification");
    expect(git("--git-dir", remote, "rev-parse", "main")).toBe(changed);
    expect(git("--git-dir", remote, "tag", "--list")).toBe("");
    expect(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version).toBe("1.2.3");
  }));

  it("stops before publication when repository rules reject the version push", () => fixture((repo, remote, source, env) => {
    writeFileSync(join(remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const result = spawnSync(process.execPath, [releaseScript, "record"], { cwd: repo, env, encoding: "utf8", timeout: 20_000, windowsHide: true });
    expect(result.status).toBe(1);
    expect(execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf8" }).trim()).toBe(source);
    expect(execFileSync("git", ["--git-dir", remote, "tag", "--list"], { encoding: "utf8" }).trim()).toBe("");
  }));

  it("does not create a commit when reusing the current version", () => fixture((repo, remote, source, env) => {
    const result = spawnSync(process.execPath, [releaseScript, "record"], { cwd: repo, env: { ...env, RELEASE_VERSION: "1.2.3" }, encoding: "utf8", timeout: 20_000, windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf8" }).trim()).toBe(source);
    expect(existsSync(join(repo, "package-lock.json"))).toBe(false);
  }));
});

const sha = "a".repeat(40);
const hook = "https://api.render.com/deploy/srv-fixture?key=fixture-only-key";
const renderContext = { GITHUB_SHA: sha, RENDER_DEPLOY_HOOK_URL: hook };
describe("manual Render deployments", () => {
  it("has no push/dependency trigger and disables Blueprint auto-deploys", () => {
    expect(render.on).toEqual({ workflow_dispatch: null });
    const blueprint = parse(readFileSync(new URL("../render.yaml", import.meta.url), "utf8"));
    expect(blueprint.services[0].autoDeployTrigger).toBe("off");
    expect(render.concurrency["cancel-in-progress"]).toBe(false);
  });

  it.each([200, 202])("requests the selected SHA and reports HTTP %i accurately", (status) => {
    const stub = `import assert from 'node:assert/strict';
      globalThis.fetch = async (url, options) => {
        assert.equal(url.origin, 'https://api.render.com');
        assert.equal(url.searchParams.get('ref'), '${sha}');
        assert.equal(url.searchParams.get('key'), 'fixture-only-key');
        assert.equal(options.method, 'POST');
        assert.equal(options.redirect, 'error');
        return new Response(${status === 202 ? "null" : "'fixture-only-key'"}, { status: ${status} });
      };`;
    const result = run(renderStep.run, renderContext, stub);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain(status === 202 ? "queued" : "accepted");
    expect(result.stdout + result.stderr + result.output).not.toContain("fixture-only-key");
  });

  it.each(["", "not-a-url", "http://api.render.com/deploy/srv-fixture?key=fixture-only-key", "https://example.com/deploy/srv-fixture?key=fixture-only-key"])("rejects a missing/invalid hook without printing it", (value) => {
    const result = run(renderStep.run, { ...renderContext, RENDER_DEPLOY_HOOK_URL: value });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("fixture-only-key");
  });

  it("reports failed or interrupted requests without leaking the hook", () => {
    for (const stub of ["globalThis.fetch = async () => new Response('fixture-only-key', { status: 401 });", "globalThis.fetch = async () => { throw new Error('fixture-only-key'); };"]) {
      const result = run(renderStep.run, renderContext, stub);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Render (rejected|did not accept)/);
      expect(result.stderr).not.toContain("fixture-only-key");
    }
  });
});
