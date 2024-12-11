import { Modifier } from "factorio:prototype";

const effects = data.raw["technology"]["advanced-combinators"]!.effects!;

table.insert(effects as Modifier[], {
    type: "unlock-recipe",
    recipe: "ghost-scanner"
});
