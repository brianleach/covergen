import { beforeEach, describe, expect, it, vi } from "vitest";

const { pinoMock } = vi.hoisted(() => {
  const pinoMock = Object.assign(vi.fn(), {
    destination: vi.fn((fd: number) => ({ fd })),
  });
  return { pinoMock };
});

vi.mock("pino", () => ({ default: pinoMock }));

import { createLogger } from "./logger.js";

describe("createLogger with pretty output", () => {
  beforeEach(() => {
    pinoMock.mockReset();
  });

  it("builds a pino-pretty transport writing to stderr", () => {
    pinoMock.mockImplementation((opts: unknown, dest?: unknown) => ({ opts, dest }));

    const logger = createLogger({ pretty: true, level: "DEBUG" });

    expect(logger).toEqual({
      opts: {
        level: "debug",
        transport: {
          target: "pino-pretty",
          options: { destination: 2, colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      },
      dest: undefined,
    });
  });

  it("falls back to JSON on stderr when the pretty transport cannot be created", () => {
    pinoMock
      .mockImplementationOnce(() => {
        throw new Error("unable to determine transport target for pino-pretty");
      })
      .mockImplementationOnce((opts: unknown, dest?: unknown) => ({ opts, dest }));

    const logger = createLogger({ pretty: true, level: "warn" });

    expect(logger).toEqual({ opts: { level: "warn" }, dest: { fd: 2 } });
  });
});
