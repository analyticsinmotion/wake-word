import { describe, expect, it } from "vitest";
import { resolveHandoff, resolveRoutes } from "../../src/wakeWordCore";
import { DEFAULT_ROUTES } from "../../src/extension";
import type { WakePhrase } from "../../src/speechEngineInterface";

const claude: WakePhrase = {
  label: "Claude",
  phrase: "hey claude",
  command: "claude-vscode.focus",
};

describe("resolveHandoff", () => {
  it("returns manual for 'manual'", () => {
    expect(resolveHandoff("manual")).toBe("manual");
  });

  it("returns timer for 'timer'", () => {
    expect(resolveHandoff("timer")).toBe("timer");
  });

  it("defaults to timer when the field is absent", () => {
    expect(resolveHandoff(undefined)).toBe("timer");
    expect(resolveHandoff(null)).toBe("timer");
  });

  it("defaults to timer for an unrecognised value", () => {
    expect(resolveHandoff("later")).toBe("timer");
    expect(resolveHandoff("")).toBe("timer");
  });

  it("is case sensitive, so a case variant falls back to timer", () => {
    // settings.json is not validated against the schema. An unrecognised
    // spelling must not silently change the resume behaviour.
    expect(resolveHandoff("Manual")).toBe("timer");
    expect(resolveHandoff("MANUAL")).toBe("timer");
  });

  it("defaults to timer for wrong-typed values", () => {
    expect(resolveHandoff(true)).toBe("timer");
    expect(resolveHandoff(1)).toBe("timer");
    expect(resolveHandoff({})).toBe("timer");
  });
});

describe("route handoff parsing", () => {
  it("keeps handoff: manual on a user route", () => {
    const routes = resolveRoutes([{ ...claude, handoff: "manual" }], DEFAULT_ROUTES);
    expect(routes).toHaveLength(1);
    expect(routes[0].handoff).toBe("manual");
    expect(resolveHandoff(routes[0].handoff)).toBe("manual");
  });

  it("keeps handoff: timer on a user route", () => {
    const routes = resolveRoutes([{ ...claude, handoff: "timer" }], DEFAULT_ROUTES);
    expect(resolveHandoff(routes[0].handoff)).toBe("timer");
  });

  it("resolves a route with no handoff field to timer", () => {
    const routes = resolveRoutes([claude], DEFAULT_ROUTES);
    expect(routes[0].handoff).toBeUndefined();
    expect(resolveHandoff(routes[0].handoff)).toBe("timer");
  });

  it("resolves a route with an invalid handoff value to timer without rejecting the route", () => {
    const bad = { ...claude, handoff: "sometimes" } as unknown as WakePhrase;
    const routes = resolveRoutes([bad], DEFAULT_ROUTES);
    expect(routes).toHaveLength(1);
    expect(resolveHandoff(routes[0].handoff)).toBe("timer");
  });
});

describe("DEFAULT_ROUTES handoff", () => {
  it("uses manual handoff for the Claude route", () => {
    const route = DEFAULT_ROUTES.find((r) => r.label === "Claude");
    expect(route).toBeDefined();
    expect(resolveHandoff(route?.handoff)).toBe("manual");
  });

  it("uses timer handoff for every other route", () => {
    for (const route of DEFAULT_ROUTES) {
      if (route.label !== "Claude") {
        expect(resolveHandoff(route.handoff)).toBe("timer");
      }
    }
  });
});
