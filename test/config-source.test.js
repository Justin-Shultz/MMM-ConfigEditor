// Run with: npm test
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const cs = require("../lib/config-source");

const src = fs.readFileSync(path.join(__dirname, "fixtures", "config.js"), "utf8");
const load = (text) => {
	const m = { exports: {} };
	new Function("module", "exports", text)(m, m.exports);
	return m.exports;
};
const modules = load(src).modules.map((m) => m.module);
const idx = (name) => modules.indexOf(name);

test("no edits leaves the file byte-for-byte identical", () => {
	assert.strictEqual(cs.applyOps(src, []), src);
});

test("reads the config as a tree", () => {
	const tree = cs.readTree(src);
	const mods = tree.children.find((c) => c.key === "modules").node;
	assert.strictEqual(mods.kind, "array");
	assert.strictEqual(mods.items.length, modules.length);
});

test("sets nested values, including lists of objects", () => {
	const t = cs.applyOps(src, [
		{ op: "set", path: ["modules", idx("MMM-CalendarExt3"), "config", "weeksInView"], value: { kind: "number", value: 4 } },
		{ op: "set", path: ["modules", idx("MMM-MyScoreboard"), "config", "sports", 0, "teams"], value: { kind: "array", items: [{ kind: "string", value: "CIN" }, { kind: "string", value: "BAL" }] } }
	]);
	const c = load(t);
	assert.strictEqual(c.modules[idx("MMM-CalendarExt3")].config.weeksInView, 4);
	assert.deepStrictEqual(c.modules[idx("MMM-MyScoreboard")].config.sports[0].teams, ["CIN", "BAL"]);
});

test("keeps comments and code expressions", () => {
	const t = cs.applyOps(src, [{ op: "set", path: ["timeFormat"], value: { kind: "number", value: 24 } }]);
	assert.strictEqual((t.match(/\/\//g) || []).length, (src.match(/\/\//g) || []).length);
	assert.match(t, /fetchInterval: 5 \* 60 \* 1000/);
});

test("adds and removes settings (middle and last)", () => {
	const i = idx("MMM-CalendarExt3");
	const t = cs.applyOps(src, [
		{ op: "add", path: ["modules", i, "config"], key: "animationSpeed", value: { kind: "number", value: 0 } },
		{ op: "remove", path: ["modules", i, "config", "showMore"] },
		{ op: "remove", path: ["modules", i, "config", "animationSpeed"] }
	]);
	const cfg = load(t).modules[i].config;
	assert.ok(!("showMore" in cfg));
	assert.ok(!("animationSpeed" in cfg));
});

test("adds, removes and reorders modules", () => {
	const t = cs.applyOps(src, [
		{ op: "append", path: ["modules"], value: { kind: "object", children: [{ key: "module", node: { kind: "string", value: "compliments" } }] } },
		{ op: "move", path: ["modules"], from: 0, to: 1 },
		{ op: "remove", path: ["modules", 2] }
	]);
	const names = load(t).modules.map((m) => m.module);
	assert.strictEqual(names[names.length - 1], "compliments");
	assert.strictEqual(names.length, modules.length);
});

test("handles 2-space indentation, trailing commas and same-line comments", () => {
	const small = `var config = {\n  port: 8080,\n  modules: [\n    {\n      module: "clock",\n      position: "top_left", // note\n    },\n  ],\n};\nif (typeof module !== "undefined") { module.exports = config; }\n`;
	const t = cs.applyOps(small, [{ op: "add", path: ["modules", 0], key: "header", value: { kind: "string", value: "Time" } }]);
	assert.match(t, /position: "top_left", \/\/ note\n {6}header: "Time",\n/);
	assert.strictEqual(load(t).modules[0].header, "Time");
});

test("rejects invalid code values", () => {
	assert.throws(() => cs.applyOps(src, [{ op: "set", path: ["port"], value: { kind: "code", code: "8080 +" } }]), /Not valid JavaScript/);
});
