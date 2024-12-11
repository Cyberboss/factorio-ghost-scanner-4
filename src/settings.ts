import {
    AreasPerTickSetting,
    MaxResultsSetting,
    NegativeOutputSetting,
    RoundToStackSetting,
    ScanAreasDelaySetting,
    ShowHiddenSetting,
    UpdateIntervalSetting
} from "./setting_names";

data.extend([
    {
        type: "int-setting",
        name: AreasPerTickSetting,
        order: "aa",
        setting_type: "runtime-global",
        default_value: 5,
        minimum_value: 1,
        maximum_value: 500
    },
    {
        type: "int-setting",
        name: UpdateIntervalSetting,
        order: "ab",
        setting_type: "runtime-global",
        default_value: 180,
        minimum_value: 1,
        maximum_value: 216000 // 1h
    },
    {
        type: "int-setting",
        name: ScanAreasDelaySetting,
        order: "aba",
        setting_type: "runtime-global",
        default_value: 5,
        minimum_value: 1,
        maximum_value: 216000 // 1h
    },
    {
        type: "int-setting",
        name: MaxResultsSetting,
        order: "ac",
        setting_type: "runtime-global",
        default_value: 1000,
        minimum_value: 0
    },
    {
        type: "bool-setting",
        name: ShowHiddenSetting,
        order: "ad",
        setting_type: "runtime-global",
        default_value: false
    },
    {
        type: "bool-setting",
        name: NegativeOutputSetting,
        order: "ba",
        setting_type: "runtime-global",
        default_value: false
    },
    {
        type: "bool-setting",
        name: RoundToStackSetting,
        order: "bb",
        setting_type: "runtime-global",
        default_value: false
    }
]);
