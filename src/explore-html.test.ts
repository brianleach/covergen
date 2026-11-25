import { describe, expect, it } from "vitest";
import { mergeAriaNames, parseAriaSnapshot, parseSnapshot } from "./explore-html.js";

const names = (html: string) => parseSnapshot(`<html><body>${html}</body></html>`, "https://app.test/").elements.map((e) => `${e.role}:${e.name}`);

describe("accessible names in the parser", () => {
  it("reads aria-labelledby, joining several ids with a space", () => {
    expect(names(`<h2 id="t">Billing</h2><span id="s">card</span><button aria-labelledby="t s">x</button>`)).toEqual(["button:Billing card"]);
  });

  it("reads aria-label", () => {
    expect(names(`<input aria-label="Display name">`)).toEqual(["textbox:Display name"]);
  });

  it("reads a label by for= and a wrapping label, without the wrapped control's own text", () => {
    expect(names(`<label for="e">Email</label><input id="e" placeholder="you@example.test">`)).toEqual(["textbox:Email"]);
    expect(names(`<label><input type="checkbox"> Remember me</label>`)).toEqual(["checkbox:Remember me"]);
    expect(names(`<label>Size <select><option>Small</option></select></label>`)).toEqual(["combobox:Size"]);
  });

  it("reads own text, an image's alt inside a link or button, then title, placeholder and value", () => {
    expect(names(`<a href="/x">Items</a><button><img src="g.png" alt="Settings"></button>`)).toEqual(["link:Items", "button:Settings"]);
    expect(names(`<input title="Search" placeholder="Type">`)).toEqual(["textbox:Search"]);
    expect(names(`<input placeholder="Type" value="v">`)).toEqual(["textbox:Type"]);
    expect(names(`<input type="submit" value="Send">`)).toEqual(["button:Send"]);
  });

  it("ranks aria-labelledby over aria-label over a label over text", () => {
    expect(names(`<span id="a">From id</span><label for="b">From label</label><button id="b" aria-labelledby="a" aria-label="From aria">Text</button>`)).toEqual(["button:From id"]);
    expect(names(`<label for="b">From label</label><button id="b" aria-label="From aria">Text</button>`)).toEqual(["button:From aria"]);
    expect(names(`<label for="b">From label</label><button id="b">Text</button>`)).toEqual(["button:From label"]);
  });

  it("falls through cleanly when aria-labelledby names a missing id", () => {
    expect(names(`<button aria-labelledby="nope" aria-label="Fallback">x</button>`)).toEqual(["button:Fallback"]);
    expect(names(`<input aria-labelledby="nope">`)).toEqual(["textbox:"]);
  });
});

const SNAPSHOT = `- navigation:
  - link "Items":
    - /url: /items
  - link "Log out"
- heading "Profile" [level=1]
- text: Hello
- textbox "Display name"
- button "Save \\"draft\\"" [disabled]
- button "Made by script"`;

describe("parseAriaSnapshot", () => {
  it("keeps the interactive nodes in order and decodes quoted names", () => {
    expect(parseAriaSnapshot(SNAPSHOT)).toEqual([
      { role: "link", name: "Items" },
      { role: "link", name: "Log out" },
      { role: "textbox", name: "Display name" },
      { role: "button", name: 'Save "draft"' },
      { role: "button", name: "Made by script" },
    ]);
  });
});

describe("mergeAriaNames", () => {
  it("lets the snapshot's name win per role and order, keeps mutating, and appends what only the snapshot has", () => {
    const parsed = [
      { role: "link", name: "Items", mutating: false },
      { role: "link", name: "Log out", mutating: true },
      { role: "textbox", name: "", mutating: true },
      { role: "button", name: "Save", mutating: true },
    ];
    const merged = mergeAriaNames(parsed, parseAriaSnapshot(SNAPSHOT));
    expect(merged.elements).toEqual([
      { role: "link", name: "Items", mutating: false },
      { role: "link", name: "Log out", mutating: true },
      { role: "textbox", name: "Display name", mutating: true },
      { role: "button", name: 'Save "draft"', mutating: true },
      { role: "button", name: "Made by script", mutating: true },
    ]);
    expect(merged).toMatchObject({ corrected: 2, appended: 1 });
  });

  it("appends a link as read-only unless its name is destructive", () => {
    const merged = mergeAriaNames([], [{ role: "link", name: "Reports" }, { role: "link", name: "Sign out" }]);
    expect(merged.elements.map((e) => e.mutating)).toEqual([false, true]);
  });
});

describe("script and style bodies", () => {
  it("are not markup, so a tag inside a string literal is not an element", () => {
    expect(names(`<a href="/a">A</a><script>el.innerHTML = "<button>Ghost</button>";</script><style>a::after { content: "<b>" }</style>`)).toEqual(["link:A"]);
  });
});
