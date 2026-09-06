import { describe, expect, it } from "vitest";
import {
  isAllowedDirectorEvent,
  isDirectorCaptureResult,
  parseDirectorMessage,
} from "./director-message";

describe("director iframe message validation", () => {
  it("accepts a valid ready message", () => {
    expect(
      parseDirectorMessage({
        protocol: "atelier-monoform",
        version: 1,
        source: "monoform",
        type: "ready",
      }),
    ).toMatchObject({ type: "ready" });
  });

  it("rejects an unknown protocol or version", () => {
    expect(
      parseDirectorMessage({
        protocol: "wrong",
        version: 1,
        source: "monoform",
        type: "ready",
      }),
    ).toBeNull();
    expect(
      parseDirectorMessage({
        protocol: "atelier-monoform",
        version: 2,
        source: "monoform",
        type: "ready",
      }),
    ).toBeNull();
  });

  it("validates a capture result without interpreting blob contents", () => {
    const result = {
      protocol: "atelier-monoform",
      version: 1,
      source: "monoform",
      type: "control.result",
      requestId: "request-1",
      payload: {
        shotId: "shot-1",
        frame: 0,
        pose: { blob: new Blob(["pose"]), width: 1024, height: 1024, mimeType: "image/png" },
        depth: { blob: new Blob(["depth"]), width: 1024, height: 1024, mimeType: "image/png" },
      },
    };
    expect(isDirectorCaptureResult(result)).toBe(true);
    expect(isDirectorCaptureResult({ ...result, requestId: 4 })).toBe(false);
  });

  it("requires the expected iframe origin and source window", () => {
    const iframeWindow = {} as Window;
    expect(
      isAllowedDirectorEvent(
        { origin: "http://localhost:3000", source: iframeWindow, data: {} } as MessageEvent,
        iframeWindow,
        "http://localhost:3000",
      ),
    ).toBe(true);
    expect(
      isAllowedDirectorEvent(
        { origin: "https://attacker.example", source: iframeWindow, data: {} } as MessageEvent,
        iframeWindow,
        "http://localhost:3000",
      ),
    ).toBe(false);
  });
});
