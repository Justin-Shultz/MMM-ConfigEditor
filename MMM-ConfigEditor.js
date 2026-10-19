/* MMM-ConfigEditor
 *
 * A settings page for MagicMirror at http://<mirror>:8080/MMM-ConfigEditor/
 * Needs no position; it shows nothing on the mirror itself.
 */
Module.register("MMM-ConfigEditor", {
	defaults: {
		// After saving config.js: "exit" restarts MagicMirror (pm2 or a kiosk loop brings it back),
		// "none" just saves, or give a shell command, e.g. "pm2 restart MagicMirror".
		restart: "exit"
	},

	start () {
		this.sendSocketNotification("CE_INIT", { restart: this.config.restart });
	},

	socketNotificationReceived (notification) {
		if (notification === "CE_CSS_UPDATED") {
			// Reload custom.css in place, no restart needed.
			document.querySelectorAll("link[rel=stylesheet]").forEach((link) => {
				if (/custom\.css/.test(link.href)) {
					const url = new URL(link.href);
					url.searchParams.set("v", Date.now());
					link.href = url.toString();
				}
			});
		}
	}
});
