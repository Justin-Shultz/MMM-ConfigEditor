/* MMM-ConfigEditor node helper
 *
 * Serves the editor page at /MMM-ConfigEditor/ and a small JSON API under
 * /MMM-ConfigEditor/api. config.js is never regenerated: edits are applied to the
 * source text (see lib/config-source.js), checked by loading the result in a separate
 * Node process, backed up, and only then written. custom.css saves apply live.
 */
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const NodeHelper = require("node_helper");
const Log = require("logger");
const source = require("./lib/config-source");

const POSITIONS = [
	"top_bar", "top_left", "top_center", "top_right", "upper_third", "middle_center", "lower_third",
	"bottom_left", "bottom_center", "bottom_right", "bottom_bar", "fullscreen_above", "fullscreen_below"
];
const MAX_BACKUPS = 30;

module.exports = NodeHelper.create({
	start () {
		this.root = global.root_path || path.resolve(__dirname, "..", "..");
		this.configFile = process.env.MM_CONFIG_FILE ? path.resolve(this.root, process.env.MM_CONFIG_FILE) : path.join(this.root, "config", "config.js");
		this.cssFile = path.resolve(this.root, global.config?.customCss || "config/custom.css");
		this.backupDir = path.join(path.dirname(this.configFile), "backups");
		this.options = { restart: "exit" };
		this.registerRoutes();
	},

	socketNotificationReceived (notification, payload) {
		if (notification === "CE_INIT") this.options = { ...this.options, ...(payload || {}) };
	},

	registerRoutes () {
		const app = this.expressApp;
		const base = `/${this.name}/api`;
		const json = express.json({ limit: "5mb" });

		const handle = (fn) => async (req, res) => {
			try {
				res.json((await fn(req)) ?? { ok: true });
			} catch (error) {
				const status = error.status || 400;
				if (status >= 500) Log.error(`[${this.name}] ${error.stack || error.message}`);
				res.status(status).json({ error: error.message });
			}
		};

		app.get(`${base}/state`, handle(() => this.state()));
		app.post(`${base}/apply`, json, handle((req) => this.apply(req.body?.ops || [], req.body?.restart !== false)));
		app.post(`${base}/validate`, json, handle((req) => this.validateText(req.body?.text ?? "").then(() => ({ ok: true }))));
		app.post(`${base}/raw`, json, handle((req) => this.saveRaw(req.body?.file, req.body?.text, req.body?.restart !== false)));
		app.post(`${base}/restore`, json, handle((req) => this.restore(req.body?.name)));
		app.post(`${base}/restart`, handle(() => this.restart(true)));
	},

	async state () {
		const configText = await fsp.readFile(this.configFile, "utf8");
		let tree = null;
		let parseError = null;
		try {
			tree = source.readTree(configText);
		} catch (error) {
			parseError = error.message;
		}
		const cssText = await fsp.readFile(this.cssFile, "utf8").catch(() => "");
		return {
			tree,
			parseError,
			configText,
			cssText,
			configPath: this.configFile,
			cssPath: this.cssFile,
			positions: POSITIONS,
			installed: await this.installedModules(),
			backups: await this.listBackups(),
			restart: this.options.restart
		};
	},

	/** Module folders that contain <name>/<name>.js, plus the default modules. */
	async installedModules () {
		const result = [];
		const scan = async (dir, urlBase, isDefault) => {
			const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
			for (const e of entries) {
				if (!e.isDirectory() || e.name.startsWith(".")) continue;
				if (fs.existsSync(path.join(dir, e.name, `${e.name}.js`))) {
					const hintsFile = path.join(dir, e.name, "config-editor.json");
					result.push({
						name: e.name,
						script: `${urlBase}/${e.name}/${e.name}.js`,
						isDefault,
						hints: fs.existsSync(hintsFile) ? JSON.parse(await fsp.readFile(hintsFile, "utf8").catch(() => "{}")) : null
					});
				}
			}
		};
		await scan(path.join(this.root, "defaultmodules"), "/defaultmodules", true);
		await scan(path.join(this.root, "modules", "default"), "/modules/default", true);
		await scan(path.join(this.root, "modules"), "/modules", false);
		return result.sort((a, b) => a.name.localeCompare(b.name));
	},

	async apply (ops, restart) {
		if (!Array.isArray(ops) || ops.length === 0) throw new Error("Nothing to save.");
		const current = await fsp.readFile(this.configFile, "utf8");
		const next = source.applyOps(current, ops);
		await this.validateText(next);
		await this.writeWithBackup(this.configFile, current, next);
		if (restart) this.restart();
		return { ok: true, restarting: restart && this.options.restart !== "none" };
	},

	async saveRaw (file, text, restart) {
		if (typeof text !== "string") throw new Error("No text received.");
		if (file === "css") {
			const current = await fsp.readFile(this.cssFile, "utf8").catch(() => "");
			const opens = (text.match(/{/g) || []).length;
			const closes = (text.match(/}/g) || []).length;
			if (opens !== closes) throw new Error(`custom.css has ${opens} "{" but ${closes} "}". Fix the braces before saving.`);
			await this.writeWithBackup(this.cssFile, current, text);
			this.sendSocketNotification("CE_CSS_UPDATED", {});
			return { ok: true, restarting: false };
		}
		if (file === "config") {
			const current = await fsp.readFile(this.configFile, "utf8");
			await this.validateText(text);
			await this.writeWithBackup(this.configFile, current, text);
			if (restart) this.restart();
			return { ok: true, restarting: restart && this.options.restart !== "none" };
		}
		throw new Error("Unknown file.");
	},

	async restore (name) {
		if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) throw new Error("Bad backup name.");
		const file = path.join(this.backupDir, name);
		const text = await fsp.readFile(file, "utf8");
		const target = name.startsWith("custom.css") ? "css" : "config";
		return this.saveRaw(target, text, true);
	},

	/** Loads the candidate config in a separate Node process: it must run and export modules[]. */
	async validateText (text) {
		try {
			source.parse(text);
		} catch (error) {
			throw new Error(`Syntax error: ${error.message}`);
		}
		const tmp = path.join(os.tmpdir(), `mm-config-check-${process.pid}-${Date.now()}.js`);
		await fsp.writeFile(tmp, text);
		const check = `
			const c = require(${JSON.stringify(tmp)});
			if (!c || typeof c !== "object") throw new Error("config.js doesn't export the config object (keep the module.exports line at the bottom).");
			if (!Array.isArray(c.modules)) throw new Error("config.modules must be a list.");
			c.modules.forEach((m, i) => { if (!m || typeof m.module !== "string") throw new Error("Module #" + (i + 1) + " has no module name."); });
		`;
		try {
			await new Promise((resolve, reject) => {
				// Use the system "node", not process.execPath (which is Electron when running as the mirror).
				execFile("node", ["-e", check], { timeout: 10000 }, (error, stdout, stderr) => {
					if (error) reject(new Error((stderr || error.message).split("\n").find((l) => /Error/.test(l)) || stderr || error.message));
					else resolve();
				});
			});
		} finally {
			fsp.rm(tmp, { force: true }).catch(() => {});
		}
	},

	async writeWithBackup (file, oldText, newText) {
		await fsp.mkdir(this.backupDir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");
		await fsp.writeFile(path.join(this.backupDir, `${path.basename(file)}.${stamp}`), oldText);
		const temp = `${file}.saving`;
		await fsp.writeFile(temp, newText);
		await fsp.rename(temp, file);
		await this.pruneBackups();
	},

	async listBackups () {
		const names = await fsp.readdir(this.backupDir).catch(() => []);
		return names.filter((n) => /^(config\.js|custom\.css)\./.test(n)).sort().reverse();
	},

	async pruneBackups () {
		for (const prefix of ["config.js.", "custom.css."]) {
			const names = (await this.listBackups()).filter((n) => n.startsWith(prefix));
			for (const old of names.slice(MAX_BACKUPS)) await fsp.rm(path.join(this.backupDir, old), { force: true });
		}
	},

	/**
	 * restart option: "exit" (default) quits MagicMirror so pm2 or a kiosk loop starts it
	 * again; "none" does nothing; any other string is run as a shell command.
	 */
	restart (force = false) {
		const mode = this.options.restart;
		if (mode === "none" && !force) return { ok: true, restarting: false };
		setTimeout(() => {
			if (mode === "exit" || mode === "none") {
				Log.info(`[${this.name}] Restarting MagicMirror after a config change`);
				process.exit(0);
			} else {
				require("node:child_process").exec(mode, (error) => error && Log.error(`[${this.name}] restart command failed: ${error.message}`));
			}
		}, 1200);
		return { ok: true, restarting: true };
	}
});
