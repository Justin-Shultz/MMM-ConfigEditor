import { defineConfig } from "eslint/config";
import globals from "globals";
import js from "@eslint/js";

export default defineConfig([
	{
		files: ["**/*.js"],
		plugins: { js },
		extends: ["js/recommended"],
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
				Log: "readonly",
				Module: "readonly",
				config: "readonly"
			},
			sourceType: "commonjs"
		}
	},
	{
		files: ["**/*.mjs"],
		languageOptions: {
			ecmaVersion: "latest",
			globals: {
				...globals.node
			},
			sourceType: "module"
		}
	}
]);
