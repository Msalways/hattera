import { describe, expect, it } from "vitest";
import { closeOpenFence, thoughtSeconds } from "./live-turn-view";

describe("closeOpenFence", () => {
  it("leaves text without a fence, or with closed fences, untouched", () => {
    expect(closeOpenFence("plain **text**")).toBe("plain **text**");
    expect(closeOpenFence("```js\nx\n```\nafter")).toBe("```js\nx\n```\nafter");
    expect(closeOpenFence("")).toBe("");
  });

  it("closes a fence the stream has opened and not finished", () => {
    expect(closeOpenFence("```ts\nconst a")).toBe("```ts\nconst a\n```");
    expect(closeOpenFence("```ts\nconst a\n")).toBe("```ts\nconst a\n```");
    expect(closeOpenFence("a\n```")).toBe("a\n```\n```");
  });

  it("closes with the same marker and length it opened with", () => {
    expect(closeOpenFence("~~~\nx")).toBe("~~~\nx\n~~~");
    expect(closeOpenFence("````md\n```\nx")).toBe("````md\n```\nx\n````");
  });

  it("a shorter or different marker inside a fence does not close it", () => {
    expect(closeOpenFence("````\n```\nx\n```")).toBe("````\n```\nx\n```\n````");
    expect(closeOpenFence("```\n~~~\nx")).toBe("```\n~~~\nx\n```");
  });

  it("does not take inline backticks or an info string with a backtick for a fence", () => {
    expect(closeOpenFence("use ```inline``` here")).toBe("use ```inline``` here");
    expect(closeOpenFence("```a`b\ntext")).toBe("```a`b\ntext");
  });
});

describe("thoughtSeconds", () => {
  it("rounds to whole seconds and never reads below 1", () => {
    expect(thoughtSeconds(0, 2400)).toBe(2);
    expect(thoughtSeconds(0, 2600)).toBe(3);
    expect(thoughtSeconds(0, 10)).toBe(1);
    expect(thoughtSeconds(5000, 4000)).toBe(1);
  });
});
