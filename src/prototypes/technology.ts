import type { Modifier } from "factorio:prototype";

// If the chain returns undefined, it safely falls back to []
const effects = data.raw.technology["advanced-combinators"]?.effects ?? [];

table.insert(effects as Modifier[], {
    type: "unlock-recipe",
    recipe: "ghost-scanner"
});
