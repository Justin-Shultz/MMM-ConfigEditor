/* Reads and edits MagicMirror's config.js as *source text*.
 *
 * The file is parsed with acorn only to learn where each value sits. Edits replace,
 * insert or delete just those character ranges, so everything else in the file —
 * comments, formatting, functions, settings the editor doesn't understand — is left
 * exactly as it was. After each edit the text is parsed again, so later edits always
 * see fresh positions.
 */
const acorn = require("acorn");

const PARSE_OPTIONS = { ecmaVersion: "latest", sourceType: "script", allowHashBang: true, allowReturnOutsideFunction: true };

/* ---------------- parsing ---------------- */

function parse (source) {
	return acorn.parse(source, PARSE_OPTIONS);
}

/** Finds the object literal assigned to `config` (let/const/var config = {...} or config = {...}). */
function findConfigObject (ast) {
	let found = null;
	const visit = (node) => {
		if (!node || typeof node !== "object" || found) return;
		if (node.type === "VariableDeclarator" && node.id?.name === "config" && node.init?.type === "ObjectExpression") {
			found = node.init;
			return;
		}
		if (node.type === "AssignmentExpression" && node.left?.name === "config" && node.right?.type === "ObjectExpression") {
			found = node.right;
			return;
		}
		for (const key of Object.keys(node)) {
			const child = node[key];
			if (Array.isArray(child)) child.forEach(visit);
			else if (child && typeof child.type === "string") visit(child);
		}
	};
	visit(ast);
	if (!found) throw new Error("Couldn't find `let config = { ... }` in config.js.");
	return found;
}

function keyName (prop) {
	if (prop.type !== "Property" || prop.computed) return null;
	if (prop.key.type === "Identifier") return prop.key.name;
	if (prop.key.type === "Literal") return String(prop.key.value);
	return null;
}

/**
 * Turns an AST node into an editable tree:
 *   { kind: "string"|"number"|"boolean"|"null"|"object"|"array"|"code", value?, children?, items?, code? }
 * Anything that isn't plain data (functions, math like 5 * 60 * 1000, variables) becomes
 * kind "code": shown and edited as its original source text.
 */
function toTree (node, source) {
	const code = source.slice(node.start, node.end);
	switch (node.type) {
		case "Literal":
			if (node.regex) return { kind: "code", code };
			if (node.value === null) return { kind: "null" };
			if (typeof node.value === "string") return { kind: "string", value: node.value };
			if (typeof node.value === "number") return { kind: "number", value: node.value };
			if (typeof node.value === "boolean") return { kind: "boolean", value: node.value };
			return { kind: "code", code };
		case "TemplateLiteral":
			if (node.expressions.length === 0) return { kind: "string", value: node.quasis.map((q) => q.value.cooked).join("") };
			return { kind: "code", code };
		case "UnaryExpression":
			if (node.operator === "-" && node.argument.type === "Literal" && typeof node.argument.value === "number") {
				return { kind: "number", value: -node.argument.value };
			}
			return { kind: "code", code };
		case "ObjectExpression": {
			const children = [];
			for (const prop of node.properties) {
				const key = keyName(prop);
				if (key === null || prop.kind !== "init" || prop.method) {
					children.push({ key: null, node: { kind: "code", code: source.slice(prop.start, prop.end) }, opaque: true });
				} else {
					children.push({ key, node: toTree(prop.value, source) });
				}
			}
			return { kind: "object", children };
		}
		case "ArrayExpression":
			if (node.elements.some((e) => e === null || e.type === "SpreadElement")) return { kind: "code", code };
			return { kind: "array", items: node.elements.map((e) => toTree(e, source)) };
		default:
			return { kind: "code", code };
	}
}

/** The editable view of the whole config, as sent to the browser. */
function readTree (source) {
	const obj = findConfigObject(parse(source));
	return toTree(obj, source);
}

/* ---------------- locating nodes by path ---------------- */

// A path is a list of steps: strings are object keys, numbers are array indexes.
function locate (source, path) {
	let node = findConfigObject(parse(source));
	for (const step of path) {
		if (typeof step === "number") {
			if (node.type !== "ArrayExpression" || !node.elements[step]) throw new Error(`No item ${step} at ${describe(path)}`);
			node = node.elements[step];
		} else {
			if (node.type !== "ObjectExpression") throw new Error(`Not an object at ${describe(path)}`);
			const prop = node.properties.find((p) => keyName(p) === step);
			if (!prop) throw new Error(`No setting "${step}" at ${describe(path)}`);
			node = prop.value;
		}
	}
	return node;
}

function locateProperty (source, path) {
	const parent = locate(source, path.slice(0, -1));
	const key = path[path.length - 1];
	if (typeof key === "number") {
		if (parent.type !== "ArrayExpression") throw new Error(`Not a list at ${describe(path)}`);
		return { parent, member: parent.elements[key], index: key, list: parent.elements };
	}
	const index = parent.properties.findIndex((p) => keyName(p) === key);
	return { parent, member: parent.properties[index], index, list: parent.properties };
}

function describe (path) {
	return path.map((s) => (typeof s === "number" ? `[${s}]` : `.${s}`)).join("") || "(root)";
}

/* ---------------- generating source ---------------- */

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function indentOf (source, pos) {
	const lineStart = source.lastIndexOf("\n", pos - 1) + 1;
	return /^[ \t]*/.exec(source.slice(lineStart))[0];
}

function indentUnit (source) {
	// Majority vote over code lines (ignores the " * " lines inside block comments).
	let tabs = 0, two = 0, four = 0;
	for (const line of source.split("\n")) {
		if (/^\t+\S/.test(line)) tabs++;
		else if (/^ {4}(?! *\*)\S/.test(line) || /^ {4}( {4})*\S/.test(line) && !/^ +\*/.test(line)) four++;
		else if (/^ {2}\S/.test(line) && !/^ +\*/.test(line)) two++;
	}
	if (tabs >= two && tabs >= four) return "\t";
	return four >= two ? "    " : "  ";
}

function quoteString (value, source) {
	const quote = source.includes("'") && !source.includes("\"") ? "'" : "\"";
	const body = JSON.stringify(value).slice(1, -1);
	return quote === "\"" ? `"${body}"` : `'${body.replace(/\\"/g, "\"").replace(/'/g, "\\'")}'`;
}

/** Renders an editable tree value as JavaScript source. */
function generate (value, source, indent) {
	const unit = indentUnit(source);
	switch (value.kind) {
		case "string": return quoteString(value.value ?? "", source);
		case "number": {
			const n = Number(value.value);
			if (!Number.isFinite(n)) throw new Error(`"${value.value}" isn't a number.`);
			return String(n);
		}
		case "boolean": return value.value ? "true" : "false";
		case "null": return "null";
		case "code": {
			const code = String(value.code ?? "").trim();
			if (!code) throw new Error("A code value can't be empty.");
			try {
				acorn.parseExpressionAt(`(${code})`, 0, PARSE_OPTIONS);
			} catch (error) {
				throw new Error(`Not valid JavaScript: ${code} (${error.message})`);
			}
			return code;
		}
		case "array": {
			const items = value.items || [];
			if (items.length === 0) return "[]";
			const simple = items.every((i) => ["string", "number", "boolean", "null"].includes(i.kind));
			const parts = items.map((i) => generate(i, source, indent + unit));
			if (simple && parts.join(", ").length < 70) return `[${parts.join(", ")}]`;
			return `[\n${parts.map((p) => indent + unit + p).join(",\n")}\n${indent}]`;
		}
		case "object": {
			const children = (value.children || []).filter((c) => !c.opaque);
			if (children.length === 0) return "{}";
			const lines = children.map((c) => `${indent + unit}${IDENT.test(c.key) ? c.key : quoteString(c.key, source)}: ${generate(c.node, source, indent + unit)}`);
			return `{\n${lines.join(",\n")}\n${indent}}`;
		}
		default:
			throw new Error(`Unknown value type "${value.kind}".`);
	}
}

/* ---------------- edits ---------------- */

function splice (source, start, end, text) {
	return source.slice(0, start) + text + source.slice(end);
}

/** Replace the value at `path`. */
function setValue (source, path, value) {
	if (path.length === 0) throw new Error("Can't replace the whole config.");
	const node = locate(source, path);
	return splice(source, node.start, node.end, generate(value, source, indentOf(source, node.start)));
}

/** Add `key: value` to the object at `path`. */
function addProperty (source, path, key, value) {
	const obj = locate(source, path);
	if (obj.type !== "ObjectExpression") throw new Error(`Not an object at ${describe(path)}`);
	if (!key || typeof key !== "string") throw new Error("A setting needs a name.");
	if (obj.properties.some((p) => keyName(p) === key)) throw new Error(`"${key}" is already set here.`);
	const keyText = IDENT.test(key) ? key : quoteString(key, source);
	return insertMember(source, obj, obj.properties, `${keyText}: `, value);
}

/** Append `value` to the array at `path` (or insert at `index`). */
function addItem (source, path, value, index = null) {
	const arr = locate(source, path);
	if (arr.type !== "ArrayExpression") throw new Error(`Not a list at ${describe(path)}`);
	if (index !== null && index < arr.elements.length) {
		const before = arr.elements[index];
		const indent = indentOf(source, before.start);
		const multiline = source.slice(arr.start, arr.end).includes("\n");
		const text = generate(value, source, indent) + (multiline ? `,\n${indent}` : ", ");
		return splice(source, before.start, before.start, text);
	}
	return insertMember(source, arr, arr.elements, "", value);
}

/** Position of the next non-whitespace, non-comment character at or after `pos`. */
function skipTrivia (source, pos, limit) {
	let i = pos;
	while (i < limit) {
		if (/\s/.test(source[i])) i++;
		else if (source.startsWith("//", i)) i = source.indexOf("\n", i) === -1 ? limit : source.indexOf("\n", i);
		else if (source.startsWith("/*", i)) i = source.indexOf("*/", i) + 2;
		else break;
	}
	return i;
}

function insertMember (source, container, members, prefix, value) {
	const unit = indentUnit(source);
	const closeIndent = indentOf(source, container.end - 1);
	if (members.length === 0) {
		const inner = closeIndent + unit;
		const text = `\n${inner}${prefix}${generate(value, source, inner)}\n${closeIndent}`;
		return splice(source, container.start + 1, container.end - 1, text);
	}
	const last = members[members.length - 1];
	const multiline = source.slice(container.start, container.end).includes("\n");
	const indent = multiline ? indentOf(source, last.start) : "";
	const sep = multiline ? `\n${indent}` : " ";
	const item = `${prefix}${generate(value, source, indent)}`;
	const next = skipTrivia(source, last.end, container.end - 1);
	if (source[next] === ",") {
		// Trailing-comma style: add after that comma (and after a same-line comment) and keep the style.
		let at = next + 1;
		const rest = /^[ \t]*\/\/[^\n]*/.exec(source.slice(at));
		if (rest && multiline) at += rest[0].length;
		return splice(source, at, at, `${sep}${item},`);
	}
	// No trailing comma: put the comma right after the last member; a same-line comment stays with it.
	let at = last.end;
	const rest = /^[ \t]*\/\/[^\n]*/.exec(source.slice(at));
	if (rest && multiline) return splice(source, at, at + rest[0].length, `,${rest[0]}${sep}${item}`);
	return splice(source, at, at, `,${sep}${item}`);
}

/** Remove the property or array item at `path`. */
function remove (source, path) {
	if (path.length === 0) throw new Error("Can't remove the whole config.");
	const { parent, member, index, list } = locateProperty(source, path);
	if (!member) throw new Error(`Nothing at ${describe(path)}`);

	let start = member.start;
	let end = member.end;
	if (list.length === 1) {
		start = parent.start + 1;
		end = parent.end - 1;
		return splice(source, start, end, "");
	}
	if (index < list.length - 1) {
		// Remove the member, its comma and a same-line comment; comments above the next
		// member belong to that member and stay.
		const comma = skipTrivia(source, member.end, list[index + 1].start);
		end = source[comma] === "," ? comma + 1 : member.end;
		const tail = /^[ \t]*(\/\/[^\n]*)?\n?/.exec(source.slice(end));
		end += tail[0].length;
		// If the member started its own line, take that line's indentation too.
		const lineStart = source.lastIndexOf("\n", start - 1) + 1;
		if (/^[ \t]*$/.test(source.slice(lineStart, start)) && tail[0].endsWith("\n")) start = lineStart;
		if (end > list[index + 1].start) end = list[index + 1].start;
	} else {
		// Last member: remove from the end of the previous one (its comma goes too).
		start = list[index - 1].end;
		const next = skipTrivia(source, member.end, parent.end - 1);
		if (source[next] === ",") {
			// Keep a trailing comma on what becomes the new last member.
			start = skipTrivia(source, list[index - 1].end, member.start) + 1;
			end = next + 1;
		}
	}
	return splice(source, start, end, "");
}

/** Move array item from `from` to `to` within the array at `path`. */
function moveItem (source, path, from, to) {
	const arr = locate(source, path);
	if (arr.type !== "ArrayExpression") throw new Error(`Not a list at ${describe(path)}`);
	const n = arr.elements.length;
	if (from < 0 || from >= n || to < 0 || to >= n || from === to) return source;
	const text = source.slice(arr.elements[from].start, arr.elements[from].end);
	// Re-insert the original source text untouched (keeps comments/formatting inside the item).
	let next = remove(source, [...path, from]);
	const arr2 = locate(next, path);
	if (to >= arr2.elements.length) {
		return insertMember(next, arr2, arr2.elements, "", { kind: "code", code: text });
	}
	const before = arr2.elements[to];
	const indent = indentOf(next, before.start);
	const multiline = next.slice(arr2.start, arr2.end).includes("\n");
	return splice(next, before.start, before.start, text + (multiline ? `,\n${indent}` : ", "));
}

/**
 * Applies a list of operations in order:
 *   { op: "set", path, value } | { op: "add", path, key, value } | { op: "append", path, value, index? }
 *   { op: "remove", path } | { op: "move", path, from, to }
 */
function applyOps (source, ops) {
	let text = source;
	for (const op of ops) {
		switch (op.op) {
			case "set": text = setValue(text, op.path, op.value); break;
			case "add": text = addProperty(text, op.path, op.key, op.value); break;
			case "append": text = addItem(text, op.path, op.value, op.index ?? null); break;
			case "remove": text = remove(text, op.path); break;
			case "move": text = moveItem(text, op.path, op.from, op.to); break;
			default: throw new Error(`Unknown operation "${op.op}"`);
		}
		parse(text); // fail fast if an edit produced invalid code
	}
	return text;
}

module.exports = { readTree, applyOps, parse, findConfigObject, generate };
