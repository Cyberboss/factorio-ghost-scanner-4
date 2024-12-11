import {
    MaxResultsSetting,
    NegativeOutputSetting,
    RoundToStackSetting,
    ScanAreasDelaySetting,
    ShowHiddenSetting,
    UpdateIntervalSetting
} from "./setting_names";

const ScannerName = "ghost-scanner";

const ScanAreasPerTick = settings.global[UpdateIntervalSetting].value as number;
const ScanAreasDelay = settings.global[ScanAreasDelaySetting].value as number;
let maxResults: number | null = settings.global[MaxResultsSetting].value as number;

if (maxResults == 0) {
    maxResults = null;
}

const ShowHidden = settings.global[ShowHiddenSetting].value as boolean;
const InvertSign = settings.global[NegativeOutputSetting].value as boolean;
const RoundToStack = settings.global[RoundToStackSetting].value as boolean;

script.on_event(defines.events.on_runtime_mod_setting_changed, event => {
    if (event.setting == "") {
    }
});
