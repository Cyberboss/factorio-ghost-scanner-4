import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

export default tseslint.config(
    { ignores: ["dist", "src/api/grab.js"] },
    {
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
            ecmaVersion: 2020,
            globals: globals.browser
        },
        plugins: {
            import: importPlugin
        },
        rules: {
            "import/order": [
                "error",
                {
                    "newlines-between": "always"
                }
            ],
            "import/no-relative-parent-imports": "error",
            "import/no-useless-path-segments": "error"
        }
    }
);
