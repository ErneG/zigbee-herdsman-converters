import {beforeAll, beforeEach, describe, expect, test, vi} from "vitest";
import {findByDevice} from "../src";
import type {Definition, KeyValue, Zh} from "../src/lib/types";
import {mockDevice} from "./utils";

const HEAT_SETPOINT = 0x0020;
const COOL_SETPOINT = 0x0021;

describe("hisense-ir-ac", () => {
    let definition: Definition;
    let device: Zh.Device;
    let endpoint: Zh.Endpoint;
    let write: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
        device = mockDevice({modelID: "hisense-ir-ac", endpoints: [{ID: 1, inputClusters: ["genBasic", "hvacThermostat"]}]});
        endpoint = device.endpoints[0];
        definition = await findByDevice(device);
        await definition.onEvent?.({type: "start", data: {device}} as never);
    });

    beforeEach(() => {
        write = vi.spyOn(endpoint, "write").mockResolvedValue(undefined) as never;
    });

    const getTz = (key: string) => {
        const converter = definition.toZigbee.find((c) => c.key.includes(key));
        expect(converter).toBeDefined();
        return converter;
    };

    const getFz = (attribute: string) => {
        const converter = definition.fromZigbee.find((c) => c.cluster === "hisenseAc" && c.convert.toString().includes(attribute));
        expect(converter).toBeDefined();
        return converter;
    };

    const setSetpoint = async (message: KeyValue, state: KeyValue = {}) => {
        write.mockClear();
        const [key] = Object.keys(message).filter((k) => k.endsWith("setpoint"));
        await getTz(key)?.convertSet?.(endpoint, key, message[key], {device, message, state} as never);
        const [cluster, payload] = write.mock.calls[0];
        expect(cluster).toBe("hisenseAc");
        return payload;
    };

    test.each([
        ["heat", "heatSetpoint"],
        ["off", "heatSetpoint"],
        ["cool", "coolSetpoint"],
        ["dry", "coolSetpoint"],
        ["fan_only", "coolSetpoint"],
    ])("setpoint in %s mode writes %s", async (mode, attribute) => {
        const payload = await setSetpoint({current_heating_setpoint: 21}, {system_mode: mode});
        expect(payload).toStrictEqual({[attribute]: 2100});
    });

    test("setpoint attributes have IDs 0x0020 and 0x0021 on cluster 0xFC20", () => {
        const cluster = device.customClusters.hisenseAc;
        expect(cluster.ID).toBe(0xfc20);
        expect(cluster.attributes.heatSetpoint.ID).toBe(HEAT_SETPOINT);
        expect(cluster.attributes.coolSetpoint.ID).toBe(COOL_SETPOINT);
    });

    test("the new system_mode in the same message decides the setpoint attribute", async () => {
        expect(await setSetpoint({current_heating_setpoint: 22, system_mode: "cool"}, {system_mode: "heat"})).toStrictEqual({coolSetpoint: 2200});
        expect(await setSetpoint({current_heating_setpoint: 22, system_mode: "heat"}, {system_mode: "cool"})).toStrictEqual({heatSetpoint: 2200});
    });

    test("fromZigbee maps the six fan speeds to fan_mode", () => {
        const converter = getFz("fanSpeed");
        const modes = ["auto", "low", "mid_low", "medium", "mid_high", "high"];
        for (const [value, mode] of modes.entries()) {
            const result = converter?.convert(definition, {data: {fanSpeed: value}, device, endpoint} as never, vi.fn(), {}, {
                device,
                state: {},
            } as never);
            expect(result).toStrictEqual({fan_mode: mode});
        }
    });

    test.each(["turbo", "economy", "sleep", "vswing", "hswing", "display"])("fromZigbee maps %s to ON/OFF", (name) => {
        const convert = (value: number) => {
            const msg = {data: {[name]: value}, device, endpoint, type: "attributeReport", cluster: "hisenseAc"};
            return Object.assign(
                {},
                ...definition.fromZigbee
                    .filter((c) => c.cluster === "hisenseAc")
                    .map((c) => c.convert(definition, msg as never, vi.fn(), {}, {device, state: {}} as never)),
            );
        };
        expect(convert(1)).toStrictEqual({[name]: "ON"});
        expect(convert(0)).toStrictEqual({[name]: "OFF"});
    });

    test.each([
        ["mid_low", 2],
        ["mid_high", 4],
    ])("fan_mode %s writes enum value %i", async (mode, value) => {
        write.mockClear();
        const result = await getTz("fan_mode")?.convertSet?.(endpoint, "fan_mode", mode, {device, message: {}, state: {}} as never);
        expect(write).toHaveBeenCalledWith("hisenseAc", {fanSpeed: value});
        expect(result).toStrictEqual({state: {fan_mode: mode}});
    });
});
