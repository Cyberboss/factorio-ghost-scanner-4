-- Selects which scenario test/run.sh is asking for. A mod may only write its own
-- settings, so this lives here rather than on Ghost Scanner 4.
data:extend({
    {
        type = "string-setting",
        name = "seance-test-scenario",
        setting_type = "runtime-global",
        default_value = "signals",
        allowed_values = {"signals", "groups", "topology", "lifecycle"}
    }
})
