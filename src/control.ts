import { ItemStackDefinition } from "factorio:runtime";
import {
    AreasPerTickSetting,
    MaxResultsSetting,
    NegativeOutputSetting,
    RoundToStackSetting,
    ScanAreasDelaySetting,
    ShowHiddenSetting,
    UpdateIntervalSetting
} from "./setting_names";

interface Storage {
    lookupItemsToPlaceThis: LuaMap<string, ReadonlyArray<ItemStackDefinition>>;
}

declare const storage: Storage;

const ScannerName = "ghost-scanner";

let scanAreasPerTick = settings.global[AreasPerTickSetting].value as number;
let updateInteval = settings.global[UpdateIntervalSetting].value as number;
let scanAreasDelay = settings.global[ScanAreasDelaySetting].value as number;
let maxResults: number | null = settings.global[MaxResultsSetting].value as number;

if (maxResults == 0) {
    maxResults = null;
}

let showHidden = settings.global[ShowHiddenSetting].value as boolean;
let invertSign = settings.global[NegativeOutputSetting].value as boolean;
let roundToStack = settings.global[RoundToStackSetting].value as boolean;

const UpdateEventHandlers = () => {};

script.on_event(defines.events.on_runtime_mod_setting_changed, event => {
    let updateEventHandlers = false;

    switch (event.setting) {
        case UpdateIntervalSetting: {
            updateInteval = settings.global[UpdateIntervalSetting].value as number;
            updateEventHandlers = true;
            break;
        }
        case AreasPerTickSetting: {
            scanAreasPerTick = settings.global[AreasPerTickSetting].value as number;
            updateEventHandlers = true;
            break;
        }
        case MaxResultsSetting: {
            maxResults = settings.global[MaxResultsSetting].value as number;

            if (maxResults == 0) {
                maxResults = null;
            }

            break;
        }
        case ShowHiddenSetting: {
            showHidden = settings.global[ShowHiddenSetting].value as boolean;
            storage.lookupItemsToPlaceThis = new LuaMap();
            break;
        }
    }

    if (updateEventHandlers) {
        UpdateEventHandlers();
    }
});
