data.extend([
    {
        type: "int-setting",
        name: "ghost-scanner-scan-areas-per-tick",
        order: "aa",
        setting_type: "runtime-global",
        default_value: 5,
        minimum_value: 1,
        maximum_value: 500
    },
    {
        type: "int-setting",
        name: "ghost-scanner-update-interval",
        order: "ab",
        setting_type: "runtime-global",
        default_value: 180,
        minimum_value: 1,
        maximum_value: 216000 // 1h
    },
    {
        type: "int-setting",
        name: "ghost-scanner-area-scan-delay",
        order: "aba",
        setting_type: "runtime-global",
        default_value: 5,
        minimum_value: 1,
        maximum_value: 216000 // 1h
    },
    {
        type: "int-setting",
        name: "ghost-scanner-max-results",
        order: "ac",
        setting_type: "runtime-global",
        default_value: 1000,
        minimum_value: 0
    },
    {
        type: "bool-setting",
        name: "ghost-scanner-show-hidden",
        order: "ad",
        setting_type: "runtime-global",
        default_value: false
    },
    {
        type: "bool-setting",
        name: "ghost-scanner-negative-output",
        order: "ba",
        setting_type: "runtime-global",
        default_value: false
    },
    {
        type: "bool-setting",
        name: "ghost-scanner-round2stack",
        order: "bb",
        setting_type: "runtime-global",
        default_value: false
    }
]);
