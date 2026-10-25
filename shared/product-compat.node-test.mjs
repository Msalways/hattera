import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { applyEnvironmentAliases, defaultDataDirectory, withLegacyEnvironment } from "./product-compat.mjs";

test("canonical settings override their old aliases without changing the caller's environment", () => {
  const input = { HATTERA_PORT:"9123", OMB_PORT:"8799", HATTERA_DATA_DIR:"isolated", OMB_DATA_DIR:"legacy", PATH:"unchanged" };
  const output = withLegacyEnvironment(input);
  assert.equal(output.OMB_PORT,"9123"); assert.equal(output.OMB_DATA_DIR,"isolated");
  assert.equal(input.OMB_PORT,"8799"); assert.equal(output.PATH,"unchanged");
  assert.equal(withLegacyEnvironment({OMB_PORT:"8799"}).OMB_PORT,"8799");
});

test("a fresh install uses Hattera; an existing workspace wins without being moved", () => {
  const home=join("isolated","home"),checked=[];
  assert.equal(defaultDataDirectory(home,()=>false),join(home,".hattera"));
  assert.equal(defaultDataDirectory(home,path=>{checked.push(path);return path===join(home,".openmausbot");}),join(home,".openmausbot"));
  assert.deepEqual(checked,[join(home,".openmausbot")]);
});

test("an internal child override cannot be undone by a stale canonical launch setting", () => {
  const environment={HATTERA_DATA_DIR:"launch-workspace",OMB_DATA_DIR:"legacy",HATTERA_LOCAL_CLI:"1"};
  applyEnvironmentAliases(environment);
  environment.OMB_DATA_DIR="explicit-child-workspace";environment.OMB_LOCAL_CLI="0";
  applyEnvironmentAliases(environment);
  assert.equal(environment.OMB_DATA_DIR,"explicit-child-workspace");
  assert.equal(environment.OMB_LOCAL_CLI,"0");
  assert.equal(environment.HATTERA_DATA_DIR,undefined);
});
