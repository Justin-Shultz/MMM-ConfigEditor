/* MMM-ConfigEditor page.
 *
 * The server sends config.js as a tree of typed values. Edits here are recorded as a
 * list of operations (set / add / remove / append / move) which the server applies to the
 * file's source text in order, so nothing outside the edited values changes.
 */
(() => {
	const API = `${location.pathname.replace(/\/+$/, "").replace(/\/index\.html$/, "")}/api`;
	const $ = (id) => document.getElementById(id);

	/* Choices for well-known settings. Modules can add their own in <module>/config-editor.json:
	 *   { "someKey": { "enum": ["a", "b"], "help": "What it does" } } */
	const BUILTIN_HINTS = {
		"": {
			timeFormat: { enum: [12, 24] },
			units: { enum: ["metric", "imperial"] },
			address: { help: "\"0.0.0.0\" to allow other devices on your network" },
			ipWhitelist: { help: "[] allows any device on your network" }
		},
		clock: {
			displayType: { enum: ["digital", "analog", "both"] },
			timeFormat: { enum: [12, 24] },
			analogPlacement: { enum: ["top", "bottom", "left", "right"] },
			showWeek: { enum: [false, true, "short"] },
			dateFormat: { help: "moment.js format, e.g. \"dddd, MMMM D\"" }
		},
		calendar: {
			timeFormat: { enum: ["relative", "absolute", "dateheaders"] }
		},
		weather: {
			type: { enum: ["current", "forecast", "hourly", "daily"] },
			units: { enum: ["metric", "imperial", "standard"] },
			weatherProvider: { enum: ["openmeteo", "openweathermap", "weathergov", "weatherbit", "weatherapi", "pirateweather", "smhi", "yr", "envcanada", "ukmetofficedatahub", "buienradar", "fmi", "weatherflow"] }
		},
		"MMM-CalendarExt3": {
			mode: { enum: ["week", "month", "day"] },
			weeksInView: { help: "Number of weeks shown (week mode)" },
			firstDayOfWeek: { enum: [0, 1, 2, 3, 4, 5, 6], help: "0 = Sunday, 1 = Monday" },
			eventLayout: { enum: ["single-line", "two-line"] },
			maxEventLines: { help: "Events per day; a list is per number of weeks: [default, 1 wk, 2 wk, …]" }
		},
		"MMM-MyScoreboard": {
			viewStyle: { enum: ["largeLogos", "mediumLogos", "smallLogos", "oneLine", "oneLineWithLogos", "stacked", "stackedWithLogos"] }
		}
	};
	const MODULE_LEVEL_KEYS = ["header", "classes", "config", "order", "hiddenOnStartup", "configDeepMerge", "animateIn", "animateOut"];

	let state = null; // from the server
	let work = null; // edited copy of the tree
	let ops = [];
	const changed = new Set(); // JSON paths that were edited
	const openCards = new Set(); // module names whose card is open
	const defaultsCache = new Map(); // module name -> defaults object | null

	/* ---------------- server ---------------- */

	async function api (method, path, body) {
		const response = await fetch(`${API}/${path}`, {
			method,
			headers: body ? { "Content-Type": "application/json" } : {},
			body: body ? JSON.stringify(body) : undefined
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
		return data;
	}

	async function load () {
		state = await api("GET", "state");
		work = state.tree ? structuredClone(state.tree) : null;
		ops = [];
		changed.clear();
		$("configText").value = state.configText;
		$("cssText").value = state.cssText;
		showError(state.parseError ? `config.js couldn't be read as settings: ${state.parseError}\nUse the config.js tab to fix it.` : "");
		renderAll();
	}

	function showError (message, kind = "error") {
		const el = $("error");
		el.textContent = message || "";
		el.className = `banner ${kind}${message ? "" : " hidden"}`;
	}

	/** After a restart, wait for the mirror to come back, then reload. */
	async function waitForRestart () {
		showError("Saved. Restarting the mirror…", "ok");
		await new Promise((r) => setTimeout(r, 4000));
		for (let i = 0; i < 60; i++) {
			try {
				await load();
				showError("Saved and restarted.", "ok");
				setTimeout(() => showError(""), 4000);
				return;
			} catch {
				await new Promise((r) => setTimeout(r, 2000));
			}
		}
		showError("The mirror didn't come back after the restart. Check it over SSH.");
	}

	/* ---------------- tree helpers ---------------- */

	const pathKey = (path) => JSON.stringify(path);

	function getNode (path, root = work) {
		let node = root;
		for (const step of path) {
			if (!node) return null;
			node = typeof step === "number" ? node.items?.[step] : node.children?.find((c) => c.key === step)?.node;
		}
		return node;
	}

	function child (objNode, key) {
		return objNode?.children?.find((c) => c.key === key)?.node;
	}

	/** JS value (from module defaults) -> tree node */
	function fromValue (v) {
		if (v === null || v === undefined) return { kind: "null" };
		if (typeof v === "string") return { kind: "string", value: v };
		if (typeof v === "number") return { kind: "number", value: v };
		if (typeof v === "boolean") return { kind: "boolean", value: v };
		if (Array.isArray(v)) return { kind: "array", items: v.map(fromValue) };
		if (typeof v === "function") return { kind: "code", code: v.toString() };
		if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
			return { kind: "object", children: Object.entries(v).map(([key, val]) => ({ key, node: fromValue(val) })) };
		}
		return { kind: "code", code: JSON.stringify(v) ?? "null" };
	}

	/** An empty value shaped like `sample`, for "add item" in lists of objects. */
	function blankLike (sample) {
		if (!sample) return { kind: "string", value: "" };
		switch (sample.kind) {
			case "string": return { kind: "string", value: "" };
			case "number": return { kind: "number", value: 0 };
			case "boolean": return { kind: "boolean", value: false };
			case "array": return { kind: "array", items: [] };
			case "object": return { kind: "object", children: sample.children.filter((c) => !c.opaque).map((c) => ({ key: c.key, node: blankLike(c.node) })) };
			default: return { kind: "null" };
		}
	}

	function newValue (kind) {
		return { string: { kind, value: "" }, number: { kind, value: 0 }, boolean: { kind, value: false }, array: { kind, items: [] }, object: { kind, children: [] }, code: { kind, code: "null" } }[kind];
	}

	/* ---------------- recording edits ---------------- */

	function record (op) {
		// Typing in the same field twice: keep only the latest value.
		const last = ops[ops.length - 1];
		if (op.op === "set" && last?.op === "set" && pathKey(last.path) === pathKey(op.path)) ops.pop();
		ops.push(op);
		applyLocal(op);
		markChanged(op);
		renderAll();
	}

	function markChanged (op) {
		if (op.op === "add") changed.add(pathKey([...op.path, op.key]));
		else changed.add(pathKey(op.path));
	}

	function applyLocal (op) {
		const target = getNode(op.path.slice(0, op.op === "set" || op.op === "remove" ? -1 : undefined));
		const last = op.path[op.path.length - 1];
		switch (op.op) {
			case "set":
				if (typeof last === "number") target.items[last] = op.value;
				else target.children.find((c) => c.key === last).node = op.value;
				break;
			case "add":
				target.children.push({ key: op.key, node: op.value });
				break;
			case "append":
				target.items.push(op.value);
				break;
			case "remove":
				if (typeof last === "number") target.items.splice(last, 1);
				else target.children = target.children.filter((c) => c.key !== last);
				break;
			case "move": {
				const [item] = target.items.splice(op.from, 1);
				target.items.splice(op.to, 0, item);
				break;
			}
		}
	}

	/* ---------------- module defaults ---------------- */

	async function moduleDefaults (name) {
		if (defaultsCache.has(name)) return defaultsCache.get(name);
		const info = state.installed.find((m) => m.name === name);
		let defaults = null;
		if (info) {
			try {
				const text = await (await fetch(info.script)).text();
				let captured = null;
				const fakeModule = { register: (n, def) => { captured = def; } };
				const fakeConfig = { timeFormat: 12, units: "metric", language: "en", locale: "en-US" };
				const sandboxGlobal = { config: fakeConfig };
				// Runs the module's own file just to capture its `defaults`.
				new Function("Module", "Log", "config", "globalThis", text)(fakeModule, { log () {}, info () {}, warn () {}, error () {}, debug () {} }, fakeConfig, sandboxGlobal);
				defaults = captured?.defaults || null;
			} catch {
				defaults = null;
			}
		}
		defaultsCache.set(name, defaults);
		return defaults;
	}

	function hintsFor (moduleName) {
		const fromModule = state.installed.find((m) => m.name === moduleName)?.hints || {};
		return { ...(BUILTIN_HINTS[moduleName] || {}), ...fromModule };
	}

	/* ---------------- rendering ---------------- */

	function el (tag, attrs = {}, ...kids) {
		const e = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) {
			if (k === "class") e.className = v;
			else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
			else if (v === true) e.setAttribute(k, "");
			else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v);
		}
		for (const kid of kids.flat()) if (kid !== null && kid !== undefined) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
		return e;
	}

	function renderAll () {
		const count = ops.length;
		$("savebar").classList.toggle("hidden", count === 0);
		$("changeCount").textContent = `${count} unsaved change${count === 1 ? "" : "s"}`;
		if (!work) {
			$("modules").replaceChildren(el("p", { class: "muted" }, "Fix config.js in the config.js tab first."));
			$("general").replaceChildren();
			renderBackups();
			return;
		}
		renderModules();
		renderGeneral();
		renderBackups();
	}

	function renderGeneral () {
		const omit = new Set(["modules"]);
		$("general").replaceChildren(objectEditor(work, [], BUILTIN_HINTS[""], omit, null));
	}

	function renderModules () {
		const list = child(work, "modules");
		const container = $("modules");
		if (!list || list.kind !== "array") {
			container.replaceChildren(el("p", { class: "muted" }, "No modules list found in config.js."));
			return;
		}
		container.replaceChildren(...list.items.map((mod, i) => moduleCard(mod, i, list.items.length)));

		const select = $("addModuleSelect");
		const current = select.value;
		select.replaceChildren(el("option", { value: "" }, "Add a module…"), ...state.installed.map((m) => el("option", { value: m.name }, m.name + (m.isDefault ? " (built-in)" : ""))));
		select.value = current;
	}

	function moduleCard (mod, index, total) {
		const path = ["modules", index];
		if (mod.kind !== "object") {
			return el("div", { class: "module-card" }, el("div", { class: "body" }, el("p", { class: "muted" }, "This entry isn't a plain object; edit it in the config.js tab.")));
		}
		const name = child(mod, "module")?.value ?? "(no module name)";
		const position = child(mod, "position");
		const disabled = child(mod, "disabled")?.value === true;
		const cardId = `${name}#${index}`;

		const positionSelect = el("select", { title: "Position", onclick: (e) => e.stopPropagation(), onchange: (e) => {
			const value = e.target.value;
			if (!value && position) record({ op: "remove", path: [...path, "position"] });
			else if (value && position) record({ op: "set", path: [...path, "position"], value: { kind: "string", value } });
			else if (value) record({ op: "add", path, key: "position", value: { kind: "string", value } });
		} }, el("option", { value: "" }, "(no position)"), ...state.positions.map((p) => el("option", { value: p }, p)));
		positionSelect.value = position?.value ?? "";
		if (position && position.kind !== "string") positionSelect.disabled = true;

		const offBox = el("input", { type: "checkbox", checked: disabled, title: "Turn this module off", onclick: (e) => e.stopPropagation(), onchange: (e) => {
			const has = child(mod, "disabled");
			if (e.target.checked) {
				if (has) record({ op: "set", path: [...path, "disabled"], value: { kind: "boolean", value: true } });
				else record({ op: "add", path, key: "disabled", value: { kind: "boolean", value: true } });
			} else if (has) {
				record({ op: "remove", path: [...path, "disabled"] });
			}
		} });

		const stop = (fn) => (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
		const summary = el("summary", {},
			el("span", { class: "name" }, name),
			positionSelect,
			el("label", { class: "tag", onclick: (e) => e.stopPropagation() }, offBox, " off"),
			el("button", { class: "icon", title: "Move up", disabled: index === 0, onclick: stop(() => record({ op: "move", path: ["modules"], from: index, to: index - 1 })) }, "↑"),
			el("button", { class: "icon", title: "Move down", disabled: index === total - 1, onclick: stop(() => record({ op: "move", path: ["modules"], from: index, to: index + 1 })) }, "↓"),
			el("button", { class: "icon danger", title: "Remove module", onclick: stop(() => {
				if (confirm(`Remove ${name} from the config?`)) record({ op: "remove", path });
			}) }, "✕")
		);

		const body = el("div", { class: "body" }, el("p", { class: "muted" }, "Loading options…"));
		const card = el("details", { class: `module-card${disabled ? " disabled" : ""}`, open: openCards.has(cardId) }, summary, body);
		card.addEventListener("toggle", () => {
			if (card.open) openCards.add(cardId);
			else openCards.delete(cardId);
			if (card.open) fillCard();
		});

		const fillCard = async () => {
			const defaults = await moduleDefaults(name);
			const hints = hintsFor(name);
			const parts = [];
			// Module-level settings (header, classes, …) except the ones in the summary line.
			parts.push(objectEditor(mod, path, {}, new Set(["module", "position", "disabled", "config"]), MODULE_LEVEL_KEYS.filter((k) => k !== "config").map((k) => [k, k === "classes" || k === "header" ? "" : null])));
			const config = child(mod, "config");
			parts.push(el("h3", { class: "muted", style: "font-size:0.9rem;margin:14px 0 6px" }, "config"));
			if (config && config.kind === "object") {
				parts.push(objectEditor(config, [...path, "config"], hints, null, defaults ? Object.entries(defaults) : null));
			} else if (config) {
				parts.push(valueEditor(config, [...path, "config"], {}));
			} else {
				parts.push(el("button", { onclick: () => record({ op: "add", path, key: "config", value: { kind: "object", children: [] } }) }, "Add config"));
			}
			if (!defaults) parts.push(el("p", { class: "muted" }, "Couldn't read this module's default options, so only the settings already in config.js are listed."));
			body.replaceChildren(...parts);
		};
		if (card.open) fillCard();
		return card;
	}

	/**
	 * Editor for an object node: one row per key, plus an "add setting" row.
	 * `suggestions` is a list of [key, defaultValue] offered for keys not yet present.
	 */
	function objectEditor (node, path, hints, omit, suggestions) {
		const grid = el("div", { class: "obj" });
		for (const c of node.children) {
			if (omit?.has(c.key)) continue;
			if (c.opaque) {
				grid.append(el("div", { class: "key" }, "(code)"), el("div", { class: "val" }, el("input", { class: "code", value: c.node.code, readonly: true, title: "Edit this in the config.js tab" })), el("span"));
				continue;
			}
			const childPath = [...path, c.key];
			const hint = hints?.[c.key] || {};
			grid.append(
				el("div", { class: `key${changed.has(pathKey(childPath)) ? " changed" : ""}` }, c.key, hint.help ? el("span", { class: "hint" }, hint.help) : null),
				el("div", { class: "val" }, valueEditor(c.node, childPath, hint)),
				el("button", { class: "icon danger", title: "Remove this setting (the module's default applies)", onclick: () => record({ op: "remove", path: childPath }) }, "✕")
			);
		}
		const wrap = el("div", {}, grid, adder(node, path, suggestions));
		return wrap;
	}

	function adder (node, path, suggestions) {
		const present = new Set(node.children.map((c) => c.key));
		const missing = (suggestions || []).filter(([k]) => !present.has(k));
		const keySelect = el("select", {},
			el("option", { value: "" }, missing.length ? "Add a setting…" : "Add a setting…"),
			...missing.map(([k]) => el("option", { value: k }, k)),
			el("option", { value: "__custom" }, "Other (type a name)…"));
		const keyInput = el("input", { placeholder: "setting name", class: "hidden" });
		const typeSelect = el("select", { class: "hidden" }, ...["string", "number", "boolean", "array", "object", "code"].map((t) => el("option", { value: t }, t === "array" ? "list" : t)));
		const addBtn = el("button", { disabled: true }, "Add");
		keySelect.addEventListener("change", () => {
			const custom = keySelect.value === "__custom";
			keyInput.classList.toggle("hidden", !custom);
			typeSelect.classList.toggle("hidden", !custom);
			addBtn.disabled = !keySelect.value;
		});
		addBtn.addEventListener("click", () => {
			let key = keySelect.value;
			let value;
			if (key === "__custom") {
				key = keyInput.value.trim();
				if (!key) return;
				value = newValue(typeSelect.value);
			} else {
				const def = missing.find(([k]) => k === key);
				value = def ? fromValue(def[1]) : { kind: "string", value: "" };
			}
			record({ op: "add", path, key, value });
		});
		return el("div", { class: "adder" }, keySelect, keyInput, typeSelect, addBtn);
	}

	function arrayEditor (node, path) {
		const box = el("div", { class: "nested" });
		node.items.forEach((item, i) => {
			const itemPath = [...path, i];
			box.append(el("div", { class: "arr-item" },
				el("span", { class: "idx" }, `${i + 1}.`),
				el("div", { class: "val" }, valueEditor(item, itemPath, {})),
				el("button", { class: "icon", title: "Move up", disabled: i === 0, onclick: () => record({ op: "move", path, from: i, to: i - 1 }) }, "↑"),
				el("button", { class: "icon", title: "Move down", disabled: i === node.items.length - 1, onclick: () => record({ op: "move", path, from: i, to: i + 1 }) }, "↓"),
				el("button", { class: "icon danger", title: "Remove item", onclick: () => record({ op: "remove", path: itemPath }) }, "✕")
			));
		});
		const sample = node.items[0];
		const typeSelect = el("select", {}, ...["string", "number", "boolean", "object", "array", "code"].map((t) => el("option", { value: t }, t === "array" ? "list" : t)));
		if (sample) typeSelect.value = sample.kind === "null" ? "string" : sample.kind;
		box.append(el("div", { class: "adder" },
			typeSelect,
			el("button", { onclick: () => {
				const kind = typeSelect.value;
				const value = sample && sample.kind === kind ? blankLike(sample) : newValue(kind);
				record({ op: "append", path, value });
			} }, "Add item")
		));
		return box;
	}

	function valueEditor (node, path, hint) {
		const set = (value) => record({ op: "set", path, value });
		if (hint?.enum && ["string", "number", "boolean"].includes(node.kind)) {
			const options = [...hint.enum];
			if (!options.some((o) => o === node.value)) options.unshift(node.value);
			const select = el("select", { onchange: (e) => {
				const v = options[Number(e.target.value)];
				set(fromValue(v));
			} }, ...options.map((o, i) => el("option", { value: i, selected: o === node.value }, String(o))));
			return select;
		}
		switch (node.kind) {
			case "string":
				return el("input", { type: "text", value: node.value, onchange: (e) => set({ kind: "string", value: e.target.value }) });
			case "number":
				return el("input", { type: "number", step: "any", value: node.value, onchange: (e) => {
					if (e.target.value === "" || Number.isNaN(Number(e.target.value))) return;
					set({ kind: "number", value: Number(e.target.value) });
				} });
			case "boolean":
				return el("input", { type: "checkbox", checked: node.value, onchange: (e) => set({ kind: "boolean", value: e.target.checked }) });
			case "null":
				return el("input", { class: "code", value: "null", title: "Type a value (as JavaScript)", onchange: (e) => set({ kind: "code", code: e.target.value }) });
			case "code": {
				const multi = node.code.includes("\n");
				const attrs = { class: "code", title: "JavaScript expression", onchange: (e) => set({ kind: "code", code: e.target.value }) };
				return multi ? el("textarea", { ...attrs, rows: Math.min(12, node.code.split("\n").length) }, node.code) : el("input", { ...attrs, value: node.code });
			}
			case "array":
				return arrayEditor(node, path);
			case "object":
				return el("div", { class: "nested" }, objectEditor(node, path, {}, null, null));
			default:
				return el("span", { class: "muted" }, "?");
		}
	}

	function renderBackups () {
		const list = $("backups");
		if (!state?.backups?.length) {
			list.replaceChildren(el("li", { class: "muted" }, "No backups yet."));
			return;
		}
		list.replaceChildren(...state.backups.map((name) => el("li", {},
			el("span", {}, name),
			el("button", { onclick: async () => {
				if (!confirm(`Restore ${name}?`)) return;
				try {
					const result = await api("POST", "restore", { name });
					if (result.restarting) await waitForRestart();
					else await load();
				} catch (error) {
					showError(error.message);
				}
			} }, "Restore")
		)));
	}

	/* ---------------- actions ---------------- */

	$("save").addEventListener("click", async () => {
		$("save").disabled = true;
		try {
			const result = await api("POST", "apply", { ops });
			if (result.restarting) await waitForRestart();
			else await load();
		} catch (error) {
			showError(`Not saved: ${error.message}`);
		} finally {
			$("save").disabled = false;
		}
	});

	$("discard").addEventListener("click", () => {
		work = structuredClone(state.tree);
		ops = [];
		changed.clear();
		showError("");
		renderAll();
	});

	$("addModule").addEventListener("click", () => {
		const name = $("addModuleSelect").value;
		if (!name || !child(work, "modules")) return;
		record({ op: "append", path: ["modules"], value: { kind: "object", children: [{ key: "module", node: { kind: "string", value: name } }] } });
		openCards.add(`${name}#${child(work, "modules").items.length - 1}`);
		renderAll();
	});

	$("checkConfig").addEventListener("click", async () => {
		try {
			await api("POST", "validate", { text: $("configText").value });
			$("configStatus").textContent = "Looks good.";
		} catch (error) {
			$("configStatus").textContent = "";
			showError(error.message);
		}
	});

	$("saveConfig").addEventListener("click", async () => {
		if (ops.length && !confirm("You have unsaved changes on the Modules/General tabs; saving the file directly discards them. Continue?")) return;
		try {
			const result = await api("POST", "raw", { file: "config", text: $("configText").value });
			showError("");
			if (result.restarting) await waitForRestart();
			else await load();
		} catch (error) {
			showError(`Not saved: ${error.message}`);
		}
	});

	$("saveCss").addEventListener("click", async () => {
		try {
			await api("POST", "raw", { file: "css", text: $("cssText").value });
			$("cssStatus").textContent = "Saved and applied.";
			setTimeout(() => { $("cssStatus").textContent = ""; }, 3000);
			state.cssText = $("cssText").value;
			api("GET", "state").then((s) => { state.backups = s.backups; renderBackups(); }).catch(() => {});
		} catch (error) {
			showError(`Not saved: ${error.message}`);
		}
	});

	// Tab key inserts a tab in the code editors.
	for (const id of ["configText", "cssText"]) {
		$(id).addEventListener("keydown", (e) => {
			if (e.key !== "Tab") return;
			e.preventDefault();
			const t = e.target;
			const { selectionStart: s, selectionEnd: end } = t;
			t.value = `${t.value.slice(0, s)}\t${t.value.slice(end)}`;
			t.selectionStart = t.selectionEnd = s + 1;
		});
	}

	document.querySelectorAll(".tabs button").forEach((btn) => btn.addEventListener("click", () => {
		document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
		document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("hidden", t.id !== `tab-${btn.dataset.tab}`));
	}));

	window.addEventListener("beforeunload", (e) => {
		if (ops.length) e.preventDefault();
	});

	load().catch((error) => showError(`Can't reach the mirror: ${error.message}`));
})();
